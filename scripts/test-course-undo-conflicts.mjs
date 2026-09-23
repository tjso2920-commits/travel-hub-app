/**
 * 2026-09-23(18차 재검토 2차) 1절 — 되돌리기는 "내가 방금 한 편집"만 취소해야 한다.
 * 결함(재검토 재현): 되돌리기가 편집 전 스냅샷 전체를 복원하면서 현재 서버 버전을
 * 붙이고, 스냅샷에 없던 날짜를 전부 삭제 대상으로 만들었다 → 그 사이 다른 기기가
 * 추가한 날짜가 지워지고, 다른 기기가 고친 날짜가 옛 내용으로 덮였다(conflicts:[]).
 * 실제 화면 버튼(옮기기·되돌리기)과 Chromium 여러 컨텍스트(기기)로 확인한다.
 * 외부 서비스 연결 없음(로컬 서버 + 테스트 모드), 합성 데이터만.
 * 실행: node scripts/test-course-undo-conflicts.mjs
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


const S = (ids) => ids.map((id, i) => ({ id, name: '합성 ' + id, walk: 5, at: 605 + i * 50, dwell: 40 }));
const PLACES = () => ['p1', 'p2', 'p3', 'p4'].map((id, i) => ({ id, name: '합성 ' + id, city: '합성시', lat: 33.59 + i * 0.003, lng: 130.42 + i * 0.003, hasCoords: true, category: '맛집', note: '' }));
async function setup(page, tripId, courses) {
  await page.evaluate(({ tid, cs, places }) => {
    foodMap.places = places;
    foodMap.courses = cs.map((c) => ({ city: '합성시', origin: { lat: 33.589, lng: 130.419 }, startMinutes: 600, mode: 'walking', routedReal: true, excludedIds: [], excludedReasons: {}, source: 'server', totalMeters: 900, ...c, ...(tid ? { tripId: tid } : {}) }));
    foodMap.course = foodMap.courses[0];
    A.saveFoodMap(foodMap);
    city = '합성시'; spots = foodMap.places; usingSample = false;
  }, { tid: tripId, cs: courses, places: PLACES() });
}
async function makeTrip(page, name) {
  return page.evaluate(async (nm) => {
    const r = await A.api('/api/trips', { method: 'POST', token: foodMap.session.token, body: { city: '합성시', name: nm } });
    foodMap.trips = [...(foodMap.trips || []), r.json.trip];
    foodMap.currentTripByCity = { 합성시: (foodMap.currentTripByCity && foodMap.currentTripByCity['합성시']) || r.json.trip.tripId };
    A.saveFoodMap(foodMap);
    return r.json.trip.tripId;
  }, name);
}
const openDate = (page, date, tid) => page.evaluate(({ d, t }) => { foodMap.course = foodMap.courses.find((c) => c.date === d && (t ? c.tripId === t : !c.tripId)); city = '합성시'; spots = foodMap.places; usingSample = false; showSavedCourse(); }, { d: date, t: tid });
async function pull(page, tripIds) { await syncNow(page); for (const t of tripIds) await page.evaluate((x) => daSyncTripCourses(x), t); }
const localCourse = (page, date, tid) => page.evaluate(({ d, t }) => foodMap.courses.find((c) => c.date === d && (t ? c.tripId === t : !c.tripId)) || null, { d: date, t: tid });
async function clickUndo(page, date, tid) { await openDate(page, date, tid); await page.waitForTimeout(80); await page.click('[data-sched-undo]'); await page.waitForTimeout(250); }

// ── 시나리오 1: 내가 출발 시각 변경 → 다른 기기가 같은 여행에 새 날짜 추가 + 다른 여행에도 날짜 추가 → 동기화 → 내가 되돌리기
async function scenario1(label, email, useTrip) {
  const pA = await newPage(label + '1-A'); await login(pA, email);
  const trip = useTrip ? await makeTrip(pA, '여행1') : null;
  const trip2 = useTrip ? await makeTrip(pA, '여행2') : null;
  await setup(pA, trip, [{ date: '2026-10-25', departureMinutes: 600, stops: S(['p1', 'p2']), memo: 'old' }]);
  await syncNow(pA);
  const pB = await newPage(label + '1-B'); await login(pB, email); await pull(pB, useTrip ? [trip, trip2] : []);
  // A: 출발 시각 10:00 → 11:30 (화면의 출발 시각 저장과 같은 함수)
  await openDate(pA, '2026-10-25', trip);
  await pA.evaluate(() => { const DS = window.DaySchedule; daCommitCourseEdits([DS.recompute(Object.assign({}, foodMap.course, { departureMinutes: 690 }))], '출발 시각'); });
  await syncNow(pA);
  // B: 같은 여행에 10-29 추가, 다른 여행(또는 레거시)에 11-02 추가
  await pB.evaluate(({ t, t2 }) => {
    const mk = (d, tid) => ({ date: d, city: '합성시', startMinutes: 600, departureMinutes: 600, origin: { lat: 33.589, lng: 130.419 }, stops: [{ id: 'p4', name: '합성 p4', walk: 3, at: 603, dwell: 30 }], ...(tid ? { tripId: tid } : {}) });
    foodMap.courses.push(mk('2026-10-29', t)); if (t2) foodMap.courses.push(mk('2026-11-02', t2));
    A.saveFoodMap(foodMap);
  }, { t: trip, t2: trip2 });
  await syncNow(pB);
  await pull(pA, useTrip ? [trip] : []);
  t(`${label}1) A가 B의 10-29를 받은 뒤 되돌리기 시작`, !!(await localCourse(pA, '2026-10-29', trip)));
  await clickUndo(pA, '2026-10-25', trip);
  const r = await syncNow(pA);
  const sv = await serverCourses(pA, trip);
  t(`${label}1) 되돌리기 후 내 편집(출발 11:30)만 취소 → 10:00`, sv['2026-10-25'] && sv['2026-10-25'].departureMinutes === 600, JSON.stringify(sv['2026-10-25'] && sv['2026-10-25'].departureMinutes));
  t(`${label}1) 다른 기기가 추가한 같은 여행 10-29는 서버에 그대로`, !!sv['2026-10-29'], Object.keys(sv).join());
  t(`${label}1) 충돌 없이 동기화`, r.allOk && !r.hasUnresolvedConflicts, JSON.stringify(r));
  if (useTrip) t(`${label}1) 다른 여행의 11-02도 그대로`, !!(await serverCourses(pA, trip2))['2026-11-02']);
  await pA.reload(); await pA.waitForTimeout(400); await syncNow(pA);
  t(`${label}1) 새로고침 후에도 10-29 있음·10-25 출발 10:00`, !!(await localCourse(pA, '2026-10-29', trip)) && (await localCourse(pA, '2026-10-25', trip)).departureMinutes === 600);
  await pA.evaluate(() => daLogout()); await pA.waitForTimeout(300); await login(pA, email); await pull(pA, useTrip ? [trip, trip2] : []);
  t(`${label}1) 재로그인 후에도 10-29 있음`, !!(await localCourse(pA, '2026-10-29', trip)));
  const pC = await newPage(label + '1-C'); await login(pC, email); await pull(pC, useTrip ? [trip, trip2] : []);
  t(`${label}1) 다른 기기 조회: 10-29 있음·10-25 출발 10:00${useTrip ? '·다른 여행 11-02 있음' : ''}`, !!(await localCourse(pC, '2026-10-29', trip)) && (await localCourse(pC, '2026-10-25', trip)).departureMinutes === 600 && (!useTrip || !!(await localCourse(pC, '2026-11-02', trip2))));
  await pA.close(); await pB.close(); await pC.close();
}

// ── 시나리오 2: 내가 날짜 이동(10-25 → 10-26) → 다른 기기가 출발(또는 도착) 날짜를 수정 → 동기화 → 되돌리기
async function scenario2(label, email, which) {
  const pA = await newPage(label + '2-A'); await login(pA, email);
  const trip = await makeTrip(pA, '여행');
  await setup(pA, trip, [
    { date: '2026-10-25', departureMinutes: 600, stops: S(['p1', 'p2', 'p3']), memo: 'old' },
    { date: '2026-10-26', departureMinutes: 600, stops: S(['p4']), memo: 'old' },
  ]);
  await syncNow(pA);
  const pB = await newPage(label + '2-B'); await login(pB, email); await pull(pB, [trip]);
  // A: 화면에서 p3를 10-26으로 옮김
  await openDate(pA, '2026-10-25', trip);
  await pA.click('[data-stop-edit="p3"]');
  await pA.selectOption('#stopMoveTarget', '2026-10-26');
  await pA.click('#stopMoveBtn');
  await pA.waitForTimeout(200);
  await syncNow(pA);
  await pull(pB, [trip]);
  const edited = which === 'source' ? '2026-10-25' : '2026-10-26';
  await pB.evaluate(({ d, t }) => { const c = foodMap.courses.find((x) => x.date === d && x.tripId === t); c.memo = 'B-new'; A.saveFoodMap(foodMap); }, { d: edited, t: trip });
  await syncNow(pB);
  await pull(pA, [trip]);
  t(`${label}2-${which}) A가 B의 메모(${edited})를 받음`, (await localCourse(pA, edited, trip)).memo === 'B-new');
  await clickUndo(pA, '2026-10-25', trip);
  const toast = await pA.evaluate(() => (document.getElementById('toast') || {}).textContent || '');
  await syncNow(pA);
  const sv = await serverCourses(pA, trip);
  t(`${label}2-${which}) 다른 기기가 고친 ${edited} 메모가 옛 값으로 돌아가지 않음`, sv[edited].memo === 'B-new', sv[edited].memo);
  const ids25 = sv['2026-10-25'].stops.map((s) => s.id).join(), ids26 = sv['2026-10-26'].stops.map((s) => s.id).join();
  t(`${label}2-${which}) 되돌리기는 보류 — 옮긴 상태 그대로(장소가 두 날짜에 겹치거나 사라지지 않음)`, ids25 === 'p1,p2' && ids26 === 'p4,p3', `${ids25} / ${ids26}`);
  t(`${label}2-${which}) 보류 이유를 사용자에게 알림`, /되돌리지 않았|보류/.test(toast), toast);
  t(`${label}2-${which}) 되돌리기 기록은 비워짐(같은 버튼으로 다시 덮어쓰기 방지)`, await pA.evaluate(() => !daLastCourseUndo));
  await pA.close(); await pB.close();
}

await scenario1('여행', 'undo-c1-trip@example.com', true);
await scenario1('레거시', 'undo-c1-legacy@example.com', false);
await scenario2('여행', 'undo-c2-src@example.com', 'source');
await scenario2('여행', 'undo-c2-dst@example.com', 'target');

t('페이지 오류 없음', errs.length === 0, errs.join(' | '));
await b.close();
server.close();
if (fail) { console.log(`\n${fail} FAIL`); process.exit(1); }
console.log('\nALL PASS');
