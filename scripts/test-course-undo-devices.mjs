/**
 * 2026-09-22(18차 재검토) 2·3절 — 날짜 이동 되돌리기의 서버 반영 + 날짜별 코스
 * 동시 수정 보호를 실제 두 기기(Chromium 두 컨텍스트 = 서로 다른 저장소)와 실제
 * 화면 버튼(장소 편집 → 다른 날짜로 옮기기 → 되돌리기)으로 확인한다.
 *
 * 재현하려던 결함(수정 전): 코스가 없던 새 날짜로 옮기기 → 동기화 → 되돌리기 →
 * 동기화를 해도 서버엔 새 날짜 코스가 남아(upsert만), 새로고침·재로그인·다른
 * 기기에서 되살아났다. 레거시 코스(tripId 없음)와 여행 코스(tripId) 둘 다.
 *
 * 확인 순서: 되돌리기 → 동기화 완료 → 새로고침 → 로그아웃·재로그인 → 다른 기기 조회.
 * 이어서 같은 날짜 동시 수정은 조용히 덮이지 않고, 다른 날짜 수정은 둘 다 남는지.
 *
 * 외부 서비스 연결 없음(로컬 서버 + 테스트 모드). 합성 데이터만 쓴다.
 * 실행: node scripts/test-course-undo-devices.mjs
 */
import { chromium } from 'playwright';

process.env.DB_PATH = ':memory:';
process.env.FORCE_TEST_MODE = 'true';
process.env.LOGIN_CODE_COOLDOWN_SECONDS = '0';
process.env.LOGIN_MAX_VERIFY_ATTEMPTS = '200';
const { createServer } = await import('../server/index.mjs');
const { sentEmailsForTest } = await import('../server/adapters/email.mjs');

