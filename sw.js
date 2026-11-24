/**
 * Service Worker - UI 앱 셸 전용 캐싱 (PWA v12 Phase K-1)
 * 
 * 보안 원칙:
 * 회사 상품 마스터 데이터 및 행사 데이터는 절대로 개인 스마트폰 Service Worker 캐시에 영구 저장하지 않는다.
 * 앱의 정적 UI 셸(HTML, CSS, JS)만 오프라인 구동 및 신속한 렌더링을 위해 캐싱한다.
 */
const CACHE_NAME = 'test-promotion-ui-shell-v12-phase-k1';

/**
 * 무결성 보장 캐시 격리 정책 (Zero-Collision Cache Isolation Policy)
 * 
 * 1. 조사 결과:
 *    - 과거 v1~v7 배포본은 master 브랜치와 TEST 브랜치 모두 'promotion-ui-shell-v1~v7' 명칭을 공유했음.
 *    - 따라서 'promotion-ui-shell-v1~v7'은 TEST 전용 소유권이 불명확하며, 혹시 모를 PROD 또는 공유 캐시 충돌 방지를 위해 절대 삭제하지 않고 보존함.
 * 2. 안전 조치:
 *    - TEST PWA는 'test-promotion-ui-shell-*' 고유 네임스페이스로 완전 분리.
 *    - 삭제 대상은 TEST 전용 소유가 100% 입증된 기존 TEST v11, v10, v9 캐시 및 v8-phase-h 캐시로 엄격히 한정.
 *    - 그 외의 모든 캐시(v1~v7, PROD 캐시, 타 앱 캐시, 소유 불명확 캐시)는 100% 영구 보존.
 */
const TEST_CONFIRMED_LEGACY_CACHES = [
  'test-promotion-ui-shell-v11-phase-i2-hotfix',
  'test-promotion-ui-shell-v10-phase-i2',
  'test-promotion-ui-shell-v9-phase-h2',
  'promotion-ui-shell-v8-phase-h'
];

const UI_SHELL_ASSETS = [
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './shared/data-matcher.js',
  './shared/sheets-api.js',
  './shared/scanner-engine.js',
  './shared/utils.js'
  // mock_products.json 및 CSV 등 데이터 파일은 의도적으로 제외 (보안 준수)
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[ServiceWorker] TEST UI 앱 셸 캐싱 중 (v12)...');
      return cache.addAll(UI_SHELL_ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keyList) => {
      return Promise.all(
        keyList.map((key) => {
          // 보안 및 격리: TEST 전용 소유가 100% 확인된 레거시 캐시만 안전하게 삭제
          // master/PROD와 공유되었던 v1~v7 및 PROD 캐시, 타 앱 캐시는 무조건 보존
          if (TEST_CONFIRMED_LEGACY_CACHES.includes(key) && key !== CACHE_NAME) {
            console.log('[ServiceWorker] TEST 전용 확인된 레거시 캐시 삭제:', key);
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // 데이터 API 요청(Google Sheets, Apps Script, /data/ 경로)은 네트워크 직접 요청 (캐시 불허)
  if (url.pathname.includes('/data/') || url.hostname.includes('script.google.com') || url.hostname.includes('sheets.googleapis.com')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // UI 정적 파일은 네트워크 우선, 실패 시 캐시 fallback
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
