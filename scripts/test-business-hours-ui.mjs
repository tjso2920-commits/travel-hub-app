/**
 * 2026-09-22(18차) 3·4절 — 날짜별 일정·영업시간 실제 화면 검증
 * (실제 Chromium + 이 저장소 서버를 같은 프로세스에서 띄움, 영업시간은
 * 서버의 합성 데이터 어댑터 — 실제 Google 호출 아님).
 *
 *  1) 코스 화면에 날짜+요일, 기준 시간대, 출발 시각이 보인다.
 *  2) 화면을 열기·다시 그리기·스크롤만으로는 영업시간 요청이 0건.
 *  3) "영업시간 확인"을 누르면 위치 확인된 장소만 1번에 묻고, 휴무·
 *     쉬는 시간·영업 중·정보 없음을 장소별로 구분해 보여 준다(출처·
 *     기준·확인 시각 포함). 위치 미확인 장소는 "휴무"로 말하지 않는다.
 *  4) 영업시간이 localStorage(동기화 원본)에 남지 않는다.
 *  5) 출발 시각 변경 → 도착 시각이 다시 계산되고 저장된다(경로 재계산
 *     요청 없음).
 *  6) 방문 시각 지정·머무는 시간 변경이 반영된다.
 *  7) 다른 날짜로 옮기기 — 도착 날짜의 기존 코스는 그대로, 맨 뒤에 추가.
 *     되돌리기로 원상복구.
 *  8) 코스에서 빼기 — 장소 목록에는 남는다.
 *  9) 로컬 저장 실패 시 바꾸기 전 일정으로 되돌린다.
 * 10) 계정 전환(세대 변경) 뒤 늦게 온 영업시간 응답은 반영하지 않는다.
 * 11) 느린 네트워크 — 코스 목록은 먼저 보이고 영업시간은 따로 채워진다.
 * 12) 서버에서 영업시간 기능이 꺼져 있으면 버튼 자체를 숨긴다.
 * 13) 새로 만든 버튼·링크가 44×44px 이상.
 * 14) 코스 생성 화면: 미래 날짜 출발 기본값 09:00, 고른 출발 시각이
 *     서버 요청(startMinutes)에 그대로 실린다(지금 시각 강제 안 함).
 * 15) 한국 시간대 기기에서 "+ 날짜 추가"가 마지막 날짜의 다음날을 제안.
 *
 * 실행: node scripts/test-business-hours-ui.mjs
 */
import { chromium } from 'playwright';

process.env.DB_PATH = ':memory:';
process.env.FORCE_TEST_MODE = 'true';
process.env.LOGIN_CODE_COOLDOWN_SECONDS = '0';
const { createServer } = await import('../server/index.mjs');
const { sentEmailsForTest } = await import('../server/adapters/email.mjs');
const { openDb, nowIso } = await import('../server/db.mjs');

