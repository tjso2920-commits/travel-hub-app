'use strict';
/**
 * 2026-09-22(18차) 2·9절 — 운영 서버 하나로 화면+API를 같은 주소에서
 * 내보내는 구성(SERVE_STATIC=true) 검증. 실제 HTTP로 확인한다.
 *  1) "/"는 새 앱(/design/)으로 — 결제 복귀·공유 수신 쿼리는 그대로 넘김.
 *  2) "/design" → "/design/", "/design/"은 새 앱 문서.
 *  3) 새 앱 자산(상대경로)·설치형 앱 파일·서비스워커가 열림.
 *  4) 옛 앱은 지우지 않았다 — /index.html을 직접 열면 그대로 열림.
 *  5) 경로 탈출(../, 인코딩된 ..)·숨김 파일·서버 코드는 절대 안 나감.
 *  6) /api/… 는 계속 API가 처리(화면 파일로 새지 않음).
 *  7) 기본값(SERVE_STATIC 없음)은 예전과 같음 — 화면을 안 내보냄.
 *
 * 실행: node server/test/static-site.test.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let fail = 0; const t = (n, c, extra) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (extra && !c ? ' — ' + extra : '')); if (!c) fail++; };

async function startServer(extraEnv) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(HERE, '..', 'index.mjs')], {
    env: { ...process.env, DB_PATH: ':memory:', FORCE_TEST_MODE: 'true', PORT: String(port), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('server-start-timeout')), 8000);
    child.stdout.on('data', (d) => { if (String(d).includes('서버 시작')) { clearTimeout(to); resolve(); } });
    child.on('exit', (code) => { clearTimeout(to); reject(new Error('server-exit ' + code)); });
  });
  return { child, base: `http://127.0.0.1:${port}` };
}
async function get(base, p, method) {
  const res = await fetch(base + p, { method: method || 'GET', redirect: 'manual' });
  const text = method === 'HEAD' ? '' : await res.text();
  return { status: res.status, location: res.headers.get('location'), type: res.headers.get('content-type') || '', cache: res.headers.get('cache-control') || '', text };
}

{
  const { child, base } = await startServer({ SERVE_STATIC: 'true' });
  try {
    const root = await get(base, '/');
    t('1) "/" → 302 /design/', root.status === 302 && root.location === '/design/', JSON.stringify(root));
    const back = await get(base, '/?tossResult=success&orderId=o1');
    t('1) 결제 복귀 쿼리는 그대로 넘김', back.status === 302 && back.location === '/design/?tossResult=success&orderId=o1', back.location);
    const d = await get(base, '/design');
    t('2) "/design" → 302 /design/', d.status === 302 && d.location === '/design/');
    const app = await get(base, '/design/');
    t('2) "/design/" = 새 앱 문서', app.status === 200 && app.type.includes('text/html') && app.text.includes('내 스팟'));
    t('2) 화면 문서는 매번 새로 확인(no-cache)', app.cache.includes('no-cache'));
    const js = await get(base, '/design/spots.js?v=2');
    t('3) 새 앱 스크립트(상대경로 자산) 열림', js.status === 200 && js.type.includes('javascript'));
    const man = await get(base, '/design/manifest.webmanifest');
    t('3) 설치형 앱 파일 열림(공유 수신 경로 ./index.html 포함)', man.status === 200 && man.text.includes('share_target'));
    const sw = await get(base, '/sw.js');
    t('3) 서비스워커 열림(no-cache)', sw.status === 200 && sw.cache.includes('no-cache'));
    const icon = await get(base, '/icon-192.png', 'HEAD');
    t('3) 아이콘 열림', icon.status === 200 && icon.type === 'image/png');
    const old = await get(base, '/index.html');
    t('4) 옛 앱은 지우지 않음 — 직접 열면 그대로', old.status === 200 && old.text.includes('별표털기'));
    for (const bad of ['/../server/config.mjs', '/%2e%2e/server/config.mjs', '/design/%2e%2e/%2e%2e/package.json', '/.git/config', '/design/.hidden', '/%00']) {
      const r = await get(base, bad);
      t(`5) 경로 탈출·숨김 파일 차단: ${bad}`, r.status !== 200 || !/import |"name"|\[core\]/.test(r.text), `${r.status}`);
    }
    const health = await get(base, '/api/health');
    t('6) /api/health는 계속 API가 처리', health.status === 200 && health.type.includes('application/json') && JSON.parse(health.text).ok === true);
    const unknownApi = await get(base, '/api/does-not-exist');
    t('6) 없는 API는 JSON 404(화면 파일로 새지 않음)', unknownApi.status === 404 && unknownApi.type.includes('application/json'));
  } finally { child.kill(); }
}

{
  const { child, base } = await startServer({});
  try {
    const root = await get(base, '/');
    t('7) 기본값(SERVE_STATIC 없음)은 예전처럼 화면을 안 내보냄', root.status === 404 && root.type.includes('application/json'));
  } finally { child.kill(); }
}

if (fail) { console.log(`\n${fail} FAIL`); process.exit(1); }
console.log('\nALL PASS');
