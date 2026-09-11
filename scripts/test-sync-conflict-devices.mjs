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
// 2026-09-11 재검토(11차) — 이 파일 하나에서 여러 시나리오가 각자
// 새 Chromium 페이지(=새 기기)로 로그인을 여러 번 반복하다 보니, 실제
// 서비스라면 정상인 로그인 코드 요청 IP당 시간당 상한(server/auth.mjs
// — Math.max(20, loginMaxVerifyAttempts*4))에 이 테스트 프로세스
// 자체가 걸린다(모든 요청이 같은 127.0.0.1에서 나가므로). 실제
// 사용자가 겪는 제한이 아니라 테스트 환경의 인위적 제약이므로, 이
// 값만 넉넉히 올려 둔다(운영 기본값 5는 그대로 — 여기서 바꾸는 건
// 이 테스트 프로세스의 환경변수일 뿐이다).
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

// =====================================================================
// 7) 2026-09-11 재검토(10차) — ChatGPT가 재현한 courses 충돌 결함.
//    ①원본 코스{city,date,note:'base'} v1 ②A가 note='SERVER-NEW' 저장
//    → v2 ③B는 v1 기준으로 다른 필드(memo)만 고쳐 저장 ④예전 코드는
//    충돌 시 "버전만 바꿔 내 객체 전체를 재제출"했으므로, 내가 손대지
//    않은 note 필드까지 내 옛 값('base')으로 되돌려 서버의 SERVER-NEW를
//    통째로 지워 버렸다. 이제는 기준선(A.getCourseBaseline)으로 "내가
//    실제로 고친 필드"만 가려내 병합해야 한다 — 손대지 않은 note는
//    서버 값(SERVER-NEW) 그대로 남고, 내가 고친 memo만 반영돼야 한다.
// =====================================================================
{
  const email = 'sync-devices-7@example.com';
  const city = '코스충돌도시';
  const date = '2026-10-25';
  const pA = await newPage('A7');
  await loginViaUi(pA, email);
  await pA.evaluate((args) => {
    foodMap.courses = [{ city: args.city, date: args.date, note: 'base', memo: 'base-memo', stops: [] }];
    A.saveFoodMap(foodMap);
  }, { city, date });
  await pA.evaluate(() => daSyncPushSafe());
  await pA.waitForTimeout(300); // 서버 버전 1.

  const pB = await newPage('B7');
  await loginViaUi(pB, email);
  await pB.waitForTimeout(300); // B도 기준(v1, note='base', memo='base-memo')을 실제로 받아 옴.

  // A가 note만 고쳐 먼저 저장한다(서버 버전 2, note='SERVER-NEW').
  await pA.evaluate((args) => { foodMap.courses.find((c) => c.city === args.city && c.date === args.date).note = 'SERVER-NEW'; A.saveFoodMap(foodMap); }, { city, date });
  await pA.evaluate(() => daSyncPushSafe());
  await pA.waitForTimeout(300);

  // B는 이 사실을 전혀 모른 채(기준 여전히 v1) note는 안 건드리고
  // memo만 고쳐 저장한다 — 독립적인 필드 변경이라 충돌이 아니어야
  // 정상이지만, 서버는 여전히 baseVersion(1) !== 현재버전(2)이라 정직
  // 하게 충돌로 보고한다(courses는 서버가 필드 단위 병합을 안 하므로
  // 클라이언트가 재병합해야 한다).
  await pB.evaluate((args) => { foodMap.courses.find((c) => c.city === args.city && c.date === args.date).memo = 'B가 고친 메모'; A.saveFoodMap(foodMap); }, { city, date });
  await pB.evaluate(() => daSyncPushSafe());
  await pB.waitForTimeout(500); // 충돌 재병합 + 자동 재시도까지 기다린다.

  const bAfter = await pB.evaluate((args) => foodMap.courses.find((c) => c.city === args.city && c.date === args.date), { city, date });
  t('7) B가 안 건드린 note 필드는 서버의 최신 값(SERVER-NEW)을 그대로 받음(독립 필드 병합)', bAfter.note === 'SERVER-NEW');
  t('7) B 자신이 고친 memo도 그대로 남음(내가 고친 필드는 안 잃음)', bAfter.memo === 'B가 고친 메모');

  const serverToken = await pA.evaluate(() => foodMap.session.token);
  const serverView = await fetch(`${apiBase}/api/courses`, { headers: { Authorization: `Bearer ${serverToken}` } }).then((r) => r.json());
  const onServer = serverView.courses.find((c) => c.city === city && c.date === date);
  t('7) 서버에도 A의 note와 B의 memo가 최종적으로 둘 다 반영됨(재시도로 수렴 — SERVER-NEW가 사라지지 않음)', onServer.note === 'SERVER-NEW' && onServer.memo === 'B가 고친 메모');

  await pA.close(); await pB.close();
}

