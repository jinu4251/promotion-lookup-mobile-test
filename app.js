/**
 * Client App Logic (직원용 모바일 웹앱 PWA v12)
 * 
 * Phase K-1 UI/UX 개편:
 * 1. 화이트/레드 테마 기반 직관적인 모바일 레이아웃
 * 2. 2대 핵심 기능 대형 버튼 ('카메라로 스캔', '숫자로 조회')
 * 3. 카메라 영역 초기 미표시 및 단건 스캔 후 '다음 상품 스캔' 자동 전환
 * 4. 바코드 숫자 입력 초기화(✕) 버튼 및 중복 클릭 방지
 * 5. 카드형 프로모션 결과 표출 (정상가 그레이 취소선, 행사가 연한 레드 강조)
 * 6. 하단 3개 아이콘 현장 응대 가이드 및 개발자 정보 기본 숨김
 * 7. 기존 인증, 캐싱, 검색 엔진, 85개 회귀 무결성 100% 보존
 */
(async function () {
  let appConfig = null;
  let sheetsAdapter = null;
  let dataMatcher = null;
  let scanner = null;

  // [P0 안정화 및 단건 스캔 상태 변수]
  let activeBarcode = null;           // 현재 화면에 성공적으로 렌더링된 바코드
  let pendingBarcode = null;          // 현재 서버 조회 진행 중인 바코드 (In-flight 중복 차단)
  let currentRequestId = 0;            // 최신 요청 시퀀스 식별자 (Race condition guard)
  let wasScanningBeforeHidden = false; // 화면 잠금/전환 전 스캔 활성 플래그
  let isScanLocked = false;            // 유효 바코드 인식 즉시 가동되는 추가 스캔 차단 락
  let isCameraTransitioning = false;   // 카메라 시작/종료 비동기 전환 중 연타 방지 플래그
  let isSearching = false;             // 검색 버튼 중복 클릭 방지 플래그
  let isDebugMode = false;             // 개발자 디버그 모드 플래그

  // Phase H: TEST + ?phaseH=1에서만 활성화하는 비식별 휘발성 계측 (기본 OFF)
  const phaseHSamples = [];
  let phaseHScanStartedAt = null;
  let phaseHCameraReadyAt = null;
  const phaseHClock = () => performance.now();
  function phaseHEnabled() {
    return String(appConfig?.environment || '').toUpperCase() === 'TEST'
      && ['sheets', 'test_sheet', 'web_app'].includes(appConfig?.dataSource?.mode)
      && typeof location !== 'undefined'
      && new URLSearchParams(location.search).get('phaseH') === '1';
  }
  function isDebugRequested() {
    if (typeof location === 'undefined') return false;
    const params = new URLSearchParams(location.search);
    return params.get('debug') === '1' || phaseHEnabled() || isDebugMode;
  }
  window.__phaseHReport = () => phaseHEnabled()
    ? phaseHSamples.map(record => ({ ...record })) : [];

  // DOM Elements
  const appTitleEl = document.getElementById('app-title');
  const syncStatusEl = document.getElementById('sync-status');
  const envBadgeEl = document.getElementById('env-badge');
  const btnAuthStatus = document.getElementById('btn-auth-status');
  const authStatusText = document.getElementById('auth-status-text');
  const authModal = document.getElementById('auth-modal');
  const btnModalClose = document.getElementById('btn-modal-close');
  const selectAuthType = document.getElementById('select-auth-type');
  const inputAuthToken = document.getElementById('input-auth-token');
  const btnSaveAuth = document.getElementById('btn-save-auth');
  const authModalMsg = document.getElementById('auth-modal-msg');
  const gSigninBtnContainer = document.getElementById('g-signin-btn-container');
  const googleUserInfo = document.getElementById('google-user-info');
  const btnClearAuth = document.getElementById('btn-clear-auth');

  // UI/UX New Elements
  const btnOpenGuide = document.getElementById('btn-open-guide');
  const btnFocusManual = document.getElementById('btn-focus-manual');
  const scannerSection = document.getElementById('scanner-section');
  const btnCloseScanner = document.getElementById('btn-close-scanner');
  const btnClearInput = document.getElementById('btn-clear-input');
  const usageGuideSection = document.getElementById('usage-guide-section');
  const devDebugPanel = document.getElementById('dev-debug-panel');
  const debugLastTiming = document.getElementById('debug-last-timing');
  const debugProductCount = document.getElementById('debug-product-count');
  const debugPerfText = document.getElementById('debug-perf-text');

  function showModalMsg(msg, isError = false) {
    if (!authModalMsg) return;
    authModalMsg.textContent = msg;
    authModalMsg.style.display = 'block';
    authModalMsg.style.background = isError ? '#fee2e2' : '#dcfce7';
    authModalMsg.style.color = isError ? '#991b1b' : '#166534';
  }

  const productCountEl = document.getElementById('product-count');
  const btnToggleScan = document.getElementById('btn-toggle-scan');
  const scanBtnText = document.getElementById('scan-btn-text');
  const btnRefreshData = document.getElementById('btn-refresh-data');
  const inputBarcode = document.getElementById('input-barcode');
  const btnSearchBarcode = document.getElementById('btn-search-barcode');
  const resultContainer = document.getElementById('result-container');
  const scannerPlaceholder = document.getElementById('scanner-placeholder');

  /**
   * 스캐너 중지 헬퍼 (단건 스캔 UX & 영역 자동 접기)
   * @param {boolean} isAutoAfterScan - 단건 스캔 성공 후 자동 종료 여부
   */
  async function stopScanner(isAutoAfterScan = false) {
    if (!scanner) return;
    try {
      if (scanner.isScanning) {
        await scanner.stop();
      }
    } catch (e) {
      console.warn('[stopScanner] 스캐너 중지 알림:', e);
    } finally {
      if (scannerSection) scannerSection.style.display = 'none';
      if (scannerPlaceholder) scannerPlaceholder.style.display = 'none';
      if (scanBtnText) {
        scanBtnText.textContent = isAutoAfterScan ? '다음 상품 스캔' : '카메라로 스캔';
      }
    }
  }

  /**
   * 스캐너 시작 헬퍼 (카메라 영역 확장 및 세션 개시)
   */
  async function startScanner() {
    if (!scanner) return;
    if (scannerSection) scannerSection.style.display = 'block';
    if (scannerPlaceholder) scannerPlaceholder.style.display = 'block';
    try {
      if (phaseHEnabled()) phaseHScanStartedAt = phaseHClock();
      await scanner.start();
      if (phaseHEnabled()) phaseHCameraReadyAt = phaseHClock();
      if (scannerPlaceholder) scannerPlaceholder.style.display = 'none';
      if (scanBtnText) scanBtnText.textContent = '스캔 중지';
      isScanLocked = false; // 새 스캔 세션 시작 시 인식 락 해제
    } catch (err) {
      if (scannerSection) scannerSection.style.display = 'none';
      if (scannerPlaceholder) scannerPlaceholder.style.display = 'none';
      if (scanBtnText) scanBtnText.textContent = '카메라로 스캔';
      throw err;
    }
  }

  async function loadConfig() {
    try {
      const params = (typeof window !== 'undefined' && window.location) ? new URLSearchParams(window.location.search) : new URLSearchParams();
      const envParam = params.get('env') || (typeof localStorage !== 'undefined' && localStorage.getItem('PROMO_ENV')) || 'dev';
      const configPath = (envParam === 'prod' || envParam === 'production')
        ? './config.json'
        : ((envParam === 'test') ? './config.json' : './config.json');

      const res = await fetch(configPath);
      appConfig = await res.json();

      // 세션에 저장된 커스텀 Web App URL이 있는 경우 우선 적용 (테스트/실배포 유연성)
      if (typeof sessionStorage !== 'undefined') {
        const customUrl = sessionStorage.getItem('PROMO_SHEETS_API_URL');
        if (customUrl && appConfig.dataSource) {
          appConfig.dataSource.sheetsApiUrl = customUrl;
        }
      }

      if (appTitleEl) appTitleEl.textContent = '행사상품 프로모션 안내';
      const envName = (appConfig.environment || 'DEV').toUpperCase();
      const isProd = (envName === 'PROD' || envName === 'PRODUCTION');
      if (envBadgeEl) {
        envBadgeEl.textContent = isProd ? 'PROD' : 'TEST';
        envBadgeEl.className = isProd ? 'badge-env badge-env-prod' : 'badge-env badge-env-test';
      }
    } catch (e) {
      console.warn('설정 파일 로드 실패, 기본값 사용:', e);
      appConfig = {
        environment: 'development',
        dataSource: { mode: 'mock', mockDataPath: '../../data/mock_products.json' },
        cache: { enabled: true, ttlMinutes: 10 }
      };
    }
  }

  function updateAuthDisplay() {
    if (!btnAuthStatus || !authStatusText) return;
    const auth = sheetsAdapter ? sheetsAdapter.getAuthPayload() : {};
    const idToken = auth.idToken;
    const sessionToken = auth.sessionToken;

    if (idToken) {
      const payload = Utils.parseJwtPayload(idToken);
      const displayName = (payload && (payload.name || payload.email)) ? (payload.name || payload.email.split('@')[0]) : 'Google 인증됨';
      authStatusText.textContent = displayName;
      btnAuthStatus.className = 'badge-auth badge-auth-active';
      btnAuthStatus.title = `직원 인증 완료 (${payload ? payload.email : ''})`;

      if (googleUserInfo) {
        googleUserInfo.style.display = 'block';
        googleUserInfo.textContent = '';
        const strongEl = document.createElement('strong');
        strongEl.textContent = '로그인 계정: ';
        googleUserInfo.appendChild(strongEl);
        googleUserInfo.appendChild(document.createTextNode(payload?.email || 'Google ID Token'));
      }
    } else if (sessionToken) {
      const payload = Utils.parseJwtPayload(sessionToken);
      const email = payload && payload.email ? payload.email.split('@')[0] : '세션 인증';
      authStatusText.textContent = email;
      btnAuthStatus.className = 'badge-auth badge-auth-active';
      btnAuthStatus.title = '직원 세션 토큰 인증 완료';

      if (googleUserInfo) {
        googleUserInfo.style.display = 'block';
        googleUserInfo.textContent = '';
        const strongEl = document.createElement('strong');
        strongEl.textContent = '세션 토큰 계정: ';
        googleUserInfo.appendChild(strongEl);
        googleUserInfo.appendChild(document.createTextNode(payload?.email || 'HMAC-SHA256'));
      }
    } else {
      authStatusText.textContent = '미인증';
      btnAuthStatus.className = 'badge-auth badge-auth-none';
      btnAuthStatus.title = '직원 인증 필요 (클릭 시 로그인)';

      if (googleUserInfo) {
        googleUserInfo.style.display = 'none';
        googleUserInfo.textContent = '';
      }
    }
  }

  function handleGoogleSignInCallback(response) {
    if (!response || !response.credential) {
      showModalMsg('Google 로그인 응답이 올바르지 않습니다.', true);
      return;
    }

    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem('PROMO_USER_ID_TOKEN', response.credential);
      sessionStorage.removeItem('PROMO_USER_SESSION_TOKEN');
    }

    updateAuthDisplay();
    showModalMsg('Google 계정 인증이 완료되었습니다.', false);

    setTimeout(() => {
      if (authModal) authModal.classList.remove('open');
      if (authModalMsg) authModalMsg.style.display = 'none';
    }, 300);
  }

  function initGoogleSignIn() {
    const clientId = appConfig.auth?.googleClientId;

    if (!clientId) {
      if (gSigninBtnContainer) {
        gSigninBtnContainer.innerHTML = `
          <div style="font-size:0.75rem; color:#64748b; line-height:1.4;">
            Google OAuth Client ID가 아직 설정되지 않았습니다.<br>
            운영 관리자가 <code>config.prod.json</code>에 Client ID를 등록하면 원클릭 로그인이 활성화됩니다.
          </div>
        `;
      }
      return;
    }

    if (typeof window !== 'undefined' && window.google && window.google.accounts && window.google.accounts.id) {
      try {
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: handleGoogleSignInCallback,
          auto_select: false
        });

        if (gSigninBtnContainer) {
          gSigninBtnContainer.innerHTML = '';
          window.google.accounts.id.renderButton(gSigninBtnContainer, {
            theme: 'outline',
            size: 'large',
            width: 280,
            text: 'signin_with',
            locale: 'ko'
          });
        }
      } catch (err) {
        console.warn('Google Identity Services 초기화 오류:', err);
      }
    } else {
      setTimeout(initGoogleSignIn, 500);
    }
  }

  async function syncProducts(forceRefresh = false) {
    if (syncStatusEl) syncStatusEl.textContent = '동기화 중...';
    try {
      const mode = appConfig.dataSource.mode;
      if (mode === 'sheets' || mode === 'test_sheet') {
        if (syncStatusEl) syncStatusEl.textContent = 'Google Sheets 연결됨';
        if (productCountEl) productCountEl.textContent = '실시간 API';
        if (debugProductCount) debugProductCount.textContent = '실시간 API';
        return;
      }

      const products = await sheetsAdapter.fetchMockData(forceRefresh);
      dataMatcher.setProducts(products);

      if (productCountEl) productCountEl.textContent = products.length;
      if (debugProductCount) debugProductCount.textContent = products.length;
      if (syncStatusEl) syncStatusEl.textContent = '동기화 완료';
    } catch (err) {
      console.error('데이터 동기화 실패:', err);
      if (syncStatusEl) syncStatusEl.textContent = '동기화 실패';
    }
  }

  /**
   * 바코드 조회 핸들러 (In-flight 차단, 중복 클릭 방지, 단건 스캔 보호)
   */
  async function handleLookup(barcode, forceRefresh = false, phaseHScan = null) {
    const rawInput = String(barcode || '').trim();
    if (!rawInput) return;

    // 0. 바코드 형식 엄격 검증 (특수문자 차단)
    if (!/^[a-zA-Z0-9_-]{4,30}$/.test(rawInput)) {
      renderResult({
        found: false,
        barcode: rawInput,
        reason: 'INVALID_BARCODE_FORMAT',
        message: '바코드 형식이 올바르지 않습니다 (특수문자 사용 불가).',
        elapsedMatchMs: 0.1,
        elapsedNetworkMs: 0
      }, rawInput);
      return;
    }

    // 1. In-flight 요청 중복 차단
    if (pendingBarcode === rawInput) {
      console.warn(`[handleLookup] 이미 요청 처리 중인 바코드입니다: ${rawInput}`);
      return;
    }

    // 2. 단건 스캔 안정화: 이미 동일 바코드가 화면에 정상 표출되어 있고 강제 조회가 아니라면 재요청 불필요
    if (!forceRefresh && activeBarcode === rawInput) {
      console.log(`[handleLookup] 동일 바코드가 이미 화면에 표시되어 있습니다: ${rawInput}`);
      return;
    }

    // 3. EAN-13 및 EAN-8 체크디지트 사전 검사 (표준 13자리 및 8자리 바코드 대상 엄격 검증)
    if (rawInput.length === 13 && Utils?.validateEAN13) {
      const checkRes = Utils.validateEAN13(rawInput);
      if (!checkRes.valid) {
        renderResult({
          found: false,
          barcode: rawInput,
          reason: 'CHECK_DIGIT_FAIL',
          message: `체크디지트 불일치: ${checkRes.error}`,
          elapsedMatchMs: 0.1,
          elapsedNetworkMs: 0
        }, rawInput);
        return;
      }
    } else if (rawInput.length === 8 && Utils?.validateEAN8) {
      const checkRes = Utils.validateEAN8(rawInput);
      if (!checkRes.valid) {
        renderResult({
          found: false,
          barcode: rawInput,
          reason: 'CHECK_DIGIT_FAIL',
          message: `EAN-8 체크디지트 불일치: ${checkRes.error}`,
          elapsedMatchMs: 0.1,
          elapsedNetworkMs: 0
        }, rawInput);
        return;
      }
    }

    const cleanBarcode = rawInput;

    const thisRequestId = ++currentRequestId;
    pendingBarcode = rawInput;

    // 검색 버튼 로딩 상태 전환
    if (btnSearchBarcode) {
      btnSearchBarcode.disabled = true;
      btnSearchBarcode.textContent = '조회중...';
    }

    // 로딩 인디케이터 표시
    if (resultContainer) {
      resultContainer.innerHTML = `
        <div class="loading-card">
          <div class="loading-spinner"></div>
          <div class="loading-text">행사정보 조회 중...</div>
          <div class="loading-sub">${Utils.escapeHtml(rawInput)}</div>
        </div>
      `;
    }

    // Phase H 실측 기록
    const sampleRecord = phaseHEnabled() ? {
      seq: phaseHSamples.length + 1,
      source: 'manual',
      scanStart: null,
      cameraReady: null,
      decoded: null,
      cameraStopMs: null,
      preLookupStart: phaseHClock(),
      preLookupDeltaMs: null,
      reqStart: null,
      networkMs: null,
      renderMs: null,
      totalMs: null,
      mode: appConfig?.dataSource?.mode || 'unknown'
    } : null;

    if (phaseHScan && sampleRecord) {
      sampleRecord.source = 'camera';
      sampleRecord.scanStart = phaseHScan.scanStart;
      sampleRecord.cameraReady = phaseHScan.cameraReady;
      sampleRecord.decoded = phaseHScan.decoded;
      sampleRecord.cameraStopMs = phaseHScan.cameraStopMs;
      sampleRecord.preLookupDeltaMs = +(sampleRecord.preLookupStart - phaseHScan.decoded).toFixed(2);
    }

    try {
      const mode = appConfig.dataSource.mode;

      // 4. 조회 분기 (Google Sheets 실시간 API vs 로컬 Mock)
      if (mode === 'sheets' || mode === 'test_sheet') {
        const netStart = performance.now();
        if (sampleRecord) sampleRecord.reqStart = netStart;

        const serverResult = await sheetsAdapter.lookupBarcode(cleanBarcode);
        const netEnd = performance.now();
        const elapsedNet = +(netEnd - netStart).toFixed(1);

        if (sampleRecord) sampleRecord.networkMs = elapsedNet;

        // 경합(Race condition) 방지: 최신 요청이 아니면 폐기
        if (thisRequestId !== currentRequestId) return;

        serverResult.elapsedNetworkMs = elapsedNet;
        serverResult.elapsedMatchMs = serverResult.elapsedMatchMs || 0.1;

        const renderStart = performance.now();
        activeBarcode = serverResult.found ? cleanBarcode : null;
        renderResult(serverResult, cleanBarcode);
        const renderEnd = performance.now();

        if (sampleRecord) {
          sampleRecord.renderMs = +(renderEnd - renderStart).toFixed(2);
          sampleRecord.totalMs = +(renderEnd - (sampleRecord.scanStart || sampleRecord.preLookupStart)).toFixed(2);
          phaseHSamples.push(sampleRecord);
        }
      } else {
        const matchResult = dataMatcher.match(cleanBarcode);
        if (thisRequestId !== currentRequestId) return;

        activeBarcode = matchResult.found ? cleanBarcode : null;
        renderResult(matchResult, cleanBarcode);
      }
    } catch (err) {
      console.error('[handleLookup] 조회 오류:', err);
      if (thisRequestId === currentRequestId) {
        activeBarcode = null;
        renderResult({
          found: false,
          reason: err.code || 'NETWORK_ERROR',
          message: err.message || '네트워크 연결 상태를 확인하고 다시 시도해 주세요.',
          elapsedMatchMs: 0,
          elapsedNetworkMs: 0
        }, rawInput);
      }
    } finally {
      if (thisRequestId === currentRequestId) {
        pendingBarcode = null;
      }
      if (btnSearchBarcode) {
        btnSearchBarcode.disabled = false;
        btnSearchBarcode.textContent = '조회';
      }
    }
  }

  /**
   * [Phase I-2] 정상적인 0원 가격과 공란·오류값 엄격 구분 헬퍼 (공통 스코프 선언)
   */
  function isPriceValidNumber(val) {
    if (val === null || val === undefined) return false;
    const s = String(val).trim();
    if (s === '' || s.includes('#')) return false;
    const n = Number(s);
    return Number.isFinite(n) && n >= 0;
  }

  /**
   * 3-6. 결과 렌더링 (승인 디자인 기준 카드형 구조 & XSS 방어)
   */
  function renderResult(result, inputCode) {
    const isDebug = isDebugRequested();
    const netTimeStr = Number(result.elapsedNetworkMs) > 0 ? `네트워크: ${Number(result.elapsedNetworkMs).toFixed(1)}ms | ` : '';
    const matchTime = typeof result.elapsedMatchMs === 'number' ? result.elapsedMatchMs.toFixed(2) : '0.00';
    const timeDisplay = `${netTimeStr}매칭: ${matchTime}ms`;

    const safeInputCode = Utils.escapeHtml(inputCode);
    const safeBarcode = Utils.escapeHtml(result.barcode || inputCode);

    if (debugLastTiming) debugLastTiming.textContent = timeDisplay;

    // A. 조회 실패 / 에러 카드 렌더링
    if (!result.found) {
      let badgeLabel = '미행사';
      let titleText = '등록된 행사정보 없음';
      let statusDesc = result.message || '현재 등록된 프로모션 행사 상품이 아닙니다.';

      if (result.reason === 'CHECK_DIGIT_FAIL') {
        badgeLabel = '바코드 오류';
        titleText = '조회 불가';
        statusDesc = '바코드 끝자리 체크디지트가 일치하지 않습니다. 번호를 다시 확인해 주세요.';
      } else if (result.reason === 'INVALID_LENGTH' || result.reason === 'INVALID_BARCODE_FORMAT') {
        badgeLabel = '자릿수 오류';
        titleText = '조회 불가';
        statusDesc = '표준 바코드(8자리, 12자리, 13자리) 숫자 형식으로 입력해 주세요.';
      } else if (result.reason === 'UNAUTHORIZED') {
        badgeLabel = '인증 필요';
        titleText = '직원 인증 필요';
        statusDesc = '행사 조회를 위해 상단 [미인증] 버튼을 눌러 사내 계정으로 로그인해 주세요.';
      } else if (result.reason === 'UNAUTHORIZED_USER') {
        badgeLabel = '미등록 직원';
        titleText = '조회 불가';
        statusDesc = '사내 승인 명부에 등록되지 않은 계정입니다. 매장 관리자에게 문의하세요.';
      } else if (result.reason === 'USER_REVOKED') {
        badgeLabel = '권한 차단';
        titleText = '조회 불가';
        statusDesc = '조회 권한이 비활성화된 계정입니다.';
      } else if (result.reason === 'EXPIRED_REQUEST') {
        badgeLabel = '요청 만료';
        titleText = '조회 시간 초과';
        statusDesc = '보안 서명 요청 시간이 만료되었습니다. 다시 조회해 주세요.';
      } else if (result.reason === 'TOO_MANY_REQUESTS') {
        badgeLabel = '한도 초과';
        titleText = '조회 제한';
        statusDesc = '단시간 요청 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.';
      } else if (result.reason === 'NETWORK_ERROR') {
        badgeLabel = '통신 오류';
        titleText = '네트워크 연결 실패';
        statusDesc = '서버와의 통신이 원활하지 않습니다. Wi-Fi 또는 데이터 상태를 확인해 주세요.';
      } else if (result.reason === 'RENDER_ERROR') {
        badgeLabel = '표시 오류';
        titleText = '화면 렌더링 오류';
        statusDesc = result.message || '화면 렌더링 중 오류가 발생했습니다.';
      } else if (result.reason === 'SYSTEM_ERROR') {
        badgeLabel = '시스템 오류';
        titleText = '서버 처리 오류';
        statusDesc = '서버 처리 중 일시적인 오류가 발생했습니다.';
      }

      const safeBadgeLabel = Utils.escapeHtml(badgeLabel);
      const safeReason = Utils.escapeHtml(result.reason || 'NOT_FOUND');
      const safeTitleText = Utils.escapeHtml(titleText);
      const safeStatusDesc = Utils.escapeHtml(statusDesc);

      resultContainer.innerHTML = `
        <div class="error-result-card">
          <div class="promo-subcard-header">
            <span class="promo-type-badge" style="background:#64748b;">${safeBadgeLabel}</span>
            <span class="promo-status-badge status-expired">${safeReason}</span>
          </div>
          <h2 class="error-title">${safeTitleText}</h2>
          <div style="font-size:0.8rem; color:#64748b; font-family:monospace; margin-bottom:10px;">
            입력 바코드: ${safeInputCode}
          </div>
          <div class="error-desc">
            ${safeStatusDesc}
          </div>
          <div class="card-footer-row">
            <button type="button" class="btn-relookup" data-barcode="${safeInputCode}">↻ 다시 조회</button>
            ${isDebug ? `<span style="font-size:0.7rem; color:#94a3b8;">${Utils.escapeHtml(timeDisplay)}</span>` : ''}
          </div>
        </div>
      `;
      return;
    }

    // B. 조회 성공 카드 렌더링
    const formatRawPrice = (val) => {
      if (val === null || val === undefined || val === '') return '-';
      const n = Number(val);
      return Number.isFinite(n) ? `${n.toLocaleString('ko-KR')}원` : Utils.escapeHtml(String(val));
    };

    const promoCardsHtml = (result.promotions || []).map((item, idx) => {
      const promoTypeRaw = String(item.promotionType || '').trim();
      const badgeClass = Utils.getBadgeClass(promoTypeRaw || '기타');
      const statusClass = item.computedStatus === 'ACTIVE'
        ? 'status-active'
        : (item.computedStatus === 'EXPIRED' ? 'status-expired' : 'status-upcoming');

      const rowTag = result.hasMultiplePromotions
        ? `<span class="promo-index-tag">[행사 ${idx + 1}]</span>`
        : '';

      const hasNormPrice = isPriceValidNumber(item.normalPrice);
      const hasSalePrice = isPriceValidNumber(item.discountPrice);

      // 판매가 오류 여부 판별 (명시적 오류 플래그, 수식 오류(#VALUE!, #REF!), 가격할인 행사인데 행사가 누락된 경우)
      const isSalePriceError = item.isPriceError === true ||
        item.discountPriceError === true ||
        String(item.discountPrice || '').includes('#') ||
        (promoTypeRaw === '가격할인' && !hasSalePrice);

      // 정상가 및 행사가 카드 블록 (3-6 디자인 승인 사양: 행사가 존재 시 정상가 취소선 + 행사가 연한 레드 강조)
      let priceDisplayBlock = '';
      if (hasNormPrice || hasSalePrice || isSalePriceError) {
        // 행사가가 실제로 존재할 때만 정상가에 취소선 적용 (증정 행사 등 행사가 미존재 시 정상가 취소선 오인 방지)
        const isStrikeThrough = hasSalePrice;
        const normalValClass = isStrikeThrough ? 'normal-price-val normal-price-strike' : 'normal-price-val';

        const normalBoxHtml = hasNormPrice ? `
          <div class="normal-price-box">
            <span class="${normalValClass}">정상가 ${formatRawPrice(item.normalPrice)}</span>
          </div>
        ` : '';

        let saleBoxInner = '';
        if (hasSalePrice) {
          saleBoxInner = `<strong>원본 행사가:</strong> ${formatRawPrice(item.discountPrice)}`;
        } else if (isSalePriceError) {
          saleBoxInner = `<strong>원본 행사가:</strong> <span class="price-error-tag">가격 확인 필요</span>`;
        }

        const saleBoxHtml = (hasSalePrice || isSalePriceError) ? `
          <div class="sale-price-box">
            <span class="sale-price-val">${saleBoxInner}</span>
          </div>
        ` : '';

        priceDisplayBlock = `
          <div class="price-display-block">
            ${normalBoxHtml}
            ${saleBoxHtml}
          </div>
        `;
      }

      const detailRaw = String(item.promotionDetail || item.originalDetail || '').trim();
      const yearNotice = item.yearConfirmed === false ? ' (연도 미표기 원본)' : '';

      const safePromoType = Utils.escapeHtml(promoTypeRaw || '행사유형 미기재');
      const safeStatusMessage = Utils.escapeHtml(item.statusMessage || (item.computedStatus === 'ACTIVE' ? '행사 진행 중' : (item.computedStatus === 'EXPIRED' ? '행사 종료' : '행사 예정')));
      const safeDetail = detailRaw ? Utils.escapeHtml(detailRaw) : '<span style="color:#94a3b8;">(원본 상세조건 공란)</span>';
      const safeGiftName = item.giftName ? `<br><strong>증정품:</strong> ${Utils.escapeHtml(item.giftName)}` : '';
      const safeAudience = item.targetAudience ? `<br><strong>대상고객:</strong> ${Utils.escapeHtml(item.targetAudience)}` : '';
      const safeExtraNote = item.giftConditionNote ? `<br><strong>추가 안내사항:</strong> ${Utils.escapeHtml(item.giftConditionNote)}` : '';

      // 날짜 포맷
      const safeStartDate = Utils.escapeHtml(Utils.formatDate(item.startDate));
      const safeEndDate = Utils.escapeHtml(Utils.formatDate(item.endDate));
      const safeYearNotice = Utils.escapeHtml(yearNotice);
      const safeDates = (safeStartDate || safeEndDate) ? `${safeStartDate} ~ ${safeEndDate}${safeYearNotice}` : '-';

      return `
        <div class="promo-subcard">
          <div class="promo-subcard-header">
            <div>
              <span class="promo-type-badge ${badgeClass}">${safePromoType}</span>
              ${rowTag}
            </div>
            <span class="promo-status-badge ${statusClass}">${safeStatusMessage}</span>
          </div>

          ${priceDisplayBlock}

          <div class="period-display-box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
              <line x1="16" y1="2" x2="16" y2="6"></line>
              <line x1="8" y1="2" x2="8" y2="6"></line>
              <line x1="3" y1="10" x2="21" y2="10"></line>
            </svg>
            <span><strong>행사 기간:</strong> ${safeDates}</span>
          </div>

          <div class="detail-display-box">
            <span class="detail-label">행사 상세조건:</span>${safeDetail}${safeGiftName}${safeAudience}${safeExtraNote}
          </div>
        </div>
      `;
    }).join('');

    // 상품 메타 칩 (분류, 규격 등)
    const chips = [];
    chips.push(`<span class="meta-chip meta-chip-barcode">바코드: ${safeBarcode}</span>`);

    const isInvalidCat = !result.category || String(result.category).trim() === '' || String(result.category).includes('#');
    if (!isInvalidCat) {
      chips.push(`<span class="meta-chip">분류: ${Utils.escapeHtml(result.category)}</span>`);
    }

    if (result.spec && String(result.spec).trim() !== '' && !String(result.spec).includes('#')) {
      chips.push(`<span class="meta-chip">규격: ${Utils.escapeHtml(result.spec)}</span>`);
    }

    const hasNormHeader = isPriceValidNumber(result.normalPrice);
    if (hasNormHeader) {
      chips.push(`<span class="meta-chip">원본 정상가: ${formatRawPrice(result.normalPrice)}</span>`);
    }

    if (result.unitPrice) {
      chips.push(`<span class="meta-chip">단위당: ${Utils.formatCurrency(result.unitPrice)}</span>`);
    }

    if (result.leafletMark) {
      chips.push(`<span class="meta-chip">전단: ${Utils.escapeHtml(result.leafletMark)}</span>`);
    }

    const sourceLabel = (appConfig?.dataSource?.mode === 'mock')
      ? '<span class="badge-source">[로컬 Mock]</span>'
      : '<span class="badge-source">[Google Sheets 실시간]</span>';

    // 행사 건수는 실제 반환된 프로모션 수에 근거하여 표시하며 임의로 1건을 표시하지 않음
    const actualPromoCount = Array.isArray(result.promotions)
      ? result.promotions.length
      : (typeof result.promotionCount === 'number' ? result.promotionCount : 0);
    const promoCountText = actualPromoCount > 0
      ? `등록된 행사 (${actualPromoCount}건)`
      : '등록된 행사 없음';

    const safeProductName = Utils.escapeHtml(result.productName);

    resultContainer.innerHTML = `
      <div class="product-result-card">
        <div class="card-header-row">
          <div style="display:flex; align-items:center; gap:6px;">
            ${sourceLabel}
            <span class="badge-promo-count">${promoCountText}</span>
          </div>
          <button type="button" class="btn-relookup" data-barcode="${safeBarcode}">↻ 다시 조회</button>
        </div>

        <h2 class="product-name-title">${safeProductName}</h2>

        <div class="product-meta-chips">
          ${chips.join('')}
        </div>

        <div class="promo-subcards-wrapper">
          ${promoCardsHtml}
        </div>

        <div class="card-footer-row">
          <button type="button" class="btn-relookup" data-barcode="${safeBarcode}">↻ 다시 조회</button>
          ${isDebug ? `
            <div style="font-size:0.7rem; color:#94a3b8; font-family:monospace;">
              <span>${Utils.escapeHtml(timeDisplay)}</span>
              <span style="font-size:0.65rem; color:#cbd5e1; margin-left:4px;">안전 렌더링 완료</span>
            </div>
          ` : '<span style="font-size:0.7rem; color:#cbd5e1;">안전 렌더링 완료</span>'}
        </div>
      </div>
    `;
  }

  // [P0 실환경 및 단위 테스트용 함수 전역 노출]
  if (typeof window !== 'undefined') {
    window.renderResult = renderResult;
    window.isPriceValidNumber = isPriceValidNumber;
  }

  async function initScanner() {
    scanner = new ScannerEngine({
      targetElementId: 'scanner-reader',
      cooldownMs: 1500,
      validateCheckDigit: true,
      onScanSuccess: async (decodedText) => {
        // 1. 단건 스캔 인식 락: 이미 유효 바코드가 인식되어 카메라 종료/조회 진행 중이면 모든 스캔 무시
        if (isScanLocked) return;

        const clean = String(decodedText).trim();

        // 2. EAN-13 및 EAN-8 체크디지트 사전 검증 (체크디지트 오류 시 카메라를 종료하지 않고 계속 스캔 진행)
        if (clean.length === 13 && typeof Utils !== 'undefined' && Utils.validateEAN13) {
          const checkRes = Utils.validateEAN13(clean);
          if (!checkRes.valid) {
            console.warn('[initScanner] 체크디지트 불일치로 스캔 계속:', clean, checkRes.error);
            return;
          }
        } else if (clean.length === 8 && typeof Utils !== 'undefined' && Utils.validateEAN8) {
          const checkRes = Utils.validateEAN8(clean);
          if (!checkRes.valid) {
            console.warn('[initScanner] EAN-8 체크디지트 불일치로 스캔 계속:', clean, checkRes.error);
            return;
          }
        }

        // 3. 유효 바코드 인식 확정 -> 즉시 인식 락 가동
        isScanLocked = true;

        const phaseHScan = phaseHEnabled() ? {
          scanStart: phaseHScanStartedAt,
          cameraReady: phaseHCameraReadyAt,
          decoded: phaseHClock(),
          cameraStopMs: null
        } : null;

        // 4. 모바일 햅틱 진동 피드백
        if (typeof navigator !== 'undefined' && navigator.vibrate) {
          try { navigator.vibrate(40); } catch (e) {}
        }

        if (inputBarcode) {
          inputBarcode.value = clean;
          if (btnClearInput) btnClearInput.style.display = 'flex';
        }

        // 5. 카메라 자동 종료 및 자원 해제 (버튼 텍스트를 '다음 상품 스캔'으로 전환, 영역 자동 접기)
        const phaseHStopStart = phaseHScan ? phaseHClock() : null;
        try {
          await stopScanner(true);
        } catch (e) {
          console.warn('[initScanner] 카메라 자동 종료 오류:', e);
        }
        if (phaseHScan) phaseHScan.cameraStopMs = +(phaseHClock() - phaseHStopStart).toFixed(2);

        // 6. 상품 조회 실행 (forceRefresh = true로 동일 상품이라도 새 스캔 세션 결과 갱신 보장)
        await handleLookup(clean, true, phaseHScan);
      },
      onScanError: () => {}
    });

    if (btnToggleScan) {
      btnToggleScan.addEventListener('click', async () => {
        if (isCameraTransitioning) return;
        isCameraTransitioning = true;

        try {
          if (scanner.isScanning) {
            // 사용자가 수동으로 스캔 중지
            await stopScanner(false);
          } else {
            // 사용자가 스캔 시작 또는 '다음 상품 스캔' 클릭 (새 스캔 세션 개시)
            activeBarcode = null;
            isScanLocked = false;
            await startScanner();
          }
        } catch (err) {
          console.warn('카메라 실행 오류:', err);
          alert('카메라 접근 권한이 없거나 지원되지 않는 기기입니다. 상단의 [숫자로 조회]를 이용해 주세요.');
          if (scannerSection) scannerSection.style.display = 'none';
        } finally {
          isCameraTransitioning = false;
        }
      });
    }

    if (btnCloseScanner) {
      btnCloseScanner.addEventListener('click', async () => {
        await stopScanner(false);
      });
    }
  }

  function registerEvents() {
    // 3-3 ②. '숫자로 조회' 버튼 클릭 시 입력창으로 포커스 이동 & 모바일 키패드 자동 활성화
    if (btnFocusManual) {
      btnFocusManual.addEventListener('click', () => {
        if (inputBarcode) {
          inputBarcode.focus();
          inputBarcode.scrollIntoView({ behavior: 'smooth', block: 'center' });
          if (inputBarcode.value) {
            inputBarcode.select();
          }
        }
      });
    }

    // 3-5. 바코드 숫자 입력 변경 시 초기화(✕) 버튼 토글
    if (inputBarcode) {
      inputBarcode.addEventListener('input', () => {
        if (btnClearInput) {
          btnClearInput.style.display = inputBarcode.value.length > 0 ? 'flex' : 'none';
        }
      });

      inputBarcode.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const code = inputBarcode.value.trim();
          if (code) handleLookup(code, true);
        }
      });
    }

    // 3-5. 입력 초기화 버튼
    if (btnClearInput) {
      btnClearInput.addEventListener('click', () => {
        if (inputBarcode) {
          inputBarcode.value = '';
          btnClearInput.style.display = 'none';
          inputBarcode.focus();
        }
      });
    }

    // 3-5. 조회 버튼 클릭
    if (btnSearchBarcode) {
      btnSearchBarcode.addEventListener('click', () => {
        if (!inputBarcode) return;
        const code = inputBarcode.value.trim();
        if (!code) {
          alert('바코드 번호를 입력해주세요.');
          inputBarcode.focus();
          return;
        }
        handleLookup(code, true);
      });
    }

    // 데이터 새로고침
    if (btnRefreshData) {
      btnRefreshData.addEventListener('click', () => {
        syncProducts(true);
      });
    }

    // 3-2. 상단 이용 안내 아이콘 클릭 시 하단 가이드로 부드럽게 스크롤
    if (btnOpenGuide) {
      btnOpenGuide.addEventListener('click', () => {
        if (usageGuideSection) {
          usageGuideSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    }

    // 상단 환경 뱃지 더블클릭 시 디버그 모드 토글 (관리자 편의 기능)
    if (envBadgeEl) {
      let clickTimer = null;
      envBadgeEl.addEventListener('click', () => {
        if (clickTimer) {
          clearTimeout(clickTimer);
          clickTimer = null;
          isDebugMode = !isDebugMode;
          if (devDebugPanel) {
            devDebugPanel.style.display = isDebugMode ? 'block' : 'none';
          }
          console.log(`[ClientApp] 디버그 패널 토글: ${isDebugMode}`);
        } else {
          clickTimer = setTimeout(() => { clickTimer = null; }, 300);
        }
      });
    }

    // 다시 조회 버튼 이벤트 위임
    if (resultContainer) {
      resultContainer.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-relookup');
        if (btn) {
          const barcode = btn.getAttribute('data-barcode');
          if (barcode) {
            if (inputBarcode) {
              inputBarcode.value = barcode;
              if (btnClearInput) btnClearInput.style.display = 'flex';
            }
            handleLookup(barcode, true);
          }
        }
      });
    }

    // 화면 잠금 및 브라우저 복귀 시 카메라 상태 관리
    document.addEventListener('visibilitychange', async () => {
      if (document.hidden) {
        if (scanner && scanner.isScanning) {
          wasScanningBeforeHidden = true;
          try {
            await stopScanner(false);
          } catch (e) {
            console.warn('[visibilitychange] 카메라 일시 정지:', e);
          }
        } else {
          wasScanningBeforeHidden = false;
        }
      } else {
        if (wasScanningBeforeHidden && scanner && !scanner.isScanning) {
          wasScanningBeforeHidden = false;
          try {
            await startScanner();
          } catch (err) {
            console.warn('[visibilitychange] 카메라 자동 재개 실패:', err);
          }
        }
      }
    });

    // 직원 인증 모달 열기/닫기/저장
    if (btnAuthStatus) {
      btnAuthStatus.addEventListener('click', () => {
        if (authModal) authModal.classList.add('open');
      });
    }

    if (btnModalClose) {
      btnModalClose.addEventListener('click', () => {
        if (authModal) authModal.classList.remove('open');
      });
    }

    if (authModal) {
      authModal.addEventListener('click', (e) => {
        if (e.target === authModal) {
          authModal.classList.remove('open');
        }
      });
    }

    if (btnSaveAuth) {
      btnSaveAuth.addEventListener('click', () => {
        const tokenVal = (inputAuthToken ? inputAuthToken.value : '').trim();
        const authType = selectAuthType ? selectAuthType.value : 'session';

        if (!tokenVal) {
          showModalMsg('인증 토큰 문자열을 입력해주세요.', true);
          return;
        }

        if (typeof sessionStorage !== 'undefined') {
          if (authType === 'id_token') {
            sessionStorage.setItem('PROMO_USER_ID_TOKEN', tokenVal);
            sessionStorage.removeItem('PROMO_USER_SESSION_TOKEN');
          } else {
            sessionStorage.setItem('PROMO_USER_SESSION_TOKEN', tokenVal);
            sessionStorage.removeItem('PROMO_USER_ID_TOKEN');
          }
        }

        updateAuthDisplay();
        showModalMsg('직원 인증 정보가 설정되었습니다.', false);
        if (inputAuthToken) inputAuthToken.value = '';
        setTimeout(() => {
          if (authModal) authModal.classList.remove('open');
          if (authModalMsg) authModalMsg.style.display = 'none';
        }, 150);
      });
    }

    if (btnClearAuth) {
      btnClearAuth.addEventListener('click', () => {
        if (typeof sessionStorage !== 'undefined') {
          sessionStorage.removeItem('PROMO_USER_ID_TOKEN');
          sessionStorage.removeItem('PROMO_USER_SESSION_TOKEN');
        }
        if (typeof window !== 'undefined' && window.google && window.google.accounts && window.google.accounts.id) {
          try { window.google.accounts.id.disableAutoSelect(); } catch (e) {}
        }
        updateAuthDisplay();
        showModalMsg('인증 정보가 삭제(로그아웃)되었습니다.', false);
        if (inputAuthToken) inputAuthToken.value = '';
        setTimeout(() => {
          if (authModal) authModal.classList.remove('open');
          if (authModalMsg) authModalMsg.style.display = 'none';
        }, 150);
      });
    }
  }

  function registerServiceWorker() {
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('./sw.js')
        .then((reg) => console.log('[ClientApp] ServiceWorker 등록 완료 (v12 UI 셸 전용 캐시):', reg.scope))
        .catch((err) => console.warn('[ClientApp] ServiceWorker 등록 실패:', err));
    }
  }

  await loadConfig();
  sheetsAdapter = new SheetsApiAdapter(appConfig);
  dataMatcher = new DataMatcher([]);
  updateAuthDisplay();
  initGoogleSignIn();
  await syncProducts();
  await initScanner();
  registerEvents();

  if (phaseHEnabled()) {
    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.textContent = 'Phase H 측정결과 저장';
    exportBtn.id = 'phase-h-export';
    Object.assign(exportBtn.style, {
      position: 'fixed', right: '12px', bottom: '12px', zIndex: '9999',
      background: '#1e293b', color: '#fff', border: '1px solid #64748b',
      borderRadius: '8px', padding: '10px 12px', fontSize: '12px', cursor: 'pointer'
    });
    exportBtn.addEventListener('click', () => {
      const output = { generatedAt: new Date().toISOString(), environment: 'TEST',
        description: 'Phase H anonymous timing samples; no barcode/user/token data',
        samples: window.__phaseHReport() };
      const blob = new Blob([JSON.stringify(output, null, 2)], { type: 'application/json' });
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = 'phase-h-results-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    });
    document.body.appendChild(exportBtn);
  }

  if (devDebugPanel && isDebugRequested()) {
    devDebugPanel.style.display = 'block';
  }

  registerServiceWorker();

  // [P0 실환경 및 단위 테스트용 함수 전역 노출]
  if (typeof window !== 'undefined') {
    window.renderResult = renderResult;
    window.isPriceValidNumber = isPriceValidNumber;
  }
})();
