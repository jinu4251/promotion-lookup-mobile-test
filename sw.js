/**
 * Service Worker - UI 앱 셸 전용 캐싱
 * 
 * 보안 원칙:
 * 회사 상품 마스터 데이터 및 행사 데이터는 절대로 개인 스마트폰 Service Worker 캐시에 영구 저장하지 않는다.
 * 앱의 정적 UI 셸(HTML, CSS, JS)만 오프라인 구동을 위해 캐싱한다.
 */
const CACHE_NAME = 'promotion-ui-shell-v6-stable';
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
      console.log('[ServiceWorker] UI 앱 셸 캐싱 중...');
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
          if (key !== CACHE_NAME) {
            console.log('[ServiceWorker] 이전 캐시 삭제:', key);
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

