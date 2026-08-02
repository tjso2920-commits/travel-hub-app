/**
 * 오프라인 캐시.
 * 앱은 외부 리소스가 없는 단일 HTML이라, 문서 하나만 확실히 캐시하면 오프라인에서 완전히 동작한다.
 * 여행지에서 데이터가 끊겨도 앱이 열려야 하므로 문서 요청은 캐시를 우선한다.
 *
 * 앱을 새로 배포할 때 CACHE 값을 반드시 올린다. 올리지 않으면 사용자가 옛 버전을 계속 본다.
 */
const CACHE = 'travel-hub-v50';
/* 앱 본체는 반드시 담겨야 한다. 나머지는 있으면 좋은 것들이다. */
const CORE = ['./index.html'];
const EXTRA = ['./', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      /* addAll 은 **하나라도 실패하면 전부 안 담긴다.**
         파일 하나가 404 이거나 넣는 도중 잠깐 끊기면 캐시가 통째로 비고,
         그러면 오프라인이 죽는데 사용자에게는 아무 신호가 없다.
         그래서 하나씩 담는다 — 하나가 실패해도 나머지는 남는다. */
      await Promise.all(CORE.map((u) => cache.add(u)));
      await Promise.all(EXTRA.map((u) => cache.add(u).catch(() => {})));
      return self.skipWaiting();
    }).catch(() => self.skipWaiting())
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
    // 캐시 우선 — 비행기 안에서도 열려야 한다. 네트워크가 되면 뒤에서 조용히 갱신한다.
    event.respondWith(
      caches.match('./index.html').then((cached) => {
        /* 화면에 넘긴 응답은 본문을 다시 못 읽는다(한 번만 읽힌다).
           비교에 쓸 몫은 **넘기기 전에** 따로 떠 둬야 한다. */
        const forCompare = cached ? cached.clone() : null;
        const network = fetch(request)
          .then((response) => {
            if (!response || !response.ok) return response;
            const forCache = response.clone();
            const forDiff = response.clone();
            /* 받아온 것이 지금 보여주고 있는 것과 다르면 = 새 버전이 올라온 것이다.
               캐시 우선이라 사용자는 지금 화면에서 **옛 버전을 보고 있다.**
               그냥 두면 다음에 열 때까지 모른다 — 알려 주고 한 번에 새로고침하게 한다. */
            if (forCompare) {
              Promise.all([forCompare.text(), forDiff.text()])
                .then(([a, b]) => {
                  if (a === b) return;
                  return self.clients
                    .matchAll({ type: 'window' })
                    .then((cs) => cs.forEach((c) => c.postMessage({ type: 'newVersion' })));
                })
                .catch(() => {}); /* 비교에 실패해도 앱은 그대로 돌아야 한다 */
            }
            caches.open(CACHE).then((cache) => cache.put('./index.html', forCache));
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
