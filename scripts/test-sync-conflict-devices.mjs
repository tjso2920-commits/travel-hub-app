/**
 * 2026-09-10 재검토(8차) 1절 — ChatGPT가 재현한 동기화 충돌 보호 결함을
 * 실제 두 기기 화면 흐름(진짜 Chromium 두 개, 서로 다른 브라우저
 * 컨텍스트 = 서로 다른 localStorage)으로 검증한다. 서버 단위 검증은
 * server/test/sync-conflict-protection.test.mjs가 이미 하지만, 여기서는
 * "실제 화면에서 사용자가 저장 버튼을 누르는 흐름 그대로" 확인한다:
 *  1) 같은 원본에서 시작한 두 기기가 서로 다른 필드를 고치면 — 나중
 *     기기의 저장이 먼저 기기의 수정을 지우지 않고, 3-way 재병합으로
 *     둘 다 반영돼야 한다.
 *  2) 수정과 삭제의 충돌 — 한 기기가 정당하게 고친 직후, 그 사실을
 *     모르는 다른 기기가 그 장소를 지우려 하면 조용히 지워지면 안 된다.
 *  3) 저장 중 추가 수정 — 네트워크 왕복 도중에 사용자가 또 고치면 그
 *     수정을 잃으면 안 된다.
 *
 * 실행: node scripts/test-sync-conflict-devices.mjs
 */
import { chromium } from 'playwright';