// =====================================================================
// 8) 2026-09-11 재검토(10차) — 사용자가 "확정 오류라고 보고하지 말고
//    먼저 점검하라"고 지시한 항목 중 하나("저장 중 새 장소 추가
//    보존")를 실제로 재현해 확인한 결과 진짜 결함이었다: PUT /api/places
//    요청이 나간 뒤(그 요청 스냅샷에는 없었던) 새 장소를 추가하면,
//    서버 응답이 늦게 도착했을 때 그 응답 배열에만 있는 항목으로
//    foodMap.places를 통째로 교체해 방금 추가한 새 장소가 조용히
//    사라졌다.
// =====================================================================
{
  const email = 'sync-devices-8@example.com';
  const city = '새장소도중도시';
  const pA = await newPage('A8');
  await loginViaUi(pA, email);
  await pA.evaluate((cityName) => {
    foodMap.places = [{ id: 'p1', name: '기존 장소', cat: '기타', catConfirmed: true, city: cityName, cityKnown: true, cityConfirmed: true, sourceLists: [] }];
    A.saveFoodMap(foodMap);
  }, city);
  await pA.evaluate(() => daSyncPushSafe());
  await pA.waitForTimeout(300);

  let delayedOnce = false;
  await pA.route('**/api/places', async (route) => {
    if (!delayedOnce) { delayedOnce = true; await new Promise((resolve) => setTimeout(resolve, 600)); }
    await route.continue();
  });
  // p1만 실린 요청이 나간다(지연). 응답이 오기 전에 완전히 새로운
  // 장소(p2)를 추가한다 — 이 요청 스냅샷에도, 아직 서버 응답에도
  // 존재할 수 없는 항목이다.
  await pA.evaluate(() => { foodMap.places[0].note = '살짝 수정'; A.saveFoodMap(foodMap); daSyncPushSafe(); });
  await pA.waitForTimeout(150);
  await pA.evaluate((cityName) => {
    foodMap.places.push({ id: 'p2', name: '저장 중 새로 추가한 장소', cat: '기타', catConfirmed: true, city: cityName, cityKnown: true, cityConfirmed: true, sourceLists: [] });
    A.saveFoodMap(foodMap);
  }, city);
  await pA.waitForTimeout(800); // 지연된 응답 도착 대기.

  const afterFlight = await pA.evaluate(() => foodMap.places.map((p) => p.id));
  t('8) 저장 중(응답 대기 중)에 추가한 새 장소가 응답 반영 후에도 사라지지 않음', afterFlight.includes('p2'));
  t('8) 기존 장소도 그대로 있음', afterFlight.includes('p1'));

  await pA.evaluate(() => daSyncPushSafe());
  await pA.waitForTimeout(400);
  const serverToken = await pA.evaluate(() => foodMap.session.token);
  const serverView = await fetch(`${apiBase}/api/places`, { headers: { Authorization: `Bearer ${serverToken}` } }).then((r) => r.json());
  t('8) 다음 저장으로 서버에도 새 장소가 실제로 반영됨', serverView.places.some((p) => p.id === 'p2'));

  await pA.close();
}

