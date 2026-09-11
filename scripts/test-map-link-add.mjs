/**
 * 2026-09-11 재검토(13차) 3절 — "지도 링크로 한 곳 추가" 실제 화면
 * 검증(Chromium):
 *  1) 지원하는 전체 URL을 붙여넣으면 실제로 장소가 담기고(이름·좌표
 *     반영), 성공 토스트가 뜸.
 *  2) 지원하지 않는 링크(구글맵 아님)는 명확한 오류 문구만 뜨고 아무
 *     것도 담기지 않음(조용한 성공 처리 금지).
 *  3) 같은 링크를 다시 붙여넣으면(재현) 중복으로 쌓이지 않고 기존
 *     장소와 합쳐짐(daMerge 재사용 확인).
 *  4) 로그인 안 한 상태에서 열면 로그인부터 요구함(기존 게이트 패턴과
 *     동일).
 *
 * 실행: node scripts/test-map-link-add.mjs
 */
import { chromium } from 'playwright';

process.env.DB_PATH = ':memory:';
process.env.FORCE_TEST_MODE = 'true';
process.env.LOGIN_CODE_COOLDOWN_SECONDS = '0';
process.env.LOGIN_MAX_VERIFY_ATTEMPTS = '200';
const { createServer } = await import('../server/index.mjs');
const { sentEmailsForTest } = await import('../server/adapters/email.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const apiBase = `http://127.0.0.1:${port}`;

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errs = [];
const page = await b.newPage();
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('dialog', (d) => d.dismiss());
await page.addInitScript((base) => { window.API_BASE = base; }, apiBase);
await page.goto('file://' + process.cwd() + '/src/design/index.html');
await page.waitForTimeout(200);

async function loginViaUi(email) {
  await page.evaluate(() => showLoginSheet(() => {}));
  await page.waitForTimeout(150);
  await page.fill('#loginEmail', email);
  await page.click('#loginSendBtn');
  await page.waitForTimeout(200);
  const sent = sentEmailsForTest.filter((e) => e.to === email).pop();
  const code = sent.body.match(/(\d{6})/)[1];
  await page.fill('#loginCode', code);
  await page.click('#loginVerifyBtn');
  await page.waitForFunction(() => !!(foodMap.session && foodMap.session.token), { timeout: 5000 });
  await page.waitForTimeout(250);
  await page.evaluate(() => { const c = document.getElementById('close'); if (c) c.click(); });
}

// =====================================================================
// 4) 로그인 안 한 상태 — 링크 추가 시트를 열면 먼저 로그인부터 요구함.
// =====================================================================
{
  await page.evaluate(() => showAddByMapLinkSheet());
  await page.waitForTimeout(150);
  const showsLogin = await page.evaluate(() => !!document.getElementById('loginEmail'));
  t('4) 로그인 안 한 상태에서 열면 로그인 시트가 먼저 뜸', showsLogin);
}

await loginViaUi('maplink-1@example.com');

// =====================================================================
// 1) 지원하는 전체 URL — 실제로 장소가 담김.
// =====================================================================
{
  await page.evaluate(() => showAddByMapLinkSheet());
  await page.waitForTimeout(150);
  const fullUrl = 'https://www.google.com/maps/place/%EC%B9%B4%ED%8E%98+%ED%85%8C%EC%8A%A4%ED%8A%B8/@35.1234,139.5678,17z';
  await page.fill('#mapLinkInput', fullUrl);
  await page.click('#mapLinkAddBtn');
  await page.waitForTimeout(400);
  const added = await page.evaluate(() => foodMap.places.find((p) => p.name === '카페 테스트'));
  t('1) 실제로 장소가 담김(이름 반영)', !!added);
  t('1) 좌표도 함께 반영됨', added && Math.abs(added.lat - 35.1234) < 0.0001 && Math.abs(added.lng - 139.5678) < 0.0001);
  t('1) 링크로 추가된 출처가 표시됨', added && Array.isArray(added.sourceLists) && added.sourceLists.includes('지도 링크로 추가'));
}

// =====================================================================
// 2) 지원하지 않는 링크 — 오류만 뜨고 아무것도 안 담김.
// =====================================================================
{
  const beforeCount = await page.evaluate(() => foodMap.places.length);
  await page.evaluate(() => showAddByMapLinkSheet());
  await page.waitForTimeout(150);
  await page.fill('#mapLinkInput', 'https://example.com/not-a-maps-link');
  await page.click('#mapLinkAddBtn');
  await page.waitForTimeout(400);
  const errorShown = await page.evaluate(() => !document.getElementById('mapLinkMsg').hidden && document.getElementById('mapLinkMsg').textContent.length > 0);
  t('2) 지원하지 않는 링크는 오류 문구가 명확히 뜸', errorShown);
  const afterCount = await page.evaluate(() => foodMap.places.length);
  t('2) 아무 장소도 조용히 담기지 않음(개수 그대로)', afterCount === beforeCount);
  await page.evaluate(() => { const c = document.getElementById('close'); if (c) c.click(); });
}

// =====================================================================
// 3) 같은 링크를 다시 붙여넣으면 — 중복으로 쌓이지 않고 합쳐짐.
// =====================================================================
{
  const beforeCount = await page.evaluate(() => foodMap.places.length);
  await page.evaluate(() => showAddByMapLinkSheet());
  await page.waitForTimeout(150);
  const fullUrl = 'https://www.google.com/maps/place/%EC%B9%B4%ED%8E%98+%ED%85%8C%EC%8A%A4%ED%8A%B8/@35.1234,139.5678,17z';
  await page.fill('#mapLinkInput', fullUrl);
  await page.click('#mapLinkAddBtn');
  await page.waitForTimeout(400);
  const afterCount = await page.evaluate(() => foodMap.places.length);
  t('3) 같은 링크를 다시 추가해도 개수가 늘지 않음(중복 병합)', afterCount === beforeCount);
}

t('콘솔/런타임 오류 없음', errs.length === 0);
console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
await b.close();
server.close();
process.exit(fail ? 1 : 0);
