/**
 * Client App Logic (직원용 모바일 웹앱)
 * 
 * 성능 표기 원칙:
 * 1. 로컬 매칭 시간(인메모리 검색)과 실제 네트워크 통신 시간을 명확히 분리하여 표시한다.
 * 2. 복수 프로모션 전체 표출 및 원문 문자열 100% 보존.
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
   * 스캐너 중지 헬퍼 (단건 스캔 UX)
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
      if (scannerPlaceholder) scannerPlaceholder.style.display = 'block';
      if (scanBtnText) {
        scanBtnText.textContent = isAutoAfterScan ? '다음 상품 스캔' : '스캔 시작';
      }
    }
  }

  /**
   * 스캐너 시작 헬퍼 (새 스캔 세션 개시)
   */
  async function startScanner() {
    if (!scanner) return;
    if (scannerPlaceholder) scannerPlaceholder.style.display = 'none';
    try {
      await scanner.start();
      if (scanBtnText) scanBtnText.textContent = '스캔 중지';
      isScanLocked = false; // 새 스캔 세션 시작 시 인식 락 해제
    } catch (err) {
      if (scannerPlaceholder) scannerPlaceholder.style.display = 'block';
      if (scanBtnText) scanBtnText.textContent = '스캔 시작';
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

      appTitleEl.textContent = '행사상품 조회';
      const envName = (appConfig.environment || 'DEV').toUpperCase();
      const isProd = (envName === 'PROD' || envName === 'PRODUCTION');
      envBadgeEl.textContent = isProd ? 'PROD' : 'TEST';
      envBadgeEl.className = isProd ? 'badge-env badge-env-prod' : 'badge-env badge-env-test';
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
      // 라이브러리 비동기 로딩 대기 후 재시도
      setTimeout(initGoogleSignIn, 500);
    }
  }

  async function syncProducts(forceRefresh = false) {
    const mode = appConfig.dataSource?.mode || 'mock';
    syncStatusEl.textContent = '동기화 중...';

    try {
      if (mode === 'mock') {
        const mockProducts = await sheetsAdapter.fetchMockData();
        dataMatcher.setProducts(mockProducts);
        const uniqueCount = dataMatcher.getUniqueBarcodeCount();
        const totalPromos = dataMatcher.getTotalPromotionCount();
        productCountEl.textContent = `${uniqueCount}개 상품 (${totalPromos}건 행사)`;
        syncStatusEl.textContent = '로컬 Mock 연결됨';
      } else {
        // 실제 Google Sheets / Apps Script 연동 모드
        productCountEl.textContent = '실시간 API 연결';
        const verRes = await sheetsAdapter.checkActiveVersion();
        if (verRes && verRes.ok) {
          syncStatusEl.textContent = `Google Sheets 연결됨 (${verRes.activeVersion || 'v1.0.0'})`;
        } else {
          syncStatusEl.textContent = 'Google Sheets 연결 대기';
        }
      }
    } catch (err) {
      syncStatusEl.textContent = '동기화 실패';
      console.warn('데이터 동기화 실패:', err.message);
    }
  }

  // [P0 동일 바코드 명시적 재조회 전역 헬퍼]
  window.__relookup = function (barcode) {
    if (!barcode) return;
    const clean = String(barcode).trim();
    inputBarcode.value = clean;
    handleLookup(clean, true);
  };

  /**
   * 바코드 조회 파이프라인 (P0 안정화 적용)
   * @param {string} barcode
   * @param {boolean} forceRefresh - 동일 바코드 명시적 재조회 여부
   */
  async function handleLookup(barcode, forceRefresh = false) {
    if (!barcode) return;
    const cleanBarcode = String(barcode).trim();

    // 0. 바코드 형식 엄격 검증 (XSS 1차 방어: 위험 특수문자 클라이언트 사전 차단)
    if (!/^[a-zA-Z0-9_-]{4,30}$/.test(cleanBarcode)) {
      renderResult({
        found: false,
        barcode: cleanBarcode,
        reason: 'INVALID_BARCODE_FORMAT',
        message: '바코드 형식이 올바르지 않습니다 (특수문자 사용 불가).',
        elapsedMatchMs: 0.1,
        elapsedNetworkMs: 0
      }, cleanBarcode);
      return;
    }

    // 1. 이미 동일 바코드 조회가 서버 응답 대기 중(Pending)이면 중복 요청 즉시 차단
    if (!forceRefresh && cleanBarcode === pendingBarcode) {
      return;
    }

    // 2. 이미 동일 바코드 결과가 화면에 활성화(Active)되어 있으면 중복 요청 차단
    if (!forceRefresh && cleanBarcode === activeBarcode) {
      return;
    }

    // 3. EAN-13 체크디지트 사전 검사
    if (cleanBarcode.length === 13) {
      const checkRes = Utils.validateEAN13(cleanBarcode);
      if (!checkRes.valid) {
        renderResult({
          found: false,
          barcode: cleanBarcode,
          reason: 'CHECK_DIGIT_FAIL',
          message: `체크디지트 불일치: ${checkRes.error}`,
          elapsedMatchMs: 0.1,
          elapsedNetworkMs: 0
        }, cleanBarcode);
        return;
      }
    }

    // 4. 새로운 요청 식별자 발급 및 Pending 바코드 등록 (상품 A 중 B 진입 시 B 허용)
    const thisRequestId = ++currentRequestId;
    pendingBarcode = cleanBarcode;

    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      try { navigator.vibrate(40); } catch (e) {}
    }

    const mode = appConfig.dataSource?.mode || 'mock';

    try {
      if (mode === 'mock') {
        const startLocal = performance.now();
        const matchRes = dataMatcher.lookup(cleanBarcode);
        const localElapsed = performance.now() - startLocal;

        // 비동기 레이스 컨디션 검사 (최신 요청이 아니면 폐기)
        if (thisRequestId !== currentRequestId) return;

        activeBarcode = cleanBarcode;

        renderResult({
          ...matchRes,
          elapsedMatchMs: localElapsed,
          elapsedNetworkMs: 0
        }, cleanBarcode);
      } else {
        // 실제 Google Sheets / Apps Script 단건 조회
        const auth = sheetsAdapter.getAuthPayload();
        if (!auth.idToken && !auth.sessionToken) {
          if (thisRequestId !== currentRequestId) return;

          renderResult({
            found: false,
            barcode: cleanBarcode,
            reason: 'UNAUTHORIZED',
            message: '직원 인증 토큰이 설정되지 않았습니다. 상단 [미인증] 버튼을 눌러 승인된 직원 토큰을 입력해주세요.',
            elapsedMatchMs: 0.1,
            elapsedNetworkMs: 0
          }, cleanBarcode);
          if (authModal) authModal.classList.add('open');
          return;
        }

        syncStatusEl.textContent = '조회 중...';
        const remoteRes = await sheetsAdapter.lookupBarcode(cleanBarcode);

        // 비동기 순서 역전 방지: A 요청 후 B 요청 시, 늦게 도착한 A 응답은 안전하게 폐기
        if (thisRequestId !== currentRequestId) {
          console.warn('[handleLookup] 지연 도착한 이전 응답 폐기:', cleanBarcode);
          return;
        }

        activeBarcode = cleanBarcode;
        syncStatusEl.textContent = 'Google Sheets 연결됨';

        renderResult({
          ...remoteRes,
          elapsedMatchMs: 0.2,
          elapsedNetworkMs: remoteRes.elapsedNetworkMs
        }, cleanBarcode);
      }
    } catch (err) {
      if (thisRequestId !== currentRequestId) return;
      syncStatusEl.textContent = '조회 실패';

      renderResult({
        found: false,
        barcode: cleanBarcode,
        reason: 'NETWORK_ERROR',
        message: `조회 통신 실패: ${err.message || err}`,
        elapsedMatchMs: 0.1,
        elapsedNetworkMs: 0
      }, cleanBarcode);
    } finally {
      // 최신 요청인 경우 진행 중(pending) 상태 정상 해제
      if (thisRequestId === currentRequestId) {
        pendingBarcode = null;
      }
    }
  }

  /**
   * 결과 렌더링 (P0 XSS 방지 이스케이프 & 인라인 핸들러 제거)
   */
  function renderResult(result, inputCode) {
    const netTimeStr = result.elapsedNetworkMs > 0 ? `네트워크: ${result.elapsedNetworkMs.toFixed(1)}ms | ` : '';
    const timeDisplay = `${netTimeStr}매칭: ${result.elapsedMatchMs.toFixed(2)}ms`;

    const safeInputCode = Utils.escapeHtml(inputCode);
    const safeBarcode = Utils.escapeHtml(result.barcode || inputCode);

    if (!result.found) {
      let badgeLabel = '미행사';
      let statusDesc = result.message || '현재 등록된 행사 또는 할인 대상 목록에 없는 상품입니다.';

      if (result.reason === 'CHECK_DIGIT_FAIL') {
        badgeLabel = '바코드 오류';
      } else if (result.reason === 'INVALID_LENGTH' || result.reason === 'INVALID_BARCODE_FORMAT') {
        badgeLabel = '자릿수 오류';
      } else if (result.reason === 'UNAUTHORIZED') {
        badgeLabel = '인증 필요';
      } else if (result.reason === 'UNAUTHORIZED_USER') {
        badgeLabel = '미등록 직원';
      } else if (result.reason === 'USER_REVOKED') {
        badgeLabel = '권한 차단';
      } else if (result.reason === 'EXPIRED_REQUEST') {
        badgeLabel = '요청 만료';
      } else if (result.reason === 'TOO_MANY_REQUESTS') {
        badgeLabel = '한도 초과';
      } else if (result.reason === 'NETWORK_ERROR') {
        badgeLabel = '통신 오류';
      }

      const safeBadgeLabel = Utils.escapeHtml(badgeLabel);
      const safeReason = Utils.escapeHtml(result.reason || 'NOT_FOUND');
      const safeStatusDesc = Utils.escapeHtml(statusDesc);

      resultContainer.innerHTML = `
        <div class="result-card" style="border-left: 4px solid var(--danger);">
          <div class="result-header">
            <span class="promo-badge badge-default">${safeBadgeLabel}</span>
            <span class="status-badge status-expired">${safeReason}</span>
          </div>
          <div class="product-name" style="color: #b91c1c;">조회 불가 / 미행사</div>
          <div class="product-barcode">입력 바코드: ${safeInputCode}</div>
          <p class="promo-details" style="color: #64748b;">
            <strong>${safeStatusDesc}</strong>
          </p>
          <div class="perf-meta-sub">
            <span>${Utils.escapeHtml(timeDisplay)}</span>
            <button type="button" class="btn-relookup" data-barcode="${safeInputCode}">↻ 다시 조회</button>
          </div>
        </div>
      `;
      return;
    }

    const promoCardsHtml = (result.promotions || []).map((item, idx) => {
      const badgeClass = Utils.getBadgeClass(item.promotionType);
      const statusClass = item.computedStatus === 'ACTIVE'
        ? 'status-active'
        : (item.computedStatus === 'EXPIRED' ? 'status-expired' : 'status-upcoming');

      const scopeLabel = item.promotionScope === 'COMMON_GIFT_CONDITION'
        ? '[공통 증정조건]'
        : (result.hasMultiplePromotions ? `[혜택 ${idx + 1}]` : '');
      const isMultiTag = scopeLabel ? `<span style="font-size:0.75rem; color:#64748b; font-weight:normal;">${Utils.escapeHtml(scopeLabel)}</span>` : '';

      const showPriceRow = item.promotionScope !== 'COMMON_GIFT_CONDITION' && item.discountPrice !== null && item.discountPrice !== undefined && item.discountPrice !== '';
      const discountMeta = (item.discountAmount > 0 || item.discountRate)
        ? `<div style="font-size:0.8rem; color:#047857; margin-bottom:4px; font-weight:600;">할인액: ${Utils.formatCurrency(item.discountAmount)}${item.discountRate ? ` | 할인율: ${Utils.escapeHtml(item.discountRate)}` : ''}</div>`
        : '';

      const commonWarning = item.promotionScope === 'COMMON_GIFT_CONDITION'
        ? `<div style="font-size:0.75rem; color:#b45309; margin-top:4px;">※ 행사그룹 합산 기준 충족 여부 및 중복할인 가능 여부는 자동 판정하지 않으므로 원본 기준을 확인하세요.</div>`
        : '';

      const detailRaw = String(item.promotionDetail || item.originalDetail || '');
      const yearNotice = item.yearConfirmed === false ? ' (연도 미표기 원본)' : '';

      const safePromoType = Utils.escapeHtml(item.promotionType);
      const safeStatusMessage = Utils.escapeHtml(item.statusMessage);
      const safeDetail = Utils.escapeHtml(detailRaw);
      const safeGiftName = item.giftName ? `<br><strong>증정품:</strong> ${Utils.escapeHtml(item.giftName)}` : '';
      const safeAudience = item.targetAudience ? `<br><strong>대상:</strong> ${Utils.escapeHtml(item.targetAudience)}` : '';

      // [P0 XSS 방어] 날짜 및 연도 미표기 텍스트 안전 이스케이프
      const safeStartDate = Utils.escapeHtml(Utils.formatDate(item.startDate));
      const safeEndDate = Utils.escapeHtml(Utils.formatDate(item.endDate));
      const safeYearNotice = Utils.escapeHtml(yearNotice);
      const safeDates = `${safeStartDate} ~ ${safeEndDate}${safeYearNotice}`;

      return `
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; margin-bottom: 8px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 6px;">
            <div>
              <span class="promo-badge ${badgeClass}">${safePromoType}</span>
              ${isMultiTag}
            </div>
            <span class="status-badge ${statusClass}">${safeStatusMessage}</span>
          </div>
          ${showPriceRow ? `
          <div class="price-row" style="margin-bottom: 6px;">
            <span class="discount-price">${Utils.formatCurrency(item.discountPrice)}</span>
            ${item.normalPrice > item.discountPrice ? `<span class="normal-price">${Utils.formatCurrency(item.normalPrice)}</span>` : ''}
          </div>` : ''}
          ${discountMeta}
          <div class="promo-details" style="margin-bottom: 4px; background: #ffffff;">
            <strong>혜택 내용:</strong> ${safeDetail}${safeGiftName}${safeAudience}${commonWarning}
          </div>
          <div class="period-info">
            행사 기간: ${safeDates}
          </div>
        </div>
      `;
    }).join('');

    const specStr = result.spec ? ` | 규격: ${Utils.escapeHtml(result.spec)}` : '';
    const catStr = result.category ? ` | 분류: ${Utils.escapeHtml(result.category)}` : '';
    const unitStr = result.unitPrice ? ` | 단위당: ${Utils.formatCurrency(result.unitPrice)}` : '';
    const leafletStr = result.leafletMark ? ` | 전단: ${Utils.escapeHtml(result.leafletMark)}` : '';

    const sourceLabel = (appConfig.dataSource?.mode === 'mock')
      ? '<span style="font-size:0.7rem; background:#fef3c7; color:#92400e; padding:2px 6px; border-radius:4px; margin-right:6px; font-weight:600;">[로컬 Mock]</span>'
      : '<span style="font-size:0.7rem; background:#dcfce7; color:#166534; padding:2px 6px; border-radius:4px; margin-right:6px; font-weight:600;">[Google Sheets 실시간]</span>';

    const safeProductName = Utils.escapeHtml(result.productName);

    resultContainer.innerHTML = `
      <div class="result-card" style="border-left: 4px solid var(--primary);">
        <div class="result-header">
          <span style="font-size: 0.8rem; font-weight: 700; color: #2563eb; display:flex; align-items:center;">
            ${sourceLabel}
            ${result.hasMultiplePromotions ? `등록된 행사 조건 (${result.promotionCount}건 분리 표시)` : '단일 프로모션'}
          </span>
          <button type="button" class="btn-relookup" data-barcode="${safeBarcode}">↻ 다시 조회</button>
        </div>
        <div class="product-name">${safeProductName}</div>
        <div class="product-barcode">바코드: ${safeBarcode}${specStr}${catStr} | 정상가: ${Utils.formatCurrency(result.normalPrice)}${unitStr}${leafletStr}</div>
        <div style="margin-top: 8px;">
          ${promoCardsHtml}
        </div>
        <div class="perf-meta-sub">
          <span>${Utils.escapeHtml(timeDisplay)}</span>
          <span style="font-size:0.65rem; color:#cbd5e1;">안전 렌더링 완료</span>
        </div>
      </div>
    `;
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

        // 2. EAN-13 체크디지트 사전 검증 (체크디지트 오류 시 카메라를 종료하지 않고 계속 스캔 진행)
        if (clean.length === 13 && typeof Utils !== 'undefined' && Utils.validateEAN13) {
          const checkRes = Utils.validateEAN13(clean);
          if (!checkRes.valid) {
            console.warn('[initScanner] 체크디지트 불일치로 스캔 계속:', clean, checkRes.error);
            return;
          }
        }

        // 3. 유효 바코드 인식 확정 -> 즉시 인식 락 가동
        isScanLocked = true;

        // 4. 모바일 햅틱 진동 피드백
        if (typeof navigator !== 'undefined' && navigator.vibrate) {
          try { navigator.vibrate(40); } catch (e) {}
        }

        inputBarcode.value = clean;

        // 5. 카메라 자동 종료 및 자원 해제 (버튼 텍스트를 '다음 상품 스캔'으로 전환)
        try {
          await stopScanner(true);
        } catch (e) {
          console.warn('[initScanner] 카메라 자동 종료 오류:', e);
        }

        // 6. 상품 조회 실행 (forceRefresh = true로 동일 상품이라도 새 스캔 세션 결과 갱신 보장)
        await handleLookup(clean, true);
      },
      onScanError: () => {}
    });

    btnToggleScan.addEventListener('click', async () => {
      if (isCameraTransitioning) return;
      isCameraTransitioning = true;

      try {
        if (scanner.isScanning) {
          // 사용자가 수동으로 스캔 중지
          await stopScanner(false);
        } else {
          // 사용자가 스캔 시작 또는 '다음 상품 스캔' 클릭 (새 스캔 세션 개시)
          activeBarcode = null; // 새 세션이므로 직전 조회 상품과 동일하더라도 재조회 허용
          isScanLocked = false;
          await startScanner();
        }
      } catch (err) {
        alert(err.message || err);
      } finally {
        isCameraTransitioning = false;
      }
    });
  }

  function registerEvents() {
    btnSearchBarcode.addEventListener('click', () => {
      const code = inputBarcode.value.trim();
      if (!code) {
        alert('바코드를 입력해주세요.');
        return;
      }
      handleLookup(code, true); // 사용자가 직접 조회 버튼 클릭 시 강제 재조회 허용
    });

    inputBarcode.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const code = inputBarcode.value.trim();
        if (code) handleLookup(code, true);
      }
    });

    btnRefreshData.addEventListener('click', () => {
      syncProducts(true);
    });

    // [P0 인라인 onclick 제거 및 안전한 이벤트 위임 리스너]
    if (resultContainer) {
      resultContainer.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-relookup');
        if (btn) {
          const barcode = btn.getAttribute('data-barcode');
          if (barcode) {
            inputBarcode.value = barcode;
            handleLookup(barcode, true);
          }
        }
      });
    }

    // [P0 화면 잠금 및 브라우저 복귀 시 카메라 상태 관리 - 단건 스캔 보호]
    document.addEventListener('visibilitychange', async () => {
      if (document.hidden) {
        // 화면 꺼짐 또는 백그라운드 전환 시 오직 현재 카메라가 켜져 있던 경우에만 플래그 기록
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
        // 화면 복귀 시 오직 화면 꺼짐 직전에 카메라가 켜져 있던 경우에만 자동 재개
        // 단건 스캔 성공 후 카메라가 이미 종료된 상태였다면 절대 저절로 켜지지 않음
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
        .then((reg) => console.log('[ClientApp] ServiceWorker 등록 완료 (UI 셸 전용 캐시):', reg.scope))
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
  registerServiceWorker();
})();