// =====================================================================
// 9) 2026-09-11 재검토(10차) — 사용자가 "확정 오류라고 보고하지 말고
//    먼저 점검하라"고 지시한 세 번째 항목("기준 스냅샷의 재시작
//    보존")도 재현해 확인한 결과 진짜 결함이었다: 재병합 기준선은
//    메모리에만 있어 앱 재시작(새로고침) 때 사라지고, loadFoodMap이
//    그 자리를 "지금 로컬 스토리지 내용"으로 다시 채웠다 — 그런데 그
//    내용이 아직 서버에 못 올라간 미동기화 수정이면, 재시작 후 첫
//    충돌 때 그 수정 자체가 "안 건드림"으로 오인돼 다른 기기의 값으로
//    조용히 되돌려졌다. 이제는 기준선을 별도로 지속 저장해 재시작해도
//    "마지막으로 서버와 실제로 맞춘 시점"을 정확히 기억해야 한다.
// =====================================================================
{
  const email = 'sync-devices-9@example.com';
  const city = '재시작기준선도시';
  const pA = await newPage('A9');
  await loginViaUi(pA, email);
  await pA.evaluate((cityName) => {
    foodMap.places = [{ id: 'p1', name: '원래 장소', note: 'v0', cat: '기타', catConfirmed: true, city: cityName, cityKnown: true, cityConfirmed: true, sourceLists: [] }];
    A.saveFoodMap(foodMap);
  }, city);
  await pA.evaluate(() => daSyncPushSafe());
  await pA.waitForTimeout(300); // 서버 v1, note='v0'.

  // pA가 note를 고치고 로컬에는 저장하지만(saveFoodMap), 아직 서버에는
  // 동기화하지 않은 상태를 재현한다(오프라인이거나 저장 직후 바로
  // 앱을 닫은 경우).
  await pA.evaluate(() => { foodMap.places.find((p) => p.id === 'p1').note = 'LOCAL-UNSYNCED'; A.saveFoodMap(foodMap); });

  // 다른 기기가 그 사이 서버에 note='SERVER-NEW'를 성공적으로 반영한다.
  const pB = await newPage('B9');
  await loginViaUi(pB, email);
  await pB.waitForTimeout(300);
  await pB.evaluate(() => { foodMap.places.find((p) => p.id === 'p1').note = 'SERVER-NEW'; A.saveFoodMap(foodMap); });
  await pB.evaluate(() => daSyncPushSafe());
  await pB.waitForTimeout(300); // 서버 v2, note='SERVER-NEW'.

  // pA가 "앱을 재시작"한다(페이지 새로고침 = 메모리 상태 완전 초기화,
  // localStorage만 남음 — foodmap_v1에는 아직 동기화 안 된 값이 있다).
  await pA.reload();
  await pA.waitForTimeout(300);
  const afterReload = await pA.evaluate(() => foodMap.places.find((p) => p.id === 'p1'));
  t('9) 재시작 직후에도 동기화 안 된 로컬 수정이 로컬에 그대로 남아 있음', afterReload && afterReload.note === 'LOCAL-UNSYNCED');

  // 재시작한 pA가 다시 동기화를 시도한다 — 기준 버전 불일치로 충돌이
  // 보고될 것이다(pA는 여전히 v1, 서버는 이미 v2).
  await pA.evaluate(() => daSyncPushSafe());
  await pA.waitForTimeout(500);
  const afterConflict = await pA.evaluate(() => foodMap.places.find((p) => p.id === 'p1'));
  t('9) 재시작 후에도 동기화 안 됐던 내 수정이 충돌 재병합에서 조용히 사라지지 않음(내 값 유지 또는 충돌로 보존)', afterConflict.note === 'LOCAL-UNSYNCED' || (afterConflict._fieldConflicts && afterConflict._fieldConflicts.note && afterConflict._fieldConflicts.note.mine === 'LOCAL-UNSYNCED'));

  // 로그아웃하면 이 계정의 기준선이 다음 계정으로 새면 안 된다(계정
  // 격리) — clearSyncBaselines가 실제로 지우는지 확인한다.
  await pA.evaluate(() => daLogout());
  await pA.waitForTimeout(200);
  const emailC = 'sync-devices-9c@example.com';
  await pA.evaluate(() => showLoginSheet(() => {}));
  await pA.waitForTimeout(150);
  await pA.fill('#loginEmail', emailC);
  await pA.click('#loginSendBtn');
  await pA.waitForTimeout(200);
  const sentC = sentEmailsForTest.filter((e) => e.to === emailC).pop();
  const codeC = sentC.body.match(/(\d{6})/)[1];
  await pA.fill('#loginCode', codeC);
  await pA.click('#loginVerifyBtn');
  await pA.waitForFunction(() => !!(foodMap.session && foodMap.session.token), { timeout: 5000 });
  await pA.waitForTimeout(250);
  await pA.evaluate(() => { const c = document.getElementById('close'); if (c) c.click(); });
  await pA.evaluate((cityName) => {
    foodMap.places = [{ id: 'p1', name: '새 계정의 같은 로컬 id', note: 'C계정 최초값', cat: '기타', catConfirmed: true, city: cityName, cityKnown: true, cityConfirmed: true, sourceLists: [] }];
    A.saveFoodMap(foodMap);
  }, city);
  await pA.evaluate(() => daSyncPushSafe());
  await pA.waitForTimeout(300);
  const cPlace = await pA.evaluate(() => foodMap.places.find((p) => p.id === 'p1'));
  t('9) 로그아웃 후 새 계정에서는 이전 계정의 값이 안 새어 들어오고 새 계정 값 그대로 저장됨(계정 간 기준선 격리)', cPlace.note === 'C계정 최초값');

  await pA.close(); await pB.close();
}

