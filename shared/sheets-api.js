/**
 * SheetsApiAdapter - Google Sheets 및 로컬 Mock 연동 어댑터 (v3.0 — 개별 사용자 인증 및 POST 본문 통신)
 *
 * [보안 및 성능 원칙]
 * 1. URL 파라미터 인증정보/바코드 노출 금지:
 *    - 단건 바코드 조회(lookup)를 포함한 모든 데이터 요청은 POST 본문(JSON)으로 전송합니다.
 *    - 설정 파일(config.json)이나 소스코드에 공통 인증키를 하드코딩하지 않습니다.
 * 2. 개별 사용자 신원 토큰(idToken / sessionToken) 기반 통신:
 *    - 런타임 세션(메모리/sessionStorage)의 개별 사용자 토큰만 전송하며, 타임스탬프(Replay 방어)를 포함합니다.
 * 3. 실제 Google Apps Script HTTP 200 JSON 응답 규격 처리:
 *    - Apps Script ContentService는 오류 시에도 HTTP 200과 함께 { ok: false, status: "error", code: "..." }를 반환하므로,
 *      HTTP 상태코드와 JSON 본문의 ok/status/code 필드를 모두 엄격히 검사합니다.
 */
class SheetsApiAdapter {
  constructor(config = {}) {
    this.config = config;
    this.currentVersion = null;
    this.authContext = {
      idToken: null,
      sessionToken: null
    };
  }

  /**
   * 런타임 사용자 인증 토큰 설정 (메모리 보관, 파일 하드코딩 금지)
   * @param {{ idToken?: string, sessionToken?: string }} tokens
   */
  setUserTokens(tokens = {}) {
    this.authContext.idToken = tokens.idToken || null;
    this.authContext.sessionToken = tokens.sessionToken || null;
  }

  /**
   * 현재 설정된 사용자 인증 토큰 조회 (런타임 메모리 또는 sessionStorage)
   */
  getAuthPayload() {
    let idToken = this.authContext.idToken;
    let sessionToken = this.authContext.sessionToken;

    if (!idToken && !sessionToken && typeof sessionStorage !== 'undefined') {
      idToken = sessionStorage.getItem('PROMO_USER_ID_TOKEN') || null;
      sessionToken = sessionStorage.getItem('PROMO_USER_SESSION_TOKEN') || null;
    }

    const auth = {};
    if (idToken) auth.idToken = idToken;
    if (sessionToken) auth.sessionToken = sessionToken;
    return auth;
  }