let fail = 0; const t = (n, c, extra) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (extra != null && !c ? ' — ' + extra : '')); if (!c) fail++; };

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const apiBase = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const context = await browser.newContext({ timezoneId: 'Asia/Seoul', viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('dialog', (d) => d.dismiss());
const hoursRequests = [];
const generateBodies = [];
page.on('request', (r) => {
  if (r.url().includes('/api/places/hours')) hoursRequests.push(r.postDataJSON());
  if (r.url().includes('/api/course/generate')) generateBodies.push(r.postDataJSON());
});
await page.addInitScript((base) => { window.API_BASE = base; }, apiBase);
await page.goto('file://' + process.cwd() + '/src/design/index.html');
await page.waitForTimeout(300);

async function login(email) {
  await page.evaluate(() => showLoginSheet(() => sheet.close()));
  await page.waitForTimeout(100);
  await page.fill('#loginEmail', email);
  await page.click('#loginSendBtn');
  await page.waitForTimeout(200);
  const code = sentEmailsForTest.filter((e) => e.to === email).pop().body.match(/(\d{6})/)[1];
  await page.fill('#loginCode', code);
  await page.click('#loginVerifyBtn');
  await page.waitForFunction(() => !!(foodMap.session && foodMap.session.token), { timeout: 5000 });
  await page.waitForTimeout(300);
  const db = openDb();
  return db.prepare('SELECT id FROM accounts WHERE email = ?').get(email).id;
}

const acc = await login('hours-ui@example.com');
const db = openDb();
for (const id of ['test-hours-break', 'test-hours-closed-mon', 'test-hours-lunch', 'test-hours-evening']) {
  db.prepare('INSERT OR IGNORE INTO entitlement_place_confirmed (account_id, real_place_id, first_period_id, confirmed_at) VALUES (?, ?, ?, ?)').run(acc, id, 'free', nowIso());
}

// 합성 장소·코스(실제 가게 아님). 2026-10-05는 월요일.
await page.evaluate(() => {
  const mk = (id, name, lat, lng, placeId) => ({ id, name, city: '후쿠오카', lat, lng, hasCoords: true, placeId, category: '맛집', note: '' });
  foodMap.places = [
    mk('p1', '합성 식당 A', 33.590, 130.420, 'test-hours-break'),
    mk('p2', '합성 카페 B', 33.593, 130.425, 'test-hours-closed-mon'),
    mk('p3', '합성 가게 C', 33.596, 130.428, 'test-hours-lunch'),
    mk('p4', '합성 가게 D(위치 미확인)', 33.598, 130.431, undefined),
    mk('p5', '합성 바 E', 33.580, 130.400, 'test-hours-evening'),
  ];
  const courseA = {
    date: '2026-10-05', city: '후쿠오카', origin: { lat: 33.589, lng: 130.419 }, startMinutes: 600, mode: 'walking', routedReal: true,
    stops: [
      { id: 'p1', name: '합성 식당 A', walk: 5, at: 605, dwell: 40 },
      { id: 'p2', name: '합성 카페 B', walk: 10, at: 655, dwell: 60 },
      { id: 'p3', name: '합성 가게 C', walk: 8, at: 723, dwell: 40 },
      { id: 'p4', name: '합성 가게 D(위치 미확인)', walk: 6, at: 769, dwell: 30 },
    ],
    endAt: 799, walkTotal: 29, totalMeters: 2100, excludedIds: [], excludedReasons: {}, source: 'server',
  };
  const courseB = {
    date: '2026-10-06', city: '후쿠오카', origin: { lat: 33.58, lng: 130.40 }, startMinutes: 1080, mode: 'walking', routedReal: true,
    stops: [{ id: 'p5', name: '합성 바 E', walk: 3, at: 1083, dwell: 60, fixedAt: 1083 }],
    endAt: 1143, walkTotal: 3, totalMeters: 200, excludedIds: [], excludedReasons: {}, source: 'server',
  };
  foodMap.courses = [courseA, courseB];
  foodMap.course = courseA;
  A.saveFoodMap(foodMap);
  city = '후쿠오카';
  spots = foodMap.places;
  usingSample = false;
  showSavedCourse();
});
await page.waitForTimeout(200);

// 1) 머리글
{
  const head = await page.textContent('.sched-head');
  t('1) 날짜+요일 표시(10월 5일 (월))', head.includes('10월 5일 (월)'), head);
  t('1) 기준 시간대 표시(Asia/Tokyo)', head.includes('Asia/Tokyo'), head);
  t('1) 출발 시각 표시(10:00)', head.includes('출발 10:00'), head);
  const tabs = await page.$$eval('[data-day]', (els) => els.map((e) => e.textContent));
  t('1) 날짜 탭에 요일 표시', tabs.some((x) => x.includes('10월 6일 (화)')), JSON.stringify(tabs));
}

// 2) 열기·다시 그리기·스크롤만으로는 요청 0건
{
  await page.evaluate(() => { showSavedCourse(); showSavedCourse(); document.getElementById('sheetContent').scrollTop = 500; });
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(300);
  t('2) 화면 열기·다시 그리기·스크롤로는 영업시간 요청 0건', hoursRequests.length === 0, String(hoursRequests.length));
}

// 3) 영업시간 확인
{
  const btnText = await page.textContent('[data-hours-check]');
  t('3) 버튼에 확인할 곳 수 표시(위치 확인된 3곳)', btnText.includes('3곳'), btnText);
  await page.click('[data-hours-check]');
  await page.waitForFunction(() => document.querySelector('[data-hours-stop="p1"]').textContent.length > 0, { timeout: 5000 });
  t('3) 요청 1번, 위치 확인된 placeId만', hoursRequests.length === 1 && JSON.stringify(hoursRequests[0].placeIds.sort()) === JSON.stringify(['test-hours-break', 'test-hours-closed-mon', 'test-hours-lunch']), JSON.stringify(hoursRequests));
  const line = async (id) => page.textContent(`[data-hours-stop="${id}"]`);
  const l1 = await line('p1'), l2 = await line('p2'), l3 = await line('p3'), l4 = await line('p4');
  t('3) 10:05 도착 11:30 오픈 → "문을 열어요" 경고', /11:30에 문을 열어요/.test(l1), l1);
  t('3) 월요일 정기휴무 → 휴무 경고', /이 날은 휴무예요/.test(l2), l2);
  t('3) 12:03 도착 점심 영업 → 영업 중', /영업 중 도착/.test(l3), l3);
  t('3) 위치 미확인 장소는 판정 없음(휴무라고 안 함)', l4.trim() === '', l4);
  t('3) 출처·기준·확인 시각 표시', /합성 테스트 데이터/.test(l1) && /정규 영업시간 기준 · 방문 전 재확인/.test(l1) && /확인/.test(l1), l1);
  const foot = await page.textContent('.sched-hours');
  t('3) 위치 미확인 1곳 안내', foot.includes('위치 확인 전인 1곳'), foot);
  const gmaps = await page.getAttribute('.route-row .sched-actions a', 'href');
  t('3) 구글 지도 확인 링크(placeId 포함)', gmaps.includes('query_place_id=test-hours-break'), gmaps);
  const warnCls = await page.$eval('[data-hours-stop="p2"] p', (e) => e.className);
  t('3) 경고는 경고 스타일', warnCls === 'hours-warn', warnCls);
}

// 4) 저장 안 됨
{
  const leaked = await page.evaluate(() => {
    const all = [];
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); all.push(localStorage.getItem(k) || ''); }
    const text = all.join('\n');
    return ['합성 테스트 장소', 'weekdayDescriptions', 'regularOpeningHours', '"periods"', 'businessStatus'].filter((x) => text.includes(x));
  });
  t('4) 영업시간 내용이 localStorage에 없음', leaked.length === 0, leaked.join(','));
  const courseJson = await page.evaluate(() => JSON.stringify(foodMap.courses));
  t('4) 코스 데이터(동기화 원본)에 영업시간 없음', !/periods|weekdayDescriptions|businessStatus/.test(courseJson));
  await page.evaluate(() => showSavedCourse());
  await page.waitForTimeout(150);
  const again = await page.textContent('[data-hours-stop="p2"]');
  t('4) 다시 그려도 이번 세션 메모리로 표시(재요청 없음)', /휴무/.test(again) && hoursRequests.length === 1);
}