// =====================================================================
// 10) 2026-09-11 재검토(11차) — ChatGPT가 실제로 재현한 필드 삭제 부활
//    버그: base={id:p,note:old}, mine={id:p}(note를 지움), theirs=
//    {id:p,note:old,version:2}를 daRemergeGenericConflict에 넣으면
//    예전엔 note=old가 되살아났다(Object.keys(mine)만 훑어서 mine이
//    지운 필드는 애초에 안 보임 → merged={...theirs}로 시작해 조용히
//    남음). 서버 왕복 없이 순수 함수 자체를 직접 호출해 확인한다.
// =====================================================================
{
  const pA = await newPage('A10');
  await loginViaUi(pA, 'sync-devices-10@example.com');
  const r1 = await pA.evaluate(() => {
    const base = { id: 'p', note: 'old', version: 1 };
    const mine = { id: 'p' }; // note를 지움.
    const theirs = { id: 'p', note: 'old', version: 2 }; // theirs는 note를 안 건드림.
    return daRemergeGenericConflict(mine, base, theirs, ['id']);
  });
  t('10) mine이 지운 필드(note)는 theirs가 안 건드렸으면 조용히 지워짐(되살아나지 않음)', !('note' in r1));
  t('10) 삭제만 있었으면 fieldConflicts도 안 남음(진짜 충돌이 아니므로)', !r1._fieldConflicts || !r1._fieldConflicts.note);

  // mine은 지웠는데 theirs는 그 사이 값을 실제로 고친 경우 — "지움 vs
  // 수정"의 진짜 충돌. 삭제를 우선 반영하되(mine 우선 원칙 유지)
  // theirs 값은 되살릴 수 있게 남겨야 한다.
  const r2 = await pA.evaluate(() => {
    const base = { id: 'p', note: 'old', version: 1 };
    const mine = { id: 'p' };
    const theirs = { id: 'p', note: 'NEW-FROM-OTHER-DEVICE', version: 2 };
    return daRemergeGenericConflict(mine, base, theirs, ['id']);
  });
  t('10) mine 삭제 vs theirs 수정 — 삭제가 우선 반영됨(mine 우선)', !('note' in r2));
  t('10) 이 경우엔 진짜 충돌이므로 theirs 값이 fieldConflicts에 남아 되살릴 수 있음', r2._fieldConflicts && r2._fieldConflicts.note && r2._fieldConflicts.note.theirs === 'NEW-FROM-OTHER-DEVICE' && r2._fieldConflicts.note.mine === undefined);

  // 필드를 새로 추가한 경우(원래 base/theirs 둘 다 없던 필드)는 삭제
  // 판정 로직에 안 걸리고 그냥 정상 반영돼야 한다(회귀 확인).
  const r3 = await pA.evaluate(() => {
    const base = { id: 'p', version: 1 };
    const mine = { id: 'p', memo: '새로 적은 메모' };
    const theirs = { id: 'p', version: 2 };
    return daRemergeGenericConflict(mine, base, theirs, ['id']);
  });
  t('10) 새로 추가한 필드는 정상적으로 반영됨(삭제 판정과 안 헷갈림)', r3.memo === '새로 적은 메모');

  await pA.close();
}

