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

// =====================================================================
// 4) 2026-09-11 재검토(9차) 재현 A — ChatGPT가 재현한 삭제 충돌 우회.
//    오래된 기기가 places=[]+삭제 큐(옛 기준버전)로 daSyncPush를 부르면
//    서버가 삭제 충돌로 정직하게 거절한다. 예전 버그는 여기서 클라이
//    언트가 삭제 큐의 기준 버전을 서버가 돌려준 "최신" 버전으로 몰래
//    바꿔서, 다음 저장 때 그 최신 수정(NEW IMPORTANT NOTE)째로 통째로
//    삭제해 버렸다 — 최신 수정을 검토·병합한 적이 전혀 없는데도.
// =====================================================================
{
  const email = 'sync-devices-4@example.com';
  const city = '삭제우회도시';
  const pA = await newPage('A4');
  await loginViaUi(pA, email);
  await pA.evaluate((cityName) => {
    foodMap.places = [{ id: 'p', name: '원래 장소', note: '원래 메모', cat: '기타', catConfirmed: true, city: cityName, cityKnown: true, cityConfirmed: true, sourceLists: [] }];
    A.saveFoodMap(foodMap);
  }, city);
  await pA.evaluate(() => daSyncPushSafe());
  await pA.waitForTimeout(300); // 서버 버전 1.

  const pB = await newPage('B4');
  await loginViaUi(pB, email);
  await pB.waitForTimeout(300);
  await pB.evaluate(() => { foodMap.places.find((p) => p.id === 'p').note = 'NEW IMPORTANT NOTE'; A.saveFoodMap(foodMap); });
  await pB.evaluate(() => daSyncPushSafe());
  await pB.waitForTimeout(300); // 서버 버전 2, note='NEW IMPORTANT NOTE'.

  // A는 이 사실을 전혀 모른 채(기준 버전 1 그대로), 이 장소를 삭제
  // 큐에 넣고(재현 원문 그대로 — resolveDup을 거치지 않고 데이터
  // 수준에서 직접) daSyncPush를 부른다.
  await pA.evaluate(() => {
    foodMap.places = [];
    foodMap.deletedPlaceIds = [{ id: 'p', baseVersion: 1 }];
    A.saveFoodMap(foodMap);
  });
  const push1 = await pA.evaluate(() => daSyncPush(A.sessionToken(foodMap)));
  await pA.waitForTimeout(200);
  t('4) 삭제 충돌 응답 후 최신 내용(NEW IMPORTANT NOTE)이 로컬에 되살아남(사라지지 않음)', push1.placesOk === true);
  const restored = await pA.evaluate(() => foodMap.places.find((p) => p.id === 'p'));
  t('4) 되살아난 장소가 실제로 최신 메모를 담고 있음', !!restored && restored.note === 'NEW IMPORTANT NOTE');
  const queueAfter = await pA.evaluate(() => foodMap.deletedPlaceIds || []);
  t('4) 삭제 큐가 기준 버전을 몰래 갈아서 재시도하지 않고 비워짐(자동 재삭제 금지)', queueAfter.length === 0);

  // 혹시라도 다음 저장이 나가더라도(A가 화면을 계속 쓰는 정상 흐름)
  // 서버의 최신 수정이 지워지면 안 된다 — 재현 원문의 "다음
  // daSyncPush 호출 시 서버 장소 수가 0이 됨"이 더 이상 일어나지
  // 않는지 직접 확인한다.
  await pA.evaluate(() => daSyncPushSafe());
  await pA.waitForTimeout(300);
  const serverToken = await pA.evaluate(() => foodMap.session.token);
  const serverView = await fetch(`${apiBase}/api/places`, { headers: { Authorization: `Bearer ${serverToken}` } }).then((r) => r.json());
  t('4) 다음 저장 이후에도 서버 장소 수가 0이 되지 않음(삭제 보호 우회 차단)', serverView.places.filter((p) => !p.deleted).length === 1);
  t('4) 서버에 남은 장소도 최신 메모를 그대로 유지함', serverView.places.find((p) => p.id === 'p' && !p.deleted).note === 'NEW IMPORTANT NOTE');
}