// 5) 출발 시각 변경
{
  await page.click('[data-sched-depart]');
  await page.fill('#departInput', '11:30');
  await page.click('#departSaveBtn');
  await page.waitForTimeout(200);
  const st = await page.evaluate(() => ({ dep: foodMap.course.departureMinutes, at: foodMap.course.stops.map((s) => s.at), saved: JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => k.includes('foodmap')))) }));
  t('5) 출발 11:30 → 첫 도착 11:35, 이후 순서대로', st.dep === 690 && st.at[0] === 695 && st.at[1] === 745, JSON.stringify(st.at));
  t('5) 저장소에도 반영', st.saved && st.saved.course && st.saved.course.departureMinutes === 690);
  const l1 = await page.textContent('[data-hours-stop="p1"]');
  t('5) 영업시간 판정도 새 시각으로(11:35 도착 → 영업 중)', /영업 중 도착/.test(l1) && hoursRequests.length === 1, l1);
  t('5) 코스 재생성 요청 없음(비용 없는 재계산)', generateBodies.length === 0);
}

// 6) 방문 시각 지정·머무는 시간
{
  await page.click('[data-stop-edit="p3"]');
  await page.fill('#stopFixedAt', '14:20');
  await page.fill('#stopDwell', '50');
  await page.fill('#stopNote', '현지에서 들은 말: 라스트오더 14:30');
  await page.click('#stopSaveBtn');
  await page.waitForTimeout(200);
  const s3 = await page.evaluate(() => foodMap.course.stops.find((s) => s.id === 'p3'));
  t('6) 방문 시각 14:20 지정 + 머무는 50분 저장', s3.fixedAt === 860 && s3.at === 860 && s3.dwell === 50);
  const row = await page.textContent('[data-hours-stop="p3"]');
  t('6) 14:20 도착·50분 → 15:00 종료 전 시간 부족 경고', /영업 종료 — 머무는 50분보다 짧아요/.test(row), row);
  const memo = await page.textContent('.sched-memo');
  t('6) 내 메모는 제공자 정보와 따로 표시', memo.includes('내 메모: 현지에서 들은 말') && !row.includes('라스트오더'));
}