// =====================================================================
// 11) 2026-09-11 재검토(11차) — ChatGPT가 지적한 핵심 결함: 여행
//    (trips)의 같은-필드 충돌은 daRemergeGenericConflict가
//    _fieldConflicts를 만들어도, server/routes/trips.mjs의 syncTrips/
//    serializeTrip이 정해진 컬럼만 다뤄 재제출이 성공하는 순간 그
//    정보가 통째로 사라졌다(서버 쪽 값을 사용자가 볼 기회 자체가
//    없었다). 이제 field_conflicts 컬럼에 저장·응답에 실어 보내는지,
//    로그아웃·재접속·다른 기기에서도 살아남는지, 실제 화면의 "다른
//    기기 값으로 바꾸기" 버튼이 동작하는지까지 확인한다.
// =====================================================================
{
  const email = 'sync-devices-11@example.com';
  const city = '여행필드충돌도시';
  const pA = await newPage('A11');
  await loginViaUi(pA, email);
  const tripId = await pA.evaluate(async (cityName) => {
    const token = A.sessionToken(foodMap);
    const r = await A.api('/api/trips', { method: 'POST', token, body: { city: cityName, name: '원래 여행 이름' } });
    foodMap.trips = foodMap.trips || [];
    foodMap.trips.push(r.json.trip);
    A.saveFoodMap(foodMap);
    return r.json.trip.tripId;
  }, city);
  await pA.evaluate(() => daSyncPushSafe());
  await pA.waitForTimeout(300); // 서버 버전 1 — A의 기준선도 이 시점에 잡힘.

  const pB = await newPage('B11');
  await loginViaUi(pB, email);
  await pB.evaluate(() => daSyncPushSafe()); // 빈 trips로 push해도 서버 목록을 그대로 받아 온다 — B의 기준선도 v1로 잡힘.
  await pB.waitForTimeout(300);

  // A가 이름을 SERVER로 바꿔 먼저 저장한다(서버 버전 2).
  await pA.evaluate(() => { foodMap.trips.find((t) => t.name === '원래 여행 이름').name = 'SERVER'; A.saveFoodMap(foodMap); });
  await pA.evaluate(() => daSyncPushSafe());
  await pA.waitForTimeout(300);

  // B는 이 사실을 모른 채(기준 여전히 v1) 같은 이름 필드를 LOCAL로
  // 고쳐 저장한다 — 진짜 같은-필드 충돌.
  await pB.evaluate(() => { foodMap.trips.find((t) => t.name === '원래 여행 이름').name = 'LOCAL'; A.saveFoodMap(foodMap); });
  await pB.evaluate(() => daSyncPushSafe());
  await pB.waitForTimeout(600); // 재병합 + 자동 재시도(daScheduleConflictRetry)까지 기다린다.

  const bAfterRetry = await pB.evaluate((id) => foodMap.trips.find((t) => t.tripId === id), tripId);
  t('11) 내가 고친 이름(LOCAL)이 재시도 후에도 조용히 사라지지 않음', bAfterRetry.name === 'LOCAL');
  t('11) 재시도가 성공(서버에 저장)한 뒤에도 같은-필드 충돌 기록이 로컬에서 사라지지 않음(예전엔 여기서 사라졌다)', bAfterRetry._fieldConflicts && bAfterRetry._fieldConflicts.name && bAfterRetry._fieldConflicts.name.mine === 'LOCAL' && bAfterRetry._fieldConflicts.name.theirs === 'SERVER');

  // 서버 자체에도 필드 충돌이 저장돼 있어야 한다(re-fetch로 확인 —
  // 재현 지시의 핵심: "저장 트랜잭션 필드만 취급해 사라진다"를 직접
  // 검증).
  const tokenB = await pB.evaluate(() => foodMap.session.token);
  const serverView1 = await fetch(`${apiBase}/api/trips`, { headers: { Authorization: `Bearer ${tokenB}` } }).then((r) => r.json());
  const onServer1 = serverView1.trips.find((t) => t.tripId === tripId);
  t('11) 서버에도 필드 충돌 기록이 실제로 저장돼 있음(field_conflicts 컬럼)', onServer1._fieldConflicts && onServer1._fieldConflicts.name && onServer1._fieldConflicts.name.theirs === 'SERVER');

  // B가 "앱을 재시작"해도(새로고침) 충돌 기록이 그대로 남아 있어야
  // 한다.
  await pB.reload();
  await pB.waitForTimeout(300);
  const bAfterReload = await pB.evaluate((id) => foodMap.trips.find((t) => t.tripId === id), tripId);
  t('11) 재시작(새로고침) 후에도 여행 필드 충돌이 남아 있음', bAfterReload._fieldConflicts && bAfterReload._fieldConflicts.name);

  // 완전히 다른(세 번째) 기기로 같은 계정 로그인 — 처음 동기화하는
  // 기기도 서버에 남아 있는 필드 충돌을 볼 수 있어야 한다.
  const pC = await newPage('C11');
  await loginViaUi(pC, email);
  await pC.evaluate(() => daSyncPushSafe());
  await pC.waitForTimeout(300);
  const cTrip = await pC.evaluate((id) => foodMap.trips.find((t) => t.tripId === id), tripId);
  t('11) 처음 동기화하는 세 번째 기기에서도 서버에 남아 있던 필드 충돌을 그대로 받아 옴', cTrip && cTrip._fieldConflicts && cTrip._fieldConflicts.name && cTrip._fieldConflicts.name.theirs === 'SERVER');

  // 실제 화면(여행 블록)에 충돌 안내와 해결 버튼이 실제로 뜨는지, 눌렀을
  // 때 실제로 적용되는지 확인한다("장소에만 해결 버튼이 있는 상태로
  // 완료 처리하지 마"라는 지시의 핵심). 이 화면들은 저장된 장소가
  // 하나도 없으면 샘플(usingSample) 모드로 남아 tripBlockHTML 자체가
  // 아무것도 안 그리므로(여행 정보와 무관한 별개 조건), 최소 장소
  // 하나를 채워 실데이터 모드로 전환한다.
  await pB.evaluate((cityName) => {
    foodMap.places = [{ id: 'anyplace', name: '아무 장소', cat: '기타', catConfirmed: true, city: cityName, cityKnown: true, cityConfirmed: true, sourceLists: [] }];
    A.saveFoodMap(foodMap);
  }, city);
  await pB.evaluate((cityName) => { refreshFromStorage(); city = cityName; updateCity(); showRoute(); }, city);
  await pB.waitForTimeout(150);
  const tripBlockText = await pB.evaluate(() => document.getElementById('sheetContent').innerText);
  t('11) 오늘 동선 화면에 여행 필드 충돌 안내가 실제로 표시됨', /다른 기기와 다르게 저장/.test(tripBlockText) && tripBlockText.includes('SERVER'));
  const resolveBtn = await pB.evaluate(() => !!document.querySelector('[data-trip-conflict-resolve]'));
  t('11) "다른 기기 값으로 바꾸기" 버튼이 실제로 존재함(장소 전용이 아님)', resolveBtn);
  await pB.evaluate(() => { document.querySelector('[data-trip-conflict-resolve]').click(); });
  await pB.waitForTimeout(200);
  const bAfterResolve = await pB.evaluate((id) => foodMap.trips.find((t) => t.tripId === id), tripId);
  t('11) 버튼을 누르면 실제로 다른 기기 값이 적용되고 충돌 표시가 사라짐', bAfterResolve.name === 'SERVER' && !bAfterResolve._fieldConflicts);

  await pB.waitForTimeout(300); // 해결 결과가 서버에도 반영될 시간을 준다.
  const serverView2 = await fetch(`${apiBase}/api/trips`, { headers: { Authorization: `Bearer ${tokenB}` } }).then((r) => r.json());
  const onServer2 = serverView2.trips.find((t) => t.tripId === tripId);
  t('11) 해결 결과가 서버에도 반영돼 field_conflicts가 정리됨', !onServer2._fieldConflicts);

  await pA.close(); await pB.close(); await pC.close();
}

