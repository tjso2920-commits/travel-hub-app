/**
 * 오프라인 캐시.
 * 앱은 외부 리소스가 없는 단일 HTML이라, 문서 하나만 확실히 캐시하면 오프라인에서 완전히 동작한다.
 * 여행지에서 데이터가 끊겨도 앱이 열려야 하므로 문서 요청은 캐시를 우선한다.
 *
 * 앱을 새로 배포할 때 CACHE 값을 반드시 올린다. 올리지 않으면 사용자가 옛 버전을 계속 본다.
 */
const CACHE = 'travel-hub-v57';
/* 앱 본체는 반드시 담겨야 한다. 나머지는 있으면 좋은 것들이다.
   2026-09-21(17차) 3절 — 디자인 앱(src/design/index.html)이 이 SW를
   부모 스코프(../sw.js)로 재사용해 설치형 PWA(공유 수신 전제조건)가
   되면서 그 문서도 함께 담는다.
   2026-09-21(17차 2차 독립검토) — 여기 담기는 건 "문서(HTML) 한 장"
   뿐이다. 디자인 앱은 옛 앱과 달리 spots.js·spots.css·
   import-adapter.js 등 별도 파일로 나뉘어 있고 그 파일들은 이 목록에
   없다 — 그래서 디자인 앱은 "문서 하나만 캐시하면 완전히 오프라인
   동작"하지 않는다(오프라인에서 문서 자체는 뜨지만, 그 안의 스크립트·
   스타일은 네트워크가 없으면 못 받아온다). 완전 오프라인 지원은 이번
   범위가 아니다 — 이번엔 아래 문서 캐시 "쓰기 경로" 버그만 고친다. */
const CORE = ['./index.html', './design/index.html'];
const EXTRA = ['./', './manifest.webmanifest', './icon-192.png', './icon-512.png', './design/manifest.webmanifest'];

/* 2026-09-21(17차 3차 독립검토) 2절 — 재현된 버그: 예전엔 "네비게이션이면
   전부 앱 문서"로 취급해, /api/health 처럼 같은 origin의 JSON API를
   주소창에 직접 열어도(진짜 방문 가능성 있음 — 디버깅 등) 이 로직을
   그대로 타서 그 JSON 응답이 ./index.html 캐시에 그대로 덮어써졌다.
   실제 두 앱의 진입 경로만 정확히 나열해 그 목록에 있을 때만 "앱
   문서 캐시" 대상으로 삼는다 — 그 외 경로는(네비게이션이어도) 아래
   일반 통과 경로로 넘어가 캐시를 전혀 안 건드리고 그대로 응답한다. */
/* 2026-09-22(출시 전 최종검수) — 경로를 '/design/index.html'처럼 절대경로로
   고정하면, 이 앱이 사이트 루트가 아니라 하위 경로에 통째로 올라가는
   배포(예: GitHub Pages 프로젝트 사이트 https://…/<repo>/…)에서는 어느
   것도 안 맞아 앱 문서 캐시 갱신 경로가 조용히 죽는다. 이 서비스워커
   파일 자신의 위치를 기준(self.location)으로 잡아 어느 배포 형태에서도
   같게 동작하게 한다 — 캐시 키('./index.html')도 원래 같은 기준으로
   풀리므로 둘의 기준이 일치한다. */
const SCOPE_PATH = self.location.pathname.replace(/[^/]*$/, ''); // 예: '/' 또는 '/travel-hub-app/'
const APP_DOC_ROUTES = [
  // 루트 주소는 "어느 앱을 보여줄지"를 이 서비스워커가 단정할 수 없다 —
  // 배포에 따라 옛 앱을 그대로 주기도 하고(GitHub Pages), 디자인 앱으로
  // 리디렉션하기도 한다(문서에 적힌 폰 테스트 구성 scripts/serve.mjs).
  // 그래서 루트만 네트워크 우선으로 두고(호스트 판단을 그대로 따름),
  // 네트워크가 안 될 때만 캐시로 떨어진다. 재현된 문제: 캐시 우선으로
  // 두면 서비스워커 설치 뒤 폰에서 루트 주소를 열 때 리디렉션을 무시하고
  // 캐시된 옛 앱이 떠서 "새 앱이 안 열린다"가 된다.
  { paths: [SCOPE_PATH], key: './index.html', strategy: 'network-first' },
  { paths: [`${SCOPE_PATH}index.html`], key: './index.html', strategy: 'cache-first' },
  { paths: [`${SCOPE_PATH}design`, `${SCOPE_PATH}design/`, `${SCOPE_PATH}design/index.html`], key: './design/index.html', strategy: 'cache-first' },
];
function appDocRouteFor(pathname) {
  return APP_DOC_ROUTES.find((r) => r.paths.includes(pathname)) || null;
}
/* 배경 갱신 응답을 캐시에 써도 되는 조건 — 정상 HTML 응답만. 상태가
   실패거나, 도중에 다른 곳으로 리디렉션됐거나(리디렉션으로 엉뚱한
   페이지가 온 경우 오염 방지), 같은 origin이 아니거나, Content-Type이
   text/html이 아니면 전부 거부한다(캐시를 안 건드리고 응답만 그대로
   돌려줌). */
function isCacheableAppDoc(response) {
  if (!response || !response.ok) return false;
  if (response.redirected) return false;
  let responseUrl;
  try { responseUrl = new URL(response.url); } catch (e) { return false; }
  if (responseUrl.origin !== self.location.origin) return false;
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  return contentType.includes('text/html');
}

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
  // 네비게이션이라고 전부 "앱 문서"가 아니다 — 실제 두 앱의 진입
  // 경로일 때만 라우트가 나온다(그 외엔 null — 아래에서 일반 통과
  // 경로로 넘어간다).
  const docRoute = isDocument ? appDocRouteFor(url.pathname) : null;
  const docKey = docRoute ? docRoute.key : null;

  if (docRoute && docRoute.strategy === 'network-first') {
    // 루트 주소 — 호스트가 실제로 무엇을 주는지(옛 앱이든, 디자인 앱으로의
    // 리디렉션이든)를 그대로 따른다. 네트워크가 안 될 때만 캐시로 떨어져
    // 비행기 모드에서도 뭔가는 열리게 한다.
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (isCacheableAppDoc(response)) {
            const forCache = response.clone();
            caches.open(CACHE).then((cache) => cache.put(docKey, forCache));
          }
          return response;
        })
        .catch(() => caches.match(docKey))
    );
    return;
  }

  if (docKey) {
    // 캐시 우선 — 비행기 안에서도 열려야 한다. 네트워크가 되면 뒤에서 조용히 갱신한다.
    event.respondWith(
      caches.match(docKey).then((cached) => {
        /* 화면에 넘긴 응답은 본문을 다시 못 읽는다(한 번만 읽힌다).
           비교에 쓸 몫은 **넘기기 전에** 따로 떠 둬야 한다. */
        const forCompare = cached ? cached.clone() : null;
        const network = fetch(request)
          .then((response) => {
            // 2026-09-21(17차 3차 독립검토) 2절 — 정상 HTML 응답일 때만
            // 캐시를 건드린다. 실패·리디렉션·비HTML 응답은 그대로
            // 돌려주기만 하고 캐시는 절대 안 쓴다(옛/새 앱 캐시가
            // 엉뚱한 내용으로 덮어써지는 걸 막는다).
            if (!isCacheableAppDoc(response)) return response;
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
            caches.open(CACHE).then((cache) => cache.put(docKey, forCache));
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