// 7) 다른 날짜로 옮기기 + 되돌리기
{
  await page.click('[data-stop-edit="p1"]');
  await page.selectOption('#stopMoveTarget', '2026-10-06');
  await page.click('#stopMoveBtn');
  await page.waitForTimeout(200);
  const st = await page.evaluate(() => ({
    viewing: foodMap.course.date,
    a: foodMap.courses.find((c) => c.date === '2026-10-05').stops.map((s) => s.id),
    b: foodMap.courses.find((c) => c.date === '2026-10-06').stops.map((s) => ({ id: s.id, at: s.at, fixedAt: s.fixedAt, est: s.walkEstimated })),
  }));
  t('7) 원래 날짜에서 빠짐', JSON.stringify(st.a) === JSON.stringify(['p2', 'p3', 'p4']), JSON.stringify(st.a));
  t('7) 도착 날짜 기존 장소는 순서·시각 그대로, 옮긴 곳은 맨 뒤(추정 표시)', st.b[0].id === 'p5' && st.b[0].at === 1083 && st.b[0].fixedAt === 1083 && st.b[1].id === 'p1' && st.b[1].est === true, JSON.stringify(st.b));
  t('7) 화면은 원래 보던 날짜 유지', st.viewing === '2026-10-05');
  await page.click('[data-sched-undo]');
  await page.waitForTimeout(200);
  const back = await page.evaluate(() => ({
    a: foodMap.courses.find((c) => c.date === '2026-10-05').stops.map((s) => s.id),
    b: foodMap.courses.find((c) => c.date === '2026-10-06').stops.map((s) => s.id),
  }));
  t('7) 되돌리기로 두 날짜 모두 원상복구', JSON.stringify(back.a) === JSON.stringify(['p1', 'p2', 'p3', 'p4']) && JSON.stringify(back.b) === JSON.stringify(['p5']), JSON.stringify(back));
  // 새 날짜로 옮기기
  await page.click('[data-stop-edit="p4"]');
  await page.selectOption('#stopMoveTarget', '__new');
  await page.fill('#stopMoveNewDate', '2026-10-08');
  await page.click('#stopMoveBtn');
  await page.waitForTimeout(200);
  const nd = await page.evaluate(() => { const c = foodMap.courses.find((x) => x.date === '2026-10-08'); return c && c.stops.map((s) => s.id); });
  t('7) 코스 없는 새 날짜로 옮기면 한 곳짜리 새 코스', JSON.stringify(nd) === JSON.stringify(['p4']));
}

// 8) 코스에서 빼기
{
  await page.click('[data-stop-edit="p2"]');
  await page.click('#stopRemoveBtn');
  await page.waitForTimeout(200);
  const st = await page.evaluate(() => ({ ids: foodMap.course.stops.map((s) => s.id), stillSaved: !!foodMap.places.find((p) => p.id === 'p2') }));
  t('8) 코스에서 빠지고 장소 목록엔 남음', !st.ids.includes('p2') && st.stillSaved, JSON.stringify(st));
}

// 9) 저장 실패 → 되돌림
{
  const before = await page.evaluate(() => foodMap.course.departureMinutes);
  await page.evaluate(() => { window.__origSave = A.saveFoodMap; A.saveFoodMap = () => false; });
  await page.click('[data-sched-depart]');
  await page.fill('#departInput', '07:00');
  await page.click('#departSaveBtn');
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => { A.saveFoodMap = window.__origSave; return { dep: foodMap.course.departureMinutes, viewing: foodMap.course.date, count: foodMap.courses.length }; });
  t('9) 로컬 저장 실패 시 바꾸기 전 일정 유지', after.dep === before && after.viewing === '2026-10-05', JSON.stringify(after));
}