// =====================================================================
// 12) 2026-09-11 재검토(11차) — 코스(레거시, tripId 없음)도 같은
//    원칙으로 실제 화면에 해결 버튼이 있어야 한다(시나리오 7은 자동
//    수렴만 확인했다 — 사용자가 직접 누르는 해결 버튼 자체는 그때
//    검증되지 않았다).
// =====================================================================
{
  const email = 'sync-devices-12@example.com';
  const city = '코스해결버튼도시';
  const date = '2026-11-01';
  const pA = await newPage('A12');
  await loginViaUi(pA, email);
  await pA.evaluate((args) => {
    foodMap.courses = [{ city: args.city, date: args.date, note: 'base', stops: [], excludedIds: [], excludedReasons: {}, totalMeters: 0, walkTotal: 0, endAt: 0 }];
    A.saveFoodMap(foodMap);
  }, { city, date });
  await pA.evaluate(() => daSyncPushSafe());
  await pA.waitForTimeout(300);

  const pB = await newPage('B12');
  await loginViaUi(pB, email);
  await pB.waitForTimeout(300);

  await pA.evaluate((args) => { foodMap.courses.find((c) => c.city === args.city && c.date === args.date).note = 'SERVER-NOTE'; A.saveFoodMap(foodMap); }, { city, date });
  await pA.evaluate(() => daSyncPushSafe());
  await pA.waitForTimeout(300);

  await pB.evaluate((args) => { foodMap.courses.find((c) => c.city === args.city && c.date === args.date).note = 'LOCAL-NOTE'; A.saveFoodMap(foodMap); }, { city, date });
  await pB.evaluate(() => daSyncPushSafe());
  await pB.waitForTimeout(600);

  await pB.evaluate((args) => {
    city = args.city; updateCity();
    foodMap.course = foodMap.courses.find((c) => c.city === args.city && c.date === args.date);
    showSavedCourse();
  }, { city, date });
  await pB.waitForTimeout(150);
  const courseBlockText = await pB.evaluate(() => document.getElementById('sheetContent').innerText);
  t('12) 저장된 코스 화면에 코스 필드 충돌 안내가 실제로 표시됨', /다른 기기와 다르게 저장/.test(courseBlockText) && courseBlockText.includes('SERVER-NOTE'));
  const courseResolveBtn = await pB.evaluate(() => !!document.querySelector('[data-course-conflict-resolve]'));
  t('12) 코스 화면에도 "다른 기기 값으로 바꾸기" 버튼이 실제로 존재함', courseResolveBtn);
  await pB.evaluate(() => { document.querySelector('[data-course-conflict-resolve]').click(); });
  await pB.waitForTimeout(200);
  const bCourseAfter = await pB.evaluate((args) => foodMap.courses.find((c) => c.city === args.city && c.date === args.date), { city, date });
  t('12) 버튼을 누르면 실제로 다른 기기 값이 적용되고 충돌 표시가 사라짐', bCourseAfter.note === 'SERVER-NOTE' && !bCourseAfter._fieldConflicts);

  await pA.close(); await pB.close();
}