// =====================================================================
// 5) 2026-09-11 재검토(9차) 재현 B — 같은 필드를 두 기기가 서로
//    다르게 고친 진짜 충돌. 예전엔 mine만 채택하고 theirs(서버 값)는
//    완전히 사라져 다음 자동 저장으로 덮였다("양쪽 수정 보존"과 다른
//    실제 동작). 이제 내 값을 지키되 서버 값도 _fieldConflicts로
//    남겨 사용자가 확인할 수 있어야 한다.
// =====================================================================
{
  const email = 'sync-devices-5@example.com';
  const city = '같은필드충돌도시';
  const pA = await newPage('A5');
  await loginViaUi(pA, email);
  await pA.evaluate((cityName) => {
    foodMap.places = [{ id: 'p', name: '원래 장소', note: 'base', cat: '기타', catConfirmed: true, city: cityName, cityKnown: true, cityConfirmed: true, sourceLists: [] }];
    A.saveFoodMap(foodMap);
  }, city);
  await pA.evaluate(() => daSyncPushSafe());
  await pA.waitForTimeout(300); // 서버 버전 1, note='base' — 두 기기가 공유하는 기준.

  const pB = await newPage('B5');
  await loginViaUi(pB, email);
  await pB.waitForTimeout(300); // B도 기준(base v1, note='base')을 실제로 받아 옴.

  // B가 먼저 note를 'SERVER'로 고쳐 성공적으로 저장한다(서버 버전 2).
  await pB.evaluate(() => { foodMap.places.find((p) => p.id === 'p').note = 'SERVER'; A.saveFoodMap(foodMap); });
  await pB.evaluate(() => daSyncPushSafe());
  await pB.waitForTimeout(300);

  // A는 이 사실을 전혀 모른 채(기준 여전히 v1, note='base') 같은
  // 필드를 'LOCAL'로 고쳐 저장을 시도한다 — 서버가 기준 버전 불일치로
  // 거절해야 하는 진짜 충돌이다.
  await pA.evaluate(() => { foodMap.places.find((p) => p.id === 'p').note = 'LOCAL'; A.saveFoodMap(foodMap); });
  await pA.evaluate(() => daSyncPushSafe());
  await pA.waitForTimeout(400); // 충돌 응답 처리 + 자동 재시도까지 기다린다.

  const afterConflict = await pA.evaluate(() => foodMap.places.find((p) => p.id === 'p'));
  t('5) 같은 필드 충돌에서도 내 값(LOCAL)이 조용히 사라지지 않고 유지됨', afterConflict.note === 'LOCAL');
  t('5) 서버 값(SERVER)도 완전히 사라지지 않고 _fieldConflicts로 보존됨', !!afterConflict._fieldConflicts && afterConflict._fieldConflicts.note && afterConflict._fieldConflicts.note.theirs === 'SERVER');

  // 화면(장소 상세)에도 실제로 노출되는지 확인 — buildSpots가
  // fieldConflicts를 그대로 넘기고, detail()이 안내+버튼을 그린다.
  const detailText = await pA.evaluate(() => { detail('p'); return document.getElementById('sheetContent').innerText; });
  t('5) 장소 상세 화면에 충돌 안내가 실제로 표시됨', /다른 기기와 다르게 저장/.test(detailText) && detailText.includes('SERVER'));

  // "다른 기기 값으로 바꾸기"를 누르면 한 번에 해결되고, 반복 확인창
  // 없이 그 값으로 정리된다.
  await pA.evaluate(() => { document.querySelector('[data-conflict-resolve]').click(); });
  await pA.waitForTimeout(100);
  const afterResolve = await pA.evaluate(() => foodMap.places.find((p) => p.id === 'p'));
  t('5) "다른 기기 값으로 바꾸기"를 누르면 실제로 그 값이 적용되고 충돌 표시가 사라짐', afterResolve.note === 'SERVER' && !afterResolve._fieldConflicts);
}

// =====================================================================
// 6) 2026-09-11 재검토(9차) — "courses/trips/visits 응답도 conflicts를
//    무시한 통째 대입으로 미저장 변경이 없어지지 않는지 확인하라"는
//    지시로 발견한 실제 결함. trips.mjs의 syncTrips는 서버가 기준
//    버전 불일치를 conflicts로 정직하게 보고하는데, 클라이언트가 그
//    conflicts를 전혀 안 보고 서버가 돌려준 배열(반려된 여행은 옛
//    값 그대로)을 통째로 덮어써 방금 고친 여행 이름이 조용히
//    사라졌다.
// =====================================================================
{
  const email = 'sync-devices-6@example.com';
  const city = '여행충돌도시';
  const pA = await newPage('A6');
  await loginViaUi(pA, email);
  const tripId = await pA.evaluate(async (cityName) => {
    const token = A.sessionToken(foodMap);
    const r = await A.api('/api/trips', { method: 'POST', token, body: { city: cityName, name: '원래 여행 이름' } });
    foodMap.trips = foodMap.trips || [];
    foodMap.trips.push(r.json.trip);
    A.saveFoodMap(foodMap);
    return r.json.trip.tripId;
  }, city);
  await pA.waitForTimeout(200); // 서버 버전 1.

  const pB = await newPage('B6');
  await loginViaUi(pB, email);
  await pB.evaluate(() => daSyncPushSafe()); // 빈 trips로 push해도 서버 목록을 그대로 받아 온다.
  await pB.waitForTimeout(300);
  await pB.evaluate(() => { foodMap.trips.find((t) => t.name === '원래 여행 이름').name = 'B가 바꾼 이름'; });
  await pB.evaluate(() => daSyncPushSafe());
  await pB.waitForTimeout(300); // 서버 버전 2, name='B가 바꾼 이름'.

  // A는 이 사실을 전혀 모른 채(기준 여전히 v1) 같은 여행의 이름을
  // 'A가 바꾼 이름'으로 고쳐 저장을 시도한다 — 기준 버전 불일치로
  // 거절돼야 하는 진짜 충돌이다.
  await pA.evaluate(() => { foodMap.trips.find((t) => t.name === '원래 여행 이름').name = 'A가 바꾼 이름'; A.saveFoodMap(foodMap); });
  await pA.evaluate(() => daSyncPushSafe());
  await pA.waitForTimeout(400);

  const afterConflict = await pA.evaluate((id) => foodMap.trips.find((t) => t.tripId === id), tripId);
  t('6) 여행 정보 충돌에서도 내가 방금 고친 이름이 조용히 사라지지 않음', afterConflict.name === 'A가 바꾼 이름');

  await pA.waitForTimeout(400); // 재시도(자동 재병합 로직이 새 버전으로 다시 시도)까지 기다린다.
  const serverToken = await pA.evaluate(() => foodMap.session.token);
  const serverView = await fetch(`${apiBase}/api/trips`, { headers: { Authorization: `Bearer ${serverToken}` } }).then((r) => r.json());
  const onServer = serverView.trips.find((t) => t.tripId === tripId);
  t('6) 재시도로 결국 A의 최신 수정이 서버에도 반영됨', onServer.name === 'A가 바꾼 이름');
}

t('최종 콘솔/런타임 오류 0', errs.length === 0);
if (errs.length) console.log(errs);

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
await b.close();
server.close();
process.exit(fail ? 1 : 0);