  /**
   * 단건 바코드 프로모션 조회 (POST 본문 전송, 실제 통신시간 측정)
   * @param {string} barcode
   * @param {{ idToken?: string, sessionToken?: string }} [overrideAuth]
   * @returns {Promise<Object>}
   */
  async lookupBarcode(barcode, overrideAuth = null) {
    const cleanBarcode = String(barcode).trim();
    const mode = this.config.dataSource?.mode || 'mock';
    const startTime = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

    try {
      if (mode === 'mock') {
        const mockProducts = await this.fetchMockData();
        const elapsedNetworkMs = ((typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) - startTime);
        return {
          ok: true,
          fromMock: true,
          products: mockProducts,
          elapsedNetworkMs
        };
      }

      if (mode === 'web_app' || mode === 'test_sheet' || mode === 'sheets') {
        const baseUrl = this.config.dataSource?.sheetsApiUrl;
        if (!baseUrl) {
          throw new Error('Google Apps Script Web App URL이 설정되지 않았습니다.');
        }

        const auth = overrideAuth || this.getAuthPayload();
        if (!auth.idToken && !auth.sessionToken) {
          const elapsedNetworkMs = ((typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) - startTime);
          return {
            ok: false,
            found: false,
            barcode: cleanBarcode,
            reason: 'UNAUTHORIZED',
            message: '사용자 인증 토큰(Google ID Token 또는 직원 세션 토큰)이 없습니다. 먼저 직원 인증을 완료하세요.',
            elapsedNetworkMs
          };
        }

        const payload = {
          action: 'lookup',
          barcode: cleanBarcode,
          timestamp: Date.now(),
          ...auth
        };

        // Google Apps Script CORS/Redirect 호환을 위해 POST text/plain(JSON 문자열) 사용 및 URL 쿼리 노출 차단
        const res = await fetch(baseUrl, {
          method: 'POST',
          mode: 'cors',
          redirect: 'follow',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(payload)
        });

        const elapsedNetworkMs = ((typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) - startTime);

        if (!res.ok) {
          return {
            ok: false,
            found: false,
            barcode: cleanBarcode,
            reason: `HTTP_${res.status}`,
            message: `서버 통신 오류 (HTTP ${res.status})`,
            elapsedNetworkMs
          };
        }

        const data = await res.json();

        // 실제 Google Apps Script는 에러 시에도 HTTP 200 + { ok: false, status: "error", code: "..." } 반환
        if (data.ok === false || data.status === 'error') {
          return {
            ok: false,
            found: false,
            barcode: cleanBarcode,
            reason: data.code || 'API_ERROR',
            message: data.message || '인증 또는 조회 요청이 거부되었습니다.',
            elapsedNetworkMs
          };
        }

        let promotions = data.promotions;
        if (!Array.isArray(promotions)) {
          promotions = [
            ...(Array.isArray(data.conditionalPromotions) ? data.conditionalPromotions : []),
            ...(Array.isArray(data.commonGiftConditions) ? data.commonGiftConditions : [])
          ];
        }

        return {
          ...data,
          promotions,
          ok: true,
          elapsedNetworkMs
        };
      }

      throw new Error(`지원하지 않는 데이터 소스 모드입니다: ${mode}`);
    } catch (err) {
      const elapsedNetworkMs = ((typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) - startTime);
      return {
        ok: false,
        found: false,
        barcode: cleanBarcode,
        reason: 'NETWORK_ERROR',
        message: `통신 오류 발생: ${err.message}`,
        elapsedNetworkMs
      };
    }
  }

  /**
   * 로컬 가상 마스터 로드 (개발/오프라인 테스트 모드 전용)
   */
  async fetchMockData() {
    const path = this.config.dataSource?.mockDataPath || '../../data/mock_products.json';
    const res = await fetch(path);
    if (!res.ok) {
      throw new Error(`Mock 파일 읽기 실패: HTTP ${res.status}`);
    }
    return await res.json();
  }

  // [보안 격리] 관리자 전용 API 메서드는 직원용 배포본에서 배제되었습니다.

  // [보안 격리] 관리자 전용 API 메서드는 직원용 배포본에서 배제되었습니다.

  // [보안 격리] 관리자 전용 API 메서드는 직원용 배포본에서 배제되었습니다.

  // [보안 격리] 관리자 전용 API 메서드는 직원용 배포본에서 배제되었습니다.

  // [보안 격리] 관리자 전용 API 메서드는 직원용 배포본에서 배제되었습니다.

  /**
   * 마스터 활성 버전 확인 (공개 메타데이터 핑)
   */
  async checkActiveVersion() {
    const mode = this.config.dataSource?.mode || 'mock';
    if (mode === 'mock') {
      return { ok: true, activeVersion: 'v-mock-local' };
    }

    const baseUrl = this.config.dataSource?.sheetsApiUrl;
    if (!baseUrl) return { ok: false, activeVersion: 'unknown' };

    try {
      const res = await fetch(`${baseUrl}?action=check_version`, { method: 'GET', mode: 'cors', redirect: 'follow' });
      if (res.ok) {
        return await res.json();
      }
    } catch (e) {
      console.warn('버전 확인 실패');
    }
    return { ok: false, activeVersion: 'unknown' };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SheetsApiAdapter };
}