process.env.DB_PATH = ':memory:';
process.env.FORCE_TEST_MODE = 'true';
process.env.LOGIN_CODE_COOLDOWN_SECONDS = '0';
const { createServer } = await import('../server/index.mjs');
const { sentEmailsForTest } = await import('../server/adapters/email.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const apiBase = `http://127.0.0.1:${port}`;

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errs = [];
async function newPage(label) {
  const page = await b.newPage();
  page.on('pageerror', (e) => errs.push(`pageerror(${label}): ` + e.message));
  page.on('dialog', (d) => d.dismiss());
  await page.addInitScript((base) => { window.API_BASE = base; }, apiBase);
  await page.goto('file://' + process.cwd() + '/src/design/index.html');
  await page.waitForTimeout(200);
  return page;
}
async function loginViaUi(page, email) {
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
// 1) 같은 원본에서 시작한 두 기기가 서로 다른 필드를 고침 — 3-way
//    재병합으로 둘 다 반영돼야 한다(A의 메모 수정 + B의 분류 수정).
// =====================================================================
{
  const email = 'sync-devices-1@example.com';
  const city = '재병합도시';
  const pA = await newPage('A1');
  await loginViaUi(pA, email);
  await pA.evaluate((cityName) => {
    foodMap.places = [{ id: 'p1', name: '원래 장소', note: '원래 메모', cat: '기타', lat: 33.5, lng: 130.4, catConfirmed: true, city: cityName, cityKnown: true, cityConfirmed: true, sourceLists: [] }];
    A.saveFoodMap(foodMap);
  }, city);
  await pA.evaluate(() => daSyncPushSafe());
  await pA.waitForTimeout(300);

  const pB = await newPage('B1');
  await loginViaUi(pB, email);
  await pB.waitForTimeout(300);
  const bBaseVersion = await pB.evaluate(() => foodMap.places.find((p) => p.id === 'p1').version);
  t('1) 기기 B가 로그인 직후 A가 만든 원본을 그대로 받아옴', await pB.evaluate(() => foodMap.places.find((p) => p.id === 'p1').note) === '원래 메모');

  // A가 메모만 고쳐 먼저 저장한다.
  await pA.evaluate(() => { foodMap.places[0].note = 'A가 고친 메모'; A.saveFoodMap(foodMap); });
  await pA.evaluate(() => daSyncPushSafe());
  await pA.waitForTimeout(300);

  // B는 A의 수정을 전혀 모른 채(재조회 안 함), 자신은 분류만 고쳐 저장한다.
  await pB.evaluate(() => { foodMap.places.find((p) => p.id === 'p1').cat = '맛집·식당'; A.saveFoodMap(foodMap); });
  await pB.evaluate(() => daSyncPushSafe());
  await pB.waitForTimeout(500); // 충돌 재병합 후 자동 재시도까지 기다린다.

  const bAfter = await pB.evaluate(() => foodMap.places.find((p) => p.id === 'p1'));
  t('1) B 화면에 A의 메모 수정이 재병합으로 반영됨(내가 안 건드린 필드는 서버 값 채택)', bAfter.note === 'A가 고친 메모');
  t('1) B 화면에 B 자신의 분류 수정도 그대로 남음(내가 고친 필드는 안 잃음)', bAfter.cat === '맛집·식당');

  const serverView = await fetch(`${apiBase}/api/places`, { headers: { Authorization: `Bearer ${await pA.evaluate(() => foodMap.session.token)}` } }).then((r) => r.json());
  const onServer = serverView.places.find((p) => p.id === 'p1');
  t('1) 서버에도 두 기기의 수정이 최종적으로 둘 다 반영됨(재시도로 수렴)', onServer.note === 'A가 고친 메모' && onServer.cat === '맛집·식당');
  t('1) 기준 버전(baseVersion)이 실제로 진행됨(1보다 커짐)', onServer.version > bBaseVersion);

  await pA.close(); await pB.close();
}

// =====================================================================
// 2) 수정과 삭제의 충돌 — B가 정당하게 좌표를 채운 직후, 그 사실을
//    모르는 A가 같은 장소를 중복 병합으로 지우려 하면 조용히 지워지면
//    안 된다(A의 삭제 의도는 유지하되, B의 최신 수정을 먼저 지키고
//    A가 최신 값을 다시 보고 나서 결정할 수 있게 한다).
// =====================================================================
{
  const email = 'sync-devices-2@example.com';
  const city = '삭제충돌도시';
  const pA = await newPage('A2');
  await loginViaUi(pA, email);
  await pA.evaluate((cityName) => {
    foodMap.places = [
      { id: 'keep1', name: '남는 곳', lat: 33.5, lng: 130.4, cat: '기타', catConfirmed: true, city: cityName, cityKnown: true, cityConfirmed: true, sourceLists: [], dupCandidateIds: ['dup1'] },
      { id: 'dup1', name: '중복 후보', cat: '기타', catConfirmed: true, city: cityName, cityKnown: true, cityConfirmed: true, sourceLists: [], dupCandidateIds: ['keep1'] },
    ];
    A.saveFoodMap(foodMap);
  }, city);
  await pA.evaluate(() => daSyncPushSafe());
  await pA.waitForTimeout(300);

  const pB = await newPage('B2');
  await loginViaUi(pB, email);
  await pB.waitForTimeout(300);

  // B가 dup1에 실제 좌표를 채워 넣는다(예: 위치 확인 결과 반영) — 이건
  // 절대 지워지면 안 되는 정당한 최신 수정이다.
  await pB.evaluate(() => { const p = foodMap.places.find((x) => x.id === 'dup1'); p.lat = 33.6; p.lng = 130.5; A.saveFoodMap(foodMap); });
  await pB.evaluate(() => daSyncPushSafe());
  await pB.waitForTimeout(300);

  // A는 B의 수정을 전혀 모른 채(옛 스냅샷 그대로) 중복 병합으로 dup1을 지운다.
  await pA.evaluate(() => { resolveDup('keep1', 'dup1', 'merge'); });
  await pA.waitForTimeout(300);

  const serverToken = await pA.evaluate(() => foodMap.session.token);
  const serverView = await fetch(`${apiBase}/api/places`, { headers: { Authorization: `Bearer ${serverToken}` } }).then((r) => r.json());
  const dup1OnServer = serverView.places.find((p) => p.id === 'dup1');
  t('2) B가 채운 좌표가 A의(기준이 뒤처진) 삭제 시도로 사라지지 않음', dup1OnServer && dup1OnServer.lat === 33.6);
}

// =====================================================================
// 3) 저장 중 추가 수정 — 네트워크 응답이 오는 동안 사용자가 같은
//    장소를 또 고치면, 응답이 그 수정을 덮어써서 잃으면 안 된다.
// =====================================================================
{
  const email = 'sync-devices-3@example.com';
  const city = '동시수정도시';
  const pA = await newPage('A3');
  await loginViaUi(pA, email);
  await pA.evaluate((cityName) => {
    foodMap.places = [{ id: 'p1', name: '원래 이름', note: '원래 메모', cat: '기타', catConfirmed: true, city: cityName, cityKnown: true, cityConfirmed: true, sourceLists: [] }];
    A.saveFoodMap(foodMap);
  }, city);
  await pA.evaluate(() => daSyncPushSafe());
  await pA.waitForTimeout(300);

  // PUT /api/places 응답을 딱 한 번만 인위적으로 늦춰, 그 사이
  // 로컬에서 또 고칠 시간을 확보한다(실제 느린 네트워크를 흉내) —
  // 그 이후 요청은 그대로 통과시킨다(라우트 해제 시점 경쟁 방지).
  let delayedOnce = false;
  await pA.route('**/api/places', async (route) => {
    if (!delayedOnce) { delayedOnce = true; await new Promise((resolve) => setTimeout(resolve, 600)); }
    await route.continue();
  });
  await pA.evaluate(() => { foodMap.places[0].note = '첫 번째 수정'; A.saveFoodMap(foodMap); daSyncPushSafe(); });
  await pA.waitForTimeout(150); // 요청이 나간 뒤, 응답이 오기 전에 또 고친다.
  await pA.evaluate(() => { foodMap.places[0].name = '저장 중에 바꾼 이름'; A.saveFoodMap(foodMap); });
  await pA.waitForTimeout(800); // 지연된 응답이 도착할 때까지 기다린다.

  const afterFlight = await pA.evaluate(() => foodMap.places.find((p) => p.id === 'p1'));
  t('3) 저장 중(응답 대기 중)에 고친 이름이 응답으로 사라지지 않음', afterFlight.name === '저장 중에 바꾼 이름');
  t('3) 그 전에 보낸 메모 수정도 그대로 반영돼 있음', afterFlight.note === '첫 번째 수정');

  await pA.evaluate(() => daSyncPushSafe());
  await pA.waitForTimeout(400);
  const serverToken = await pA.evaluate(() => foodMap.session.token);
  const serverView = await fetch(`${apiBase}/api/places`, { headers: { Authorization: `Bearer ${serverToken}` } }).then((r) => r.json());
  const onServer = serverView.places.find((p) => p.id === 'p1');
  t('3) 다음 저장으로 서버에도 최종적으로 두 수정이 모두 반영됨', onServer.name === '저장 중에 바꾼 이름' && onServer.note === '첫 번째 수정');
}

t('최종 콘솔/런타임 오류 0', errs.length === 0);
if (errs.length) console.log(errs);

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
await b.close();
server.close();
process.exit(fail ? 1 : 0);