// =====================================================================
// 13) 2026-09-11 재검토(11차) — "HTTP 200과 동기화 완료는 다르다."
//    미해결 필드 충돌이 남아 있는 상태로 로그아웃하면, 네트워크 실패
//    메시지가 아니라 "값이 다른 항목이 남아 있다"는 별도 안내가 떠야
//    한다(allOk=true여도 hasUnresolvedConflicts=true인 경우를 조용히
//    통과시키지 않는다).
// =====================================================================
{
  const email = 'sync-devices-13@example.com';
  const city = '로그아웃구분도시';
  const pA = await newPage('A13');
  await loginViaUi(pA, email);
  const tripId = await pA.evaluate(async (cityName) => {
    const token = A.sessionToken(foodMap);
    const r = await A.api('/api/trips', { method: 'POST', token, body: { city: cityName, name: '원래 이름' } });
    foodMap.trips = foodMap.trips || [];
    foodMap.trips.push(r.json.trip);
    A.saveFoodMap(foodMap);
    return r.json.trip.tripId;
  }, city);
  await pA.evaluate(() => daSyncPushSafe());
  await pA.waitForTimeout(300);

  const pB = await newPage('B13');
  await loginViaUi(pB, email);
  await pB.evaluate(() => daSyncPushSafe());
  await pB.waitForTimeout(300);

  await pA.evaluate(() => { foodMap.trips.find((t) => t.name === '원래 이름').name = 'A-VALUE'; A.saveFoodMap(foodMap); });
  await pA.evaluate(() => daSyncPushSafe());
  await pA.waitForTimeout(300);

  await pB.evaluate(() => { foodMap.trips.find((t) => t.name === '원래 이름').name = 'B-VALUE'; A.saveFoodMap(foodMap); });
  await pB.evaluate(() => daSyncPushSafe());
  await pB.waitForTimeout(600); // 같은-필드 충돌이 B에 남는다.

  const bTrip = await pB.evaluate((id) => foodMap.trips.find((t) => t.tripId === id), tripId);
  t('13) 준비 확인 — B에 미해결 필드 충돌이 남아 있음', bTrip._fieldConflicts && bTrip._fieldConflicts.name);

  // newPage()가 이미 이 페이지의 모든 dialog를 자동 dismiss하는
  // 리스너를 등록해 뒀다(순서상 먼저 실행됨) — 여기서 또 dismiss를
  // 부르면 "이미 처리된 dialog" 오류가 난다. 메시지만 읽는다.
  let dialogMsg = '';
  pB.once('dialog', (d) => { dialogMsg = d.message(); });
  await pB.evaluate(() => daLogout());
  await pB.waitForTimeout(200);
  t('13) 미해결 충돌이 있으면 네트워크 실패 문구가 아니라 "값이 다른 항목" 전용 안내가 뜸', /값이 다른 항목/.test(dialogMsg));
  t('13) 네트워크 실패 문구는 뜨지 않음(둘을 구분함)', !/네트워크 상태를 확인/.test(dialogMsg));

  await pA.close(); await pB.close();
}

t('최종 콘솔/런타임 오류 0', errs.length === 0);
if (errs.length) console.log(errs);

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
await b.close();
server.close();
process.exit(fail ? 1 : 0);
