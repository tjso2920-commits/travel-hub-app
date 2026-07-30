/**
 * 오프라인 캐시.
 * 앱은 외부 리소스가 없는 단일 HTML이라, 문서 하나만 확실히 캐시하면 오프라인에서 완전히 동작한다.
 * 여행지에서 데이터가 끊겨도 앱이 열려야 하므로 문서 요청은 캐시를 우선한다.
 *
 * 앱을 새로 배포할 때 CACHE 값을 반드시 올린다. 올리지 않으면 사용자가 옛 버전을 계속 본다.
 */
const CACHE = 'travel-hub-v7';
const SHELL = ['./', './index.html', './manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // 구글 지도·Places·Gemini 등 외부 호출은 절대 가로채지 않는다. 캐시된 낡은 응답이 더 해롭다.
  if (url.origin !== self.location.origin) return;

  const isDocument = request.mode === 'navigate' || request.destination === 'document';

  if (isDocument) {
    // 캐시 우선. 네트워크가 되면 뒤에서 조용히 갱신한다.
    event.respondWith(
      caches.match('./index.html').then((cached) => {
        const network = fetch(request)
          .then((response) => {
            if (response && response.ok) {
              const copy = response.clone();
              caches.open(CACHE).then((cache) => cache.put('./index.html', copy));
            }
            return response;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).catch(() => cached))
  );
});
