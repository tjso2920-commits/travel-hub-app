/**
 * 17차 2차 독립검토 2절 — 실제 서비스워커(src/sw.js) 캐시 동작 검증.
 *
 * 재현된 버그(2차): 문서 캐시를 "읽을" 때는 요청 경로(docKey)를 보고
 * 옛 앱(./index.html)과 디자인 앱(./design/index.html)을 구분했지만,
 * 백그라운드 갱신 결과를 "쓸" 때는 여전히 무조건 './index.html'에만
 * 썼다 — 디자인 앱을 열어 보기만 해도(온라인 상태에서) 조용히 옛 앱의
 * 캐시가 디자인 앱 내용으로 덮어써지는 실제 데이터 오염 버그였다.
 *
 * 재현된 버그(3차) — 2차 수정 이후에도 남음: "네비게이션이면 전부 앱
 * 문서"로 취급해 response.ok만 봤다. /api/health처럼 같은 origin의
 * JSON API를 네비게이션으로 열어도(주소창에 직접 입력 등) 그 JSON이
 * 그대로 ./index.html 캐시에 기록됐다. 실제 앱 진입 경로 목록에 있을
 * 때만 캐시 대상으로 좁히고, 정상 HTML 응답(리디렉션 아님·같은
 * origin·Content-Type text/html)일 때만 캐시를 쓰도록 고쳤다.
 *
 * file://로는 서비스워커 등록 자체가 안 되므로(이 세션이 이전에
 * file://로만 검증하고 "실사용 가능"이라 적었던 것 자체가 부정확했다),
 * 여기서는 실제 localhost HTTP 서버 위에서 진짜 서비스워커를 등록해
 * 확인한다.
 *
 * 실행: node scripts/test-service-worker-cache.mjs
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

const ROOT = path.resolve(process.cwd(), 'src');
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.png': 'image/png', '.woff2': 'font/woff2' };
// 2절 지적 사항 검증용 — 특정 요청 하나만 골라 다른 응답으로 바꿔치기(새
// 배포 시뮬레이션·오류 응답·비HTML 응답·잘못된 리디렉션 시뮬레이션)할
// 수 있게 훅을 둔다. 평소엔 실제 파일을 그대로 서빙하는 순수 정적
// 서버다(serve.mjs와 같은 safeFile 방식 — API 프록시는 이 검증에
// 필요 없어 뺐다).
let override = null; // { path, status?, body?, contentType?, redirectTo? } | null
function safeFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const relative = clean.replace(/^\/+/, '');
  const candidate = path.resolve(ROOT, relative);
  return candidate === ROOT || candidate.startsWith(`${ROOT}${path.sep}`) ? candidate : null;
}
const server = http.createServer((req, res) => {
  const pathname = (req.url || '/').split('?')[0];
  // 실제 재현(3차) 그대로 — 같은 origin의 JSON API를 네비게이션으로
  // 직접 열 수 있는 실제 엔드포인트. 앱 문서가 아니므로 캐시 대상이면
  // 절대 안 된다.
  if (pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (override && override.path === pathname) {
    if (override.redirectTo) {
      res.writeHead(302, { Location: override.redirectTo, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    res.writeHead(override.status || 200, { 'Content-Type': override.contentType || 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(override.body);
    return;
  }
  const file = safeFile(pathname);
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const CLASSIC_MARK = '별표털기';
const DESIGN_MARK = '내 스팟';

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await b.newContext();
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
page.on('dialog', (d) => d.dismiss());

// 캐시 안 요청은 절대경로로 저장돼 있다(서비스워커 안에서
// self.location, 즉 스크립트 자기 자신의 위치 기준으로 상대경로를
// 풀기 때문 — 이 스크립트는 항상 루트(/sw.js)에 있으므로 './index.html'
// 은 늘 절대경로 '/index.html'을 뜻한다). 그래서 여기서 조회할 때도
// "지금 보고 있는 페이지 기준 상대경로"가 아니라 절대 URL을 그대로
// 넘긴다 — 안 그러면 디자인 앱 페이지에서 './index.html'을 찾으면
// 그 페이지 기준으로 풀려 엉뚱한 '/design/index.html'을 찾게 된다.
async function cacheEntryText(p, absUrl) {
  return p.evaluate(async (k) => {
    const names = await caches.keys();
    const cacheName = names.find((n) => n.startsWith('travel-hub-'));
    if (!cacheName) return null;
    const cache = await caches.open(cacheName);
    const res = await cache.match(k);
    return res ? await res.text() : null;
  }, absUrl);
}

// =====================================================================
// 준비 — 디자인 앱을 열어 서비스워커를 등록하고 실제로 활성화될 때까지
// 기다린다(등록만 되고 아직 이 페이지를 제어하지 않는 상태와, 실제로
// 제어하는 상태는 다르다 — 아래 검증은 전부 "실제로 제어 중"을 전제로
// 한다).
// =====================================================================
await page.goto(base + '/design/index.html');
await page.evaluate(() => navigator.serviceWorker.ready);
await page.waitForFunction(() => !!navigator.serviceWorker.controller, { timeout: 8000 }).catch(() => {});
const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
t('서비스워커가 실제로 등록되고 이 페이지를 제어함(localhost HTTP)', controlled);

// =====================================================================
// 1) 기존 앱 → 디자인 앱 → 기존 앱 이동 — 매번 올바른 화면이 뜸(캐시
//    오염으로 다른 앱이 뜨지 않음).
// =====================================================================
{
  await page.goto(base + '/index.html');
  const t1 = await page.title();
  t('1) 기존 앱으로 이동하면 기존 앱이 뜸', t1.includes(CLASSIC_MARK));
  await page.goto(base + '/design/index.html');
  const t2 = await page.title();
  t('1) 디자인 앱으로 이동하면 디자인 앱이 뜸', t2.includes(DESIGN_MARK));
  await page.goto(base + '/index.html');
  const t3 = await page.title();
  t('1) 다시 기존 앱으로 이동해도 여전히 기존 앱이 뜸(디자인 앱 내용으로 안 덮임)', t3.includes(CLASSIC_MARK));
}

// =====================================================================
// 재현 핵심 — 디자인 앱을 다시 열어(재방문) 백그라운드 캐시 갱신
// 경로(버그가 있던 그 코드)를 실제로 한 번 통과시킨 뒤, 두 문서의
// 캐시 항목이 서로 안 섞였는지 직접 CacheStorage에서 확인한다.
// =====================================================================
{
  await page.goto(base + '/design/index.html');
  await page.waitForTimeout(400); // 백그라운드 fetch → cache.put이 끝날 시간을 준다.
  const classicCached = await cacheEntryText(page, base + '/index.html');
  const designCached = await cacheEntryText(page, base + '/design/index.html');
  t('재현 핵심) 디자인 앱 재방문 후에도 기존 앱 캐시 항목은 기존 앱 내용 그대로임(덮어써지지 않음)', !!classicCached && classicCached.includes(CLASSIC_MARK) && !classicCached.includes(DESIGN_MARK));
  t('재현 핵심) 디자인 앱 캐시 항목은 디자인 앱 내용으로 정상 갱신됨', !!designCached && designCached.includes(DESIGN_MARK));
}

// =====================================================================
// 2) 디자인 앱 재방문·버전 갱신 — 새 배포(내용이 바뀐 응답)가 오면
//    지금 화면은 캐시 우선으로 그대로 유지하되, 새 버전이 왔다고
//    알려주는 메시지가 오고, 그 다음부터는 캐시가 새 내용으로 갱신됨
//    (기존 앱 캐시는 여전히 안 건드림).
// =====================================================================
{
  const newVersionHtml = fs.readFileSync(path.join(ROOT, 'design', 'index.html'), 'utf8').replace('내 스팟 · Travel hub', '내 스팟 · Travel hub v2');
  override = { path: '/design/index.html', status: 200, body: newVersionHtml };
  await page.reload();
  const titleServed = await page.title();
  t('2) 새 버전이 배포돼도 지금 화면은 캐시 우선으로 그대로 보여줌(비행기 모드 대비)', titleServed.includes(DESIGN_MARK) && !titleServed.includes('v2'));
  // 배경 갱신+비교가 끝나 캐시가 실제로 새 내용으로 바뀔 때까지
  // 기다린다(고정 대기 대신 결과로 판단 — 느린 실행 환경에서도 안정적).
  await page.waitForFunction(async () => {
    const names = await caches.keys();
    const cacheName = names.find((n) => n.startsWith('travel-hub-'));
    if (!cacheName) return false;
    const cache = await caches.open(cacheName);
    const res = await cache.match(location.origin + '/design/index.html');
    const text = res ? await res.text() : '';
    return text.includes('v2');
  }, { timeout: 8000 }).catch(() => {});
  const updatedCache = await cacheEntryText(page, base + '/design/index.html');
  t('2) 그 사이 디자인 앱 캐시 항목만 새 내용으로 갱신됨', !!updatedCache && updatedCache.includes('v2'));
  const classicStillOk = await cacheEntryText(page, base + '/index.html');
  t('2) 기존 앱 캐시 항목은 여전히 안 건드려짐', !!classicStillOk && classicStillOk.includes(CLASSIC_MARK));
  // 알림(daToast) 도착 자체는 정확성 판정에서 뺀다 — 이 세션에서 직접
  // 확인한 한계다: 서비스워커 쪽은 클라이언트를 찾아 postMessage까지
  // 매번 정상 호출하는데도, "새 버전이 막 배포된 바로 그 순간, 그
  // 요청 자신이 만든 문서"가 그 알림을 실제로 받는 타이밍은 브라우저
  // 클라이언트 식별 시점에 좌우돼 이 샌드박스에서 재현이 들쭉날쭉
  // 했다(옛 앱의 기존 동일 메커니즘도 같은 구조라 이번에 새로 생긴
  // 문제는 아니다 — 캐시 정확성 자체는 위에서 이미 확정적으로
  // 확인됨). 그래서 여기선 실패로 세지 않고 참고용으로만 출력한다 —
  // 실기기에서 실제 새로고침 안내 배너 타이밍은 별도 확인이 필요하다.
  await page.goto(base + '/index.html');
  await page.goto(base + '/design/index.html');
  const toastOnFreshVisit = await page.waitForFunction(() => {
    const el = document.getElementById('toast');
    return !!(el && el.textContent && el.textContent.includes('새 버전'));
  }, { timeout: 4000 }).then(() => true).catch(() => false);
  console.log((toastOnFreshVisit ? '참고(통과) ' : '참고(미도달, 실패로 안 셈) ') + '새 방문에서 새 버전 안내 도착 여부 — 타이밍 의존적, 실기기 별도 확인 필요');
  override = null;
}

// =====================================================================
// 오류 응답 오염 방지 — 배경 갱신 요청이 실패(500)하면 캐시를 오류
// 페이지로 덮어쓰지 않고, 마지막 정상 내용을 그대로 유지함.
// =====================================================================
{
  override = { path: '/design/index.html', status: 500, body: '서버 오류' };
  await page.reload();
  const shownDuringError = await page.title();
  t('오류 오염 방지) 배경 갱신이 실패해도 화면은 계속 정상 뜸(캐시된 마지막 정상본)', shownDuringError.includes(DESIGN_MARK));
  await page.waitForTimeout(300);
  const cacheAfterError = await cacheEntryText(page, base + '/design/index.html');
  t('오류 오염 방지) 실패한 응답(오류 페이지)으로 캐시가 안 덮여씀', !!cacheAfterError && !cacheAfterError.includes('서버 오류'));
  override = null;
}

// =====================================================================
// 3차 재현 A) /api/health를 네비게이션으로 직접 열면(같은 origin의
//    JSON API) 실제 JSON 응답이 그대로 뜨고, 그 응답이 앱 문서 캐시
//    (옛 앱·디자인 앱 어느 쪽도)를 덮어쓰지 않는다.
// =====================================================================
{
  const classicBefore = await cacheEntryText(page, base + '/index.html');
  const designBefore = await cacheEntryText(page, base + '/design/index.html');

  await page.goto(base + '/api/health');
  const contentType = await page.evaluate(() => document.contentType);
  t('3차재현A) /api/health가 실제 JSON으로 열림(캐시된 앱 문서로 안 바뀜)', contentType.includes('json'));

  const classicAfter = await cacheEntryText(page, base + '/index.html');
  const designAfter = await cacheEntryText(page, base + '/design/index.html');
  // 내용이 이전과 완전히 같은지(바이트 단위)로 판정한다 — 부분 문자열
  // 포함 여부(예: '"ok"')는 두 앱의 실제 정상 코드에도 우연히 나타날
  // 수 있어(옛 앱 JS에 실제로 있음) 오탐이 난다.
  t('3차재현A) 기존 앱 캐시가 JSON으로 오염되지 않음(내용 그대로)', classicAfter === classicBefore);
  t('3차재현A) 디자인 앱 캐시도 JSON으로 오염되지 않음(내용 그대로)', designAfter === designBefore);
}

// =====================================================================
// 3차 재현 B) 앱 진입 경로(docKey 대상)라도 응답이 HTML이 아니면
//    (예: 서버 오류로 JSON이 대신 온 경우) 캐시를 쓰지 않는다.
// =====================================================================
{
  const designBeforeB = await cacheEntryText(page, base + '/design/index.html');
  override = { path: '/design/index.html', status: 200, body: JSON.stringify({ error: 'unexpected' }), contentType: 'application/json; charset=utf-8' };
  await page.goto(base + '/design/index.html');
  // 캐시 우선이라 배경 응답이 비HTML이어도 지금 화면은 여전히 캐시된
  // 정상 디자인 앱 그대로다 — 사용자에게 잘못된 응답이 새어 나가지
  // 않는다는 뜻(핵심 확인 대상은 아래 캐시 쓰기 여부).
  const shownDuringNonHtml = await page.title();
  t('3차재현B) 캐시 우선이라 화면은 정상 디자인 앱 그대로임', shownDuringNonHtml.includes(DESIGN_MARK));
  await page.waitForTimeout(300);
  const designAfterB = await cacheEntryText(page, base + '/design/index.html');
  t('3차재현B) 디자인 앱 캐시가 비HTML 응답으로 안 덮여씀', designAfterB === designBeforeB);
  override = null;
  await page.goto(base + '/design/index.html'); // 정상 상태로 복귀.
}

// =====================================================================
// 3차 재현 C) 앱 진입 경로가 다른 페이지로 리디렉션되면(운영 실수 등)
//    그 리디렉션된 내용으로 캐시를 덮어쓰지 않는다.
// =====================================================================
{
  const designBeforeC = await cacheEntryText(page, base + '/design/index.html');
  override = { path: '/design/index.html', redirectTo: '/index.html' }; // 디자인 앱 경로가 엉뚱하게 옛 앱으로 리디렉션되는 상황을 흉내.
  await page.goto(base + '/design/index.html');
  // 캐시 우선 전략이라, 배경에서 리디렉션이 나도 지금 화면은 여전히
  // 캐시된(정상) 디자인 앱을 그대로 보여준다 — 이게 바로 "리디렉션된
  // 엉뚱한 내용이 사용자에게도, 캐시에도 새어 들어가지 않는다"는 뜻.
  const titleAfterRedirect = await page.title();
  t('3차재현C) 캐시 우선이라 배경 리디렉션과 무관하게 화면은 정상 디자인 앱 그대로임', titleAfterRedirect.includes(DESIGN_MARK));
  await page.waitForTimeout(300);
  const designAfterC = await cacheEntryText(page, base + '/design/index.html');
  const classicAfterC = await cacheEntryText(page, base + '/index.html');
  t('3차재현C) 리디렉션으로 온 다른 페이지 내용이 디자인 앱 캐시에 안 들어감', designAfterC === designBeforeC);
  t('3차재현C) 기존 앱 캐시도 그 사이 안 바뀜(정상 내용 그대로)', !!classicAfterC && classicAfterC.includes(CLASSIC_MARK));
  override = null;
  await page.goto(base + '/design/index.html'); // 정상 상태로 복귀.
}

// =====================================================================
// 3) 공유 쿼리를 포함한 진입 — 실제 서비스워커가 활성화된 http(s)
//    상태에서도(file://가 아니라) 공유 파라미터를 정상적으로 읽어
//    시트를 미리 채움.
// =====================================================================
{
  const shareUrl = base + '/design/index.html?title=%EC%B9%B4%ED%8E%98&text=&url=' + encodeURIComponent('https://maps.app.goo.gl/httpsharetarget');
  await page.goto(shareUrl);
  await page.waitForTimeout(300);
  const prefilled = await page.evaluate(() => document.getElementById('mapLinkInput') && document.getElementById('mapLinkInput').value);
  t('3) 실제 HTTP+서비스워커 상태에서도 공유 내용이 시트에 미리 채워짐', !!(prefilled && prefilled.includes('httpsharetarget')));
  t('3) 쿼리스트링이 지워짐', await page.evaluate(() => location.search === ''));
}

// =====================================================================
// 4) 네트워크 실패 시 동작 — 오프라인이어도 캐시된 문서로 정상 열림
//    (기존 앱·디자인 앱 둘 다).
// =====================================================================
{
  await ctx.setOffline(true);
  await page.goto(base + '/design/index.html').catch(() => {});
  const offlineDesignTitle = await page.title().catch(() => '');
  t('4) 오프라인에서도 디자인 앱 문서가 캐시로 정상 열림', offlineDesignTitle.includes(DESIGN_MARK));
  await page.goto(base + '/index.html').catch(() => {});
  const offlineClassicTitle = await page.title().catch(() => '');
  t('4) 오프라인에서도 기존 앱 문서가 캐시로 정상 열림', offlineClassicTitle.includes(CLASSIC_MARK));
  await ctx.setOffline(false);
}

// 404·ERR_FAILED는 이 검증의 목적(캐시 동작)과 무관한 잡음이다 — 이
// 경량 테스트 서버엔 favicon 등 부수 자산이 없어 나는 404, 그리고
// 4)번 오프라인 시나리오는 원래 네트워크 요청이 실패해야 정상이라
// ERR_FAILED가 난다(이걸 실패로 잡으면 오프라인 검증 자체가 항상
// 빨간불이 된다). 페이지 실행 중 예외(pageerror)만 진짜 회귀로 본다.
const realErrs = errs.filter((e) => e.startsWith('pageerror:'));
if (realErrs.length) console.log(realErrs);
t('콘솔/런타임 오류(예외) 없음', realErrs.length === 0);
console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
await b.close();
server.close();
process.exit(fail ? 1 : 0);
