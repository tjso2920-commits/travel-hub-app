import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * 2026-09-12 재검토(15차) 3절 — 이 파일은 예전(이 저장소가 다른 개인
 * 프로젝트였던 시절) `01_SOURCE/커팅트래커_개인용.html` 등 지금은 존재
 * 하지 않는 파일을 가리키고 있었다 — 즉 `npm run preview`는 오래전부터
 * 실행하면 항상 404만 내는 죽은 명령이었다. 지금의 실제 프런트엔드
 * (`src/design/index.html` 등)를 정적으로 서빙하고, `/api/`로 시작하는
 * 요청은 실제 API 서버(`node server/index.mjs`)로 그대로 중계(proxy)
 * 하도록 다시 만들었다 — 폰 브라우저가 주소 하나만 열면 프런트와 API가
 * 같은 원본(origin)으로 보이게 하기 위해서다(각 프런트 JS는
 * `window.API_BASE`가 없으면 상대 경로로 `/api/...`를 부르므로, 이렇게
 * 같은 origin으로 묶으면 프런트 코드를 전혀 안 건드려도 된다).
 *
 * 이 서버 자체는 테스트 환경 준비용 도구다 — 운영(실제 손님) 배포에는
 * 쓰지 않는다(HTTPS·정적 자산 캐시·리버스 프록시 등은 실제 배포 환경의
 * 몫이다. `docs/OPERATIONS_SETUP.md` 참고).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', 'src');
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const API_PROXY_TARGET = process.env.API_PROXY_TARGET || 'http://127.0.0.1:8787';

/*
 * 2026-09-12 재검토(15차) 2절 — ChatGPT가 실제 HTTP로 확인해 지적한
 * 버그: '/'와 '/design'에서 design/index.html의 "내용"만 그대로
 * 돌려줬는데, 그 HTML 안의 상대경로(`spots.css`, `spots.js` 등)는
 * 브라우저가 "지금 주소 기준"으로 해석한다 — 주소가 '/'면
 * `/spots.css`를 찾으러 가서 404가 난다(실제로 `/design/`에서 열면
 * 같은 파일이 `/design/spots.css`로 정상 로딩됨). 파일 내용만 맞춰
 * 돌려주는 방식으로는 못 고친다 — 브라우저 주소 자체를
 * `/design/`으로 리다이렉트해서 상대경로 기준을 실제 파일 위치와
 * 통일한다.
 */
const redirects = new Map([
  ['/', '/design/'],
  ['/design', '/design/']
]);

const aliases = new Map([
  ['/design/', 'design/index.html']
]);

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

function safeFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const alias = aliases.get(clean);
  const relative = (alias || clean).replace(/^\/+/, '');
  const candidate = path.resolve(ROOT, relative);
  return candidate === ROOT || candidate.startsWith(`${ROOT}${path.sep}`) ? candidate : null;
}

function proxyToApi(request, response) {
  const target = new URL(request.url, API_PROXY_TARGET);
  const upstream = http.request(
    target,
    { method: request.method, headers: { ...request.headers, host: target.host } },
    (upstreamRes) => {
      response.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(response);
    }
  );
  upstream.on('error', () => {
    response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ ok: false, reason: 'api-proxy-unreachable', target: API_PROXY_TARGET }));
  });
  request.pipe(upstream);
}

function serveStatic(request, response) {
  let file;
  try {
    file = safeFile(request.url || '/');
  } catch {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('잘못된 요청');
    return;
  }

  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('파일을 찾을 수 없습니다');
    return;
  }

  response.writeHead(200, {
    'Content-Type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  fs.createReadStream(file).pipe(response);
}

const server = http.createServer((request, response) => {
  const pathname = (request.url || '/').split('?')[0];
  if (pathname.startsWith('/api/')) {
    proxyToApi(request, response);
    return;
  }
  const redirectTo = redirects.get(pathname);
  if (redirectTo) {
    response.writeHead(302, { Location: redirectTo });
    response.end();
    return;
  }
  serveStatic(request, response);
});

server.listen(PORT, HOST, () => {
  console.log(`프런트(테스트용): http://${HOST}:${PORT}/  (자동으로 /design/으로 이동합니다)`);
  console.log(`같은 주소의 /api/*는 ${API_PROXY_TARGET}(으)로 중계됩니다 — 먼저 그 주소에서 API 서버(node server/index.mjs)를 띄워 두세요.`);
  console.log('종료: Ctrl+C');
});
