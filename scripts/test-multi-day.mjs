/**
 * 여러 날짜 일정(멀티데이) 검증 — 실제 Chromium + 실제 서버(임시 포트).
 *
 * 2026-09-10 확정 사업 방향: 무료는 "개인화 코스 생성 성공 1회"까지고,
 * 그 이후의 "추가 코스 생성·조건 변경 후 재계산·여러 날짜 일정 정리"는
 * 전부 유료다. 이 스크립트는:
 * 1) 날짜 탭으로 이미 만든 날짜를 오가며 보는 건 항상 무료(서버에 안 물음)
 * 2) "+ 날짜 추가"는 유료 게이트(paywall_viewed trigger=new_day)를 탐
 * 3) 같은 날짜 "새로 만들기"(재계산)는 새 날짜를 만들지 않고 그 자리를
 *    덮어씀(중복 날짜가 안 생김)
 * 4) 환불로 이용권이 사라져도 이미 만든 날짜들은 계속 열람 가능(만료
 *    후에도 기존 장소와 코스 열람 유지)
 * 를 실제로 눌러서 확인한다.
 */
import { chromium } from 'playwright';

process.env.DB_PATH = ':memory:';
process.env.FORCE_TEST_MODE = 'true';
process.env.ROUTING_TEST_FORCE = 'success';
const { createServer } = await import('../server/index.mjs');
const { openDb } = await import('../server/db.mjs');
const { sentEmailsForTest } = await import('../server/adapters/email.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const apiBase = `http://127.0.0.1:${port}`;

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('dialog', (d) => d.dismiss());

await p.addInitScript((base) => { window.API_BASE = base; }, apiBase);
await p.goto('file://' + process.cwd() + '/src/design/index.html');
await p.waitForTimeout(300);

await p.evaluate(() => {
  foodMap.places = [
    { id: 'c1', name: '출발점', lat: 33.590, lng: 130.400, cat: '카페·디저트', catConfirmed: true, sourceLists: [] },
    { id: 'c2', name: '두번째곳', lat: 33.591, lng: 130.401, cat: '맛집·식당', catConfirmed: true, sourceLists: [] },
  ];
  delete foodMap.course;
  delete foodMap.courses;
  delete foodMap.session;
  A.saveFoodMap(foodMap);
});
await p.reload();
await p.waitForTimeout(300);

// --- 2026-09-10 재검토(3차): 실제 데이터는 첫 코스부터 로그인이
// 필요하다 — 멀티데이 검증 이전에 먼저 로그인부터 마친다. ---
const testEmail = 'multiday-tester@example.com';
await p.evaluate(() => { ['c1', 'c2'].forEach((id) => route.add(id)); });
await p.evaluate(() => showRoute());
await p.waitForTimeout(150);
await p.click('[data-build-course]');
await p.waitForTimeout(200);
const loginTitle = await p.textContent('#sheetLabel');
t('실제 데이터는 첫 코스부터 로그인부터 요구함', loginTitle === '로그인');
await p.fill('#loginEmail', testEmail);
await p.click('#loginSendBtn');
await p.waitForTimeout(200);
{
  const emailSent = sentEmailsForTest.filter((e) => e.to === testEmail).pop();
  const code = emailSent.body.match(/(\d{6})/)[1];
  await p.fill('#loginCode', code);
  await p.click('#loginVerifyBtn');
  await p.waitForFunction(() => document.getElementById('sheetLabel').textContent !== '코드 확인', { timeout: 5000 });
}
const afterLoginForDay1 = await p.textContent('#sheetLabel');
t('로그인 성공 뒤 곧바로 출발지 화면(첫 코스는 여전히 무료)', afterLoginForDay1 === '출발지 정하기');

// --- 1일차 코스(무료 체험) ---
const day1Default = await p.inputValue('#courseDate');
t('출발지 화면에 날짜 입력이 있고 기본값이 채워져 있음', !!day1Default);
await p.click('[data-start-pick="c1"]');
await p.waitForTimeout(800);
const afterDay1 = await p.evaluate(() => ({ course: foodMap.course, courses: foodMap.courses }));
t('1일차 코스가 실제로 만들어짐', afterDay1.course && afterDay1.course.stops.length === 1);
t('foodMap.courses 배열에도 1개 항목으로 반영됨', Array.isArray(afterDay1.courses) && afterDay1.courses.length === 1);
t('그 항목의 날짜가 courseDate 기본값과 같음', afterDay1.courses[0].date === day1Default);
const day1Date = afterDay1.course.date;

// --- 날짜 탭이 화면에 보이는지, "+ 날짜 추가" 버튼이 있는지 ---
const savedCourseHtml = await p.textContent('#sheetContent');
t('저장된 코스 화면에 현재 날짜 탭이 보임', savedCourseHtml.includes(day1Date));
const hasAddDayBtn = await p.evaluate(() => !!document.querySelector('[data-day-new]'));
t('"+ 날짜 추가" 버튼이 있음', hasAddDayBtn);

{
  const db = openDb();
  const before = db.prepare("SELECT COUNT(*) AS n FROM events WHERE name = 'course_generated'").get().n;
  t('여기까지 course_generated 이벤트 1건만 기록됨(날짜 탭 자체는 아직 안 건드림)', before === 1);
}

// --- "+ 날짜 추가" — 이미 로그인돼 있으니 곧바로 출발지 화면이 뜨고,
// 실제 생성을 시도한 순간 서버가 402를 돌려줘야 이용권 화면으로 이어진다. ---
await p.click('[data-day-new]');
await p.waitForTimeout(200);
const addDayBuildTitle = await p.textContent('#sheetLabel');
t('"+ 날짜 추가"도 로그인된 상태라 곧바로 출발지 화면', addDayBuildTitle === '출발지 정하기');
await p.click('[data-start-pick="c1"]');
await p.waitForTimeout(500);
const afterLoginTitle = await p.textContent('#sheetLabel');
t('두 번째 날짜 생성 시도는 서버가 402를 돌려줘 이용권 화면으로 이어짐', afterLoginTitle === '이용권');
{
  const db = openDb();
  const paywallEvts = db.prepare("SELECT props FROM events WHERE name = 'paywall_viewed'").all().map((r) => JSON.parse(r.props));
  t('이용권 노출 이벤트가 trigger=new_day로 기록됨(추가 코스 생성과 구분됨)', paywallEvts.some((p2) => p2.trigger === 'new_day'));
}

// --- 결제 ---
await p.click('#payBtn');
await p.waitForTimeout(400);
const afterPayTitle = await p.textContent('#sheetLabel');
t('결제 성공 후 출발지 화면으로 돌아옴', afterPayTitle === '출발지 정하기');
const day2Default = await p.inputValue('#courseDate');
t('새 날짜 기본값이 1일차 다음날로 자동 채워짐', day2Default > day1Date);

// --- 2일차 코스 생성 ---
await p.click('[data-start-pick="c1"]');
await p.waitForTimeout(800);
const afterDay2 = await p.evaluate(() => ({ course: foodMap.course, courses: foodMap.courses }));
t('2일차 코스가 실제로 만들어짐', afterDay2.course && afterDay2.course.stops.length === 1);
t('foodMap.courses에 날짜별로 2개 항목이 쌓임(덮어쓰지 않음)', afterDay2.courses.length === 2);
t('2일차 날짜가 1일차와 다름', afterDay2.courses[1].date !== day1Date && afterDay2.courses[1].date === day2Default);

// --- 날짜 탭 전환은 무료(서버에 안 물음) — course_generated 이벤트 수가 안 늘어야 한다 ---
{
  const db = openDb();
  const beforeSwitch = db.prepare("SELECT COUNT(*) AS n FROM events WHERE name = 'course_generated'").get().n;
  const day1TabSel = `[data-day="${day1Date}"]`;
  await p.click(day1TabSel);
  await p.waitForTimeout(150);
  const afterSwitchCourse = await p.evaluate(() => foodMap.course.date);
  t('날짜 탭을 누르면 실제로 그 날짜 코스로 화면이 바뀜', afterSwitchCourse === day1Date);
  const afterSwitch = db.prepare("SELECT COUNT(*) AS n FROM events WHERE name = 'course_generated'").get().n;
  t('날짜 탭 전환은 무료 열람이라 course_generated 이벤트가 새로 안 늘어남', afterSwitch === beforeSwitch);
}

// --- 같은 날짜 "새로 만들기"(재계산)는 새 날짜를 만들지 않고 그 자리를 덮어씀 ---
await p.click('[data-course-new]');
await p.waitForTimeout(300);
const recomputeDateVal = await p.inputValue('#courseDate');
t('"새로 만들기"는 지금 보고 있던 날짜를 그대로 채워 재계산 화면을 연다', recomputeDateVal === day1Date);
await p.click('[data-start-pick="c1"]');
await p.waitForTimeout(800);
const afterRecompute = await p.evaluate(() => foodMap.courses);
t('재계산 후에도 날짜 개수는 그대로 2개(중복 날짜가 안 생김)', afterRecompute.length === 2);

// --- 환불 후에도 이미 만든 날짜들은 계속 열람 가능(만료 후에도 코스 열람 유지) ---
const sessionToken = await p.evaluate(() => foodMap.session && foodMap.session.token);
const refundRes = await fetch(apiBase + '/api/dev/simulate-payment', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` }, body: JSON.stringify({ outcome: 'refund' }),
});
t('환불 시뮬레이션 성공', refundRes.ok);
await p.evaluate(() => document.getElementById('close').click());
await p.evaluate(() => showRoute());
await p.waitForTimeout(150);
const afterRefundView = await p.textContent('#sheetContent');
t('환불 후에도 기존에 만든 코스 화면은 그대로(서버 게이트 없이) 열람됨', afterRefundView.includes('도보 이동'));
await p.click(`[data-day="${day2Default}"]`);
await p.waitForTimeout(150);
const afterRefundTabSwitch = await p.evaluate(() => foodMap.course.date);
t('환불 후에도 다른 날짜 탭 전환이 계속 무료로 동작함', afterRefundTabSwitch === day2Default);

// --- 환불 후 새 날짜 추가는 다시 이용권을 요구함(실제 생성 시도 때
// 서버가 402를 돌려줘야 반응적으로 이용권 화면이 뜬다) ---
await p.click('[data-day-new]');
await p.waitForTimeout(200);
await p.click('[data-start-pick="c1"]');
await p.waitForTimeout(500);
const afterRefundAddDayTitle = await p.textContent('#sheetLabel');
t('환불 후 "+ 날짜 추가"는 다시 이용권 화면을 띄움(권한이 실제로 회수됨)', afterRefundAddDayTitle === '이용권');
await p.evaluate(() => document.getElementById('close').click());

// --- 여러 도시를 오가도 각 도시의 저장된 날짜가 서로 안 섞이는지
// (showRoute가 foodMap.course 하나만 보고 판단하면, 최근에 본 다른
// 도시 코스가 지금 도시 것처럼 새어 들어올 수 있다 — daCoursesForCity로
// 도시별로 직접 찾도록 고친 부분을 실제로 검증한다) ---
const originalCity = await p.evaluate(() => city);
await p.evaluate(() => {
  foodMap.places.push({ id: 'd1', name: '도쿄장소', lat: 35.681, lng: 139.767, cat: '카페·디저트', catConfirmed: true, city: '도쿄', cityConfirmed: true, sourceLists: [] });
  A.saveFoodMap(foodMap);
  refreshFromStorage();
  chooseCity('도쿄');
});
await p.waitForTimeout(150);
await p.evaluate(() => { route.clear(); route.add('d1'); });
await p.evaluate(() => showRoute());
await p.waitForTimeout(150);
const tokyoRouteTitle = await p.textContent('#sheetLabel');
t('다른 도시로 전환하면 그 도시엔 저장된 코스가 없어 동선 선택 화면이 뜸(다른 도시 코스가 안 새어 들어옴)', tokyoRouteTitle.includes('오늘 동선'));
await p.evaluate(() => document.getElementById('close').click());

await p.evaluate((c) => chooseCity(c), originalCity);
await p.waitForTimeout(150);
await p.evaluate(() => showRoute());
await p.waitForTimeout(150);
const backTitle = await p.textContent('#sheetLabel');
const backHtml = await p.textContent('#sheetContent');
t('원래 도시로 돌아오면 그 도시에 저장했던 날짜들이 그대로 다시 보임(다른 도시 방문에 안 지워짐)',
  backTitle === '오늘의 코스' && backHtml.includes(day1Date) && backHtml.includes(day2Default));
await p.evaluate(() => document.getElementById('close').click());

t('최종 콘솔/런타임 오류 0', errs.length === 0);
if (errs.length) console.log('  ', errs.slice(0, 5));

await b.close();
server.close();
console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