let fail = 0; const t = (n, c, extra) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && extra ? ' — ' + extra : '')); if (!c) fail++; };

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const apiBase = `http://127.0.0.1:${server.address().port}`;
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errs = [];
async function newPage(label) {
  const ctx = await b.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errs.push(`pageerror(${label}): ` + e.message));
  page.on('dialog', (d) => d.accept());
  await page.addInitScript((base) => { window.API_BASE = base; }, apiBase);
  await page.goto('file://' + process.cwd() + '/src/design/index.html');
  await page.waitForTimeout(200);
  return page;
}
async function login(page, email) {
  await page.evaluate(() => showLoginSheet(() => {}));
  await page.waitForTimeout(150);
  await page.fill('#loginEmail', email);
  await page.click('#loginSendBtn');
  await page.waitForTimeout(200);
  const code = sentEmailsForTest.filter((e) => e.to === email).pop().body.match(/(\d{6})/)[1];
  await page.fill('#loginCode', code);
  await page.click('#loginVerifyBtn');
  await page.waitForFunction(() => !!(foodMap.session && foodMap.session.token), { timeout: 5000 });
  await page.waitForTimeout(400);
  await page.evaluate(() => { const c = document.getElementById('close'); if (c) c.click(); });
}
const syncNow = (page) => page.evaluate(async () => { const r = await daSyncPush(A.sessionToken(foodMap)); return r; });
async function serverCourses(page, tripId) {
  const token = await page.evaluate(() => foodMap.session.token);
  const url = tripId ? `/api/trips/${encodeURIComponent(tripId)}/courses` : '/api/courses';
  const j = await fetch(apiBase + url, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
  return Object.fromEntries((j.courses || []).map((c) => [c.date, c]));
}
const localDates = (page, tripId) => page.evaluate((tid) => (foodMap.courses || []).filter((c) => (tid ? c.tripId === tid : !c.tripId)).map((c) => c.date).sort(), tripId);

async function seed(page, tripId) {
  await page.evaluate((tid) => {
    const mk = (id, lat, lng) => ({ id, name: '합성 ' + id, city: '합성시', lat, lng, hasCoords: true, category: '맛집', note: '' });
    foodMap.places = [mk('p1', 33.59, 130.42), mk('p2', 33.593, 130.425), mk('p3', 33.596, 130.428)];
    const base = { city: '합성시', origin: { lat: 33.589, lng: 130.419 }, startMinutes: 600, mode: 'walking', routedReal: true, excludedIds: [], excludedReasons: {}, source: 'server', totalMeters: 900 };
    const c5 = { ...base, date: '2026-10-05', stops: [{ id: 'p1', name: '합성 p1', walk: 5, at: 605, dwell: 40 }, { id: 'p2', name: '합성 p2', walk: 6, at: 651, dwell: 40 }, { id: 'p3', name: '합성 p3', walk: 4, at: 695, dwell: 40 }], endAt: 735, walkTotal: 15 };
    if (tid) c5.tripId = tid;
    foodMap.courses = [c5];
    foodMap.course = c5;
    A.saveFoodMap(foodMap);
    city = '합성시'; spots = foodMap.places; usingSample = false;
  }, tripId);
}
async function moveViaUi(page, stopId, newDate) {
  // 재로그인 직후엔 "지금 보는 코스"가 비어 있다 — 화면에서 날짜를 고르는 것과 같이 10-05를 연다.
  await page.evaluate(() => {
    if (!foodMap.course || foodMap.course.date !== '2026-10-05') foodMap.course = foodMap.courses.find((c) => c.date === '2026-10-05');
    city = '합성시'; spots = foodMap.places; usingSample = false;
    showSavedCourse();
  });
  await page.waitForTimeout(150);
  await page.click(`[data-stop-edit="${stopId}"]`);
  await page.selectOption('#stopMoveTarget', '__new');
  await page.fill('#stopMoveNewDate', newDate);
  await page.click('#stopMoveBtn');
  await page.waitForTimeout(200);
}

async function scenario(label, email, useTrip) {
  const pA = await newPage(label + '-A');
  await login(pA, email);
  let tripId = null;
  if (useTrip) {
    tripId = await pA.evaluate(async () => {
      const r = await A.api('/api/trips', { method: 'POST', token: foodMap.session.token, body: { city: '합성시', name: '합성 여행' } });
      foodMap.trips = [r.json.trip];
      foodMap.currentTripByCity = { 합성시: r.json.trip.tripId };
      A.saveFoodMap(foodMap);
      return r.json.trip.tripId;
    });
  }
  await seed(pA, tripId);
  await syncNow(pA);
  let sv = await serverCourses(pA, tripId);
  t(`${label}) 시작: 서버에 10-05만`, Object.keys(sv).join() === '2026-10-05', Object.keys(sv).join());

  // 화면 버튼으로 p3를 코스가 없던 10-07로 옮김 → 동기화
  await moveViaUi(pA, 'p3', '2026-10-07');
  await pA.waitForTimeout(300);
  await syncNow(pA);
  sv = await serverCourses(pA, tripId);
  t(`${label}) 옮기기 동기화 후 서버에 10-07 생김`, !!sv['2026-10-07'] && sv['2026-10-05'].stops.length === 2, Object.keys(sv).join());

  // 화면의 되돌리기 버튼 → 동기화 완료
  await pA.evaluate(() => showSavedCourse());
  await pA.waitForTimeout(100);
  await pA.click('[data-sched-undo]');
  await pA.waitForTimeout(300);
  const r = await syncNow(pA);
  sv = await serverCourses(pA, tripId);
  t(`${label}) 되돌리기 → 동기화 완료(오류·미해결 충돌 없음)`, r.allOk && !r.hasUnresolvedConflicts, JSON.stringify(r));
  t(`${label}) 되돌리기 후 서버에서 10-07 사라짐`, !sv['2026-10-07'], Object.keys(sv).join());
  t(`${label}) 서버 10-05는 원래 세 곳(p1,p2,p3)`, sv['2026-10-05'] && sv['2026-10-05'].stops.map((s) => s.id).join() === 'p1,p2,p3');
  t(`${label}) 삭제 표시 대기열 비워짐`, await pA.evaluate(() => (foodMap.deletedCourses || []).length === 0));

  // 새로고침 → 한 번 더 동기화해도 되살아나지 않음
  await pA.reload(); await pA.waitForTimeout(400);
  await syncNow(pA);
  t(`${label}) 새로고침 후 로컬에 10-07 없음`, (await localDates(pA, tripId)).join() === '2026-10-05');
  t(`${label}) 새로고침·재동기화 후 서버에도 10-07 없음`, !(await serverCourses(pA, tripId))['2026-10-07']);

  // 로그아웃 → 재로그인
  await pA.evaluate(() => daLogout());
  await pA.waitForTimeout(300);
  await login(pA, email);
  if (useTrip) await pA.evaluate((tid) => daSyncTripCourses(tid), tripId);
  await pA.waitForTimeout(300);
  t(`${label}) 재로그인 후 로컬에 10-07 없음, 10-05 있음`, (await localDates(pA, tripId)).join() === '2026-10-05', (await localDates(pA, tripId)).join());

  // 다른 기기(B) 조회
  const pB = await newPage(label + '-B');
  await login(pB, email);
  if (useTrip) await pB.evaluate((tid) => daSyncTripCourses(tid), tripId);
  await pB.waitForTimeout(300);
  const bDates = await localDates(pB, tripId);
  t(`${label}) 다른 기기에서도 10-07 없음, 10-05 세 곳`, bDates.join() === '2026-10-05' && (await pB.evaluate((tid) => foodMap.courses.find((c) => c.date === '2026-10-05' && (tid ? c.tripId === tid : !c.tripId)).stops.length, tripId)) === 3, bDates.join());

  // 다른 기기가 옛 상태(10-07 포함)를 들고 있다가 올려도, 안 고친 코스면 따라 지움
  // — 되돌리기 전에 받아 둔 기기 C를 흉내: 옮기기를 다시 하고 C가 받은 뒤 A가 되돌린다.
  await moveViaUi(pA, 'p3', '2026-10-07');
  await syncNow(pA);
  const pC = await newPage(label + '-C');
  await login(pC, email);
  if (useTrip) await pC.evaluate((tid) => daSyncTripCourses(tid), tripId);
  await pC.waitForTimeout(200);
  t(`${label}) 기기 C가 옮긴 상태(10-07)를 받음`, (await localDates(pC, tripId)).includes('2026-10-07'));
  await pA.evaluate(() => showSavedCourse()); await pA.waitForTimeout(100);
  await pA.click('[data-sched-undo]'); await pA.waitForTimeout(200);
  await syncNow(pA);
  await syncNow(pC); // C는 되돌리기를 모른 채 자기 목록(10-07 포함)을 올림
  await pC.waitForTimeout(400);
  t(`${label}) 모르던 기기 C가 올려도 서버에 10-07 되살아나지 않음`, !(await serverCourses(pA, tripId))['2026-10-07']);
  t(`${label}) 기기 C 로컬에서도 (안 고친) 10-07이 따라 지워짐`, !(await localDates(pC, tripId)).includes('2026-10-07'), (await localDates(pC, tripId)).join());

  // 같은 날짜 동시 수정: A와 C가 같은 버전의 10-05를 각자 고침
  await syncNow(pA); await syncNow(pC);
  await pA.evaluate(() => { const c = foodMap.courses.find((x) => x.date === '2026-10-05'); c.memo = 'A 메모'; A.saveFoodMap(foodMap); });
  await syncNow(pA);
  await pC.evaluate(() => { const c = foodMap.courses.find((x) => x.date === '2026-10-05'); c.departureMinutes = 690; A.saveFoodMap(foodMap); });
  await syncNow(pC);
  await pC.waitForTimeout(500); // 충돌 재병합 후 자동 재시도
  const s5 = (await serverCourses(pA, tripId))['2026-10-05'];
  t(`${label}) 같은 날짜 동시 수정: A의 메모가 조용히 사라지지 않음`, s5.memo === 'A 메모', JSON.stringify({ memo: s5.memo }));
  t(`${label}) 같은 날짜 동시 수정: C의 출발시각도 남음(재병합)`, s5.departureMinutes === 690, String(s5.departureMinutes));

  // 다른 날짜 동시 수정은 둘 다 보존
  await pA.evaluate((tid) => { const c = { date: '2026-10-09', city: '합성시', stops: [{ id: 'p1', name: '합성 p1', walk: 3, at: 603, dwell: 30 }], origin: { lat: 33.589, lng: 130.419 }, startMinutes: 600 }; if (tid) c.tripId = tid; foodMap.courses.push(c); A.saveFoodMap(foodMap); }, tripId);
  await pC.evaluate((tid) => { const c = { date: '2026-10-10', city: '합성시', stops: [{ id: 'p2', name: '합성 p2', walk: 3, at: 603, dwell: 30 }], origin: { lat: 33.589, lng: 130.419 }, startMinutes: 600 }; if (tid) c.tripId = tid; foodMap.courses.push(c); A.saveFoodMap(foodMap); }, tripId);
  await syncNow(pA); await syncNow(pC); await syncNow(pA);
  const all = await serverCourses(pA, tripId);
  t(`${label}) 서로 다른 날짜 수정(A:10-09, C:10-10) 둘 다 서버에 남음`, !!all['2026-10-09'] && !!all['2026-10-10']);
  t(`${label}) A 기기도 C가 만든 10-10을 받음`, (await localDates(pA, tripId)).includes('2026-10-10') || !useTrip, (await localDates(pA, tripId)).join());

  await pA.close(); await pB.close(); await pC.close();
}

await scenario('레거시', 'undo-legacy@example.com', false);
await scenario('여행', 'undo-trip@example.com', true);

t('페이지 오류 없음', errs.length === 0, errs.join(' | '));
await b.close();
server.close();
if (fail) { console.log(`\n${fail} FAIL`); process.exit(1); }
console.log('\nALL PASS');