// 10) 계정 전환 뒤 늦은 응답 버림 + 11) 느린 네트워크
{
  await page.evaluate(() => showSavedCourse());
  let release;
  const gate = new Promise((r) => { release = r; });
  await page.route('**/api/places/hours', async (route) => { await gate; await route.continue(); });
  await page.click('[data-hours-check]');
  await page.waitForTimeout(150);
  const rowsVisible = await page.$$eval('.sched-row', (els) => els.length);
  const btnBusy = await page.textContent('[data-hours-check]');
  t('11) 영업시간 응답 전에도 코스 목록은 이미 보임', rowsVisible >= 2 && btnBusy.includes('확인 중'), `${rowsVisible} ${btnBusy}`);
  await page.evaluate(() => { sessionEpoch++; });
  release();
  await page.waitForTimeout(400);
  const got = await page.evaluate(() => daHoursGet('test-hours-lunch'));
  t('10) 세대가 바뀐 뒤 도착한 응답은 메모리에 안 들어감', got === null);
  await page.unroute('**/api/places/hours');
}

// 12) 기능 꺼짐 → 버튼 숨김
{
  await page.evaluate(() => { daServerServices = { businessHours: 'disabled' }; showSavedCourse(); });
  const hasBtn = await page.$('[data-hours-check]');
  t('12) 서버에서 꺼져 있으면 버튼 없음', !hasBtn);
  await page.evaluate(() => { daServerServices = { businessHours: 'test' }; showSavedCourse(); });
}

// 13) 터치 영역
{
  const small = await page.$$eval('[data-sched-depart], [data-hours-check], .sched-actions button, .sched-actions a', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { t: e.textContent.trim().slice(0, 12), w: Math.round(r.width), h: Math.round(r.height) }; }).filter((x) => x.w < 44 || x.h < 44));
  t('13) 새 버튼·링크 44×44px 이상', small.length === 0, JSON.stringify(small));
  await page.click('[data-stop-edit="p3"]');
  const small2 = await page.$$eval('#stopFixedAt, #stopDwell, #stopMoveTarget, #stopSaveBtn, #stopMoveBtn, #stopRemoveBtn', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { id: e.id, h: Math.round(r.height), w: Math.round(r.width) }; }).filter((x) => x.h < 44 || x.w < 44));
  t('13) 일정 바꾸기 화면 입력·버튼 44px 이상', small2.length === 0, JSON.stringify(small2));
}

// 14) 코스 생성 화면 출발 시각
{
  await page.evaluate(() => { route.clear(); ['p1', 'p3'].forEach((id) => route.add(id)); buildCourseSheet({ date: '2026-10-10' }); });
  await page.waitForTimeout(100);
  const v = await page.inputValue('#courseStartTime');
  t('14) 미래 날짜 출발 기본값 09:00', v === '09:00', v);
  const today = await page.evaluate(() => A.destNow(city).ymd);
  await page.fill('#courseDate', today);
  await page.dispatchEvent('#courseDate', 'change');
  const vToday = await page.inputValue('#courseStartTime');
  const nowMin = await page.evaluate(() => { const n = A.destNow(city); return n.hour * 60 + n.minute; });
  const [hh, mm] = vToday.split(':').map(Number);
  t('14) 오늘로 바꾸면 기본값이 현지 지금 시각(10분 올림)', Math.abs(hh * 60 + mm - Math.ceil(nowMin / 10) * 10) <= 10 || nowMin > 23 * 60 + 40, vToday);
  await page.fill('#courseDate', '2026-10-10');
  await page.fill('#courseStartTime', '08:20');
  await page.dispatchEvent('#courseStartTime', 'input');
  await page.click('[data-start-pick="p1"]');
  await page.waitForTimeout(1500);
  const body = generateBodies[generateBodies.length - 1];
  t('14) 고른 출발 시각(08:20)이 그대로 서버로(지금 시각 강제 안 함)', body && body.startMinutes === 500 && body.date === '2026-10-10', JSON.stringify(body && { s: body.startMinutes, d: body.date }));
}

// 15) 한국 시간대 기기에서 다음 날짜 제안
{
  const next = await page.evaluate(() => daNextDay('후쿠오카'));
  const last = await page.evaluate(() => daCoursesForCity('후쿠오카').map((c) => c.date).sort().pop());
  const expected = await page.evaluate((d) => window.DaySchedule.addDaysYmd(d, 1), last);
  t('15) (Asia/Seoul 기기) "+ 날짜 추가" 기본값이 마지막 날짜의 다음날', next === expected && next !== last, `${last} → ${next}`);
}

t('페이지 오류 없음', errs.length === 0, errs.join(' | '));
await browser.close();
server.close();
if (fail) { console.log(`\n${fail} FAIL`); process.exit(1); }
console.log('\nALL PASS');
