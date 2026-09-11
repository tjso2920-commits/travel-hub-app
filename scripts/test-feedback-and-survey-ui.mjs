/**
 * 소규모 베타·피드백 체계(2026-09-11 재검토 9차 6-4절) 클라이언트 UI
 * 검증 — 실제 Chromium + 실제 서버. "불편함 보내기" 시트, 코스 생성
 * 직후 짧은 설문, 로그인 화면의 초대 코드 입력칸(기본은 그냥 무시됨)을
 * 실제로 확인한다.
 *
 * 실행: node scripts/test-feedback-and-survey-ui.mjs
 */
import { chromium } from 'playwright';

process.env.DB_PATH = ':memory:';
process.env.FORCE_TEST_MODE = 'true';
const { createServer } = await import('../server/index.mjs');
const { openDb } = await import('../server/db.mjs');

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
await p.waitForTimeout(200);

// =====================================================================
// 1. 로그인 화면에 초대 코드 입력칸이 있고(선택), 기본(게이트 꺼짐)
//    상태에서는 코드 없이도 실제로 로그인이 완료된다 — 기존 열린 가입
//    흐름이 그대로 보존됨을 화면으로도 확인.
// =====================================================================
await p.evaluate(() => { showLoginSheet(() => {}); });
await p.waitForTimeout(100);
await p.fill('#loginEmail', 'ui-test-1@example.com');
await p.click('#loginSendBtn');
await p.waitForTimeout(150);
const hasInviteField = await p.locator('#loginInviteCode').count();
t('1) 코드 확인 화면에 초대 코드 입력칸이 있음(선택 입력)', hasInviteField === 1);
// 실제 발급된 코드를 DB에서 직접 읽어(테스트 전용 접근) 입력한다.
const issuedCode = openDb().prepare("SELECT code FROM login_codes WHERE email = ? ORDER BY rowid DESC LIMIT 1").get('ui-test-1@example.com').code;
await p.fill('#loginCode', issuedCode);
await p.click('#loginVerifyBtn');
await p.waitForTimeout(300);
const loggedInEmail = await p.evaluate(() => foodMap.session && foodMap.session.email);
t('1) 초대 코드를 안 넣어도(기본 꺼짐 상태) 실제로 로그인이 완료됨', loggedInEmail === 'ui-test-1@example.com');

// =====================================================================
// 2. "불편함 보내기" — 프로필 화면에서 열어 실제로 서버에 접수된다.
// =====================================================================
await p.evaluate(() => { profile(); });
await p.waitForTimeout(200);
const hasFeedbackBtn = await p.locator('[data-feedback-open]').count();
t('2) 프로필 화면에 "불편함 보내기" 버튼이 있음', hasFeedbackBtn === 1);
await p.click('[data-feedback-open]');
await p.waitForTimeout(100);
const hasScreenshotNote = (await p.locator('#sheetContent').innerText()).includes('스크린샷 첨부는 아직 지원하지 않아요');
t('2) 스크린샷 미지원 사실을 화면에서 정직하게 밝힘', hasScreenshotNote);
await p.selectOption('#fbType', 'import');
await p.fill('#fbDesc', 'ZIP 가져오기가 중간에 멈춰요(UI 테스트)');
await p.click('#fbSendBtn');
await p.waitForTimeout(200);
const thankYouShown = (await p.locator('#sheetContent').innerText()).includes('보내주셔서 감사해요');
t('2) 제출 후 감사 안내가 실제로 뜸', thankYouShown);
const savedFeedback = openDb().prepare("SELECT type, description, diagnostic FROM feedback WHERE type = 'import' ORDER BY rowid DESC LIMIT 1").get();
t('2) 서버에 실제로 접수됨(유형/설명 그대로)', savedFeedback && savedFeedback.type === 'import' && savedFeedback.description.includes('UI 테스트'));
const diag = JSON.parse(savedFeedback.diagnostic);
t('2) 최소 진단정보(appBuild/screen/deviceType)가 실제로 같이 실림', !!diag.appBuild && !!diag.screen && !!diag.deviceType);
t('2) 진단정보에 저장 목록·정밀 위치 등 허용 안 된 값은 전혀 없음', Object.keys(diag).every((k) => ['appBuild', 'screen', 'errorCode', 'deviceType'].includes(k)));

// =====================================================================
// 3. 코스 생성 직후 짧은 설문 — 코스 사용을 막지 않고(카드일 뿐), 실제
//    응답이 서버에 기록되며, 같은 코스에는 다시 안 뜬다.
// =====================================================================
await p.evaluate(() => { sheet.close(); });
await p.evaluate(async () => {
  const cityName = '후쿠오카';
  foodMap.places = [{ id: 'w1', name: '가상 장소', lat: 33.5902, lng: 130.4017, cat: '기타', catConfirmed: true, city: cityName, cityKnown: true, cityConfirmed: true, sourceLists: [] }];
  const tripId = 'trip-ui-test-1';
  foodMap.trips = [{ tripId, city: cityName, name: '테스트 여행' }];
  foodMap.currentTripByCity = { [cityName]: tripId };
  foodMap.course = {
    city: cityName, date: '2026-09-11', stops: [{ id: 'w1', at: 600, walk: 0, dwell: 60 }],
    excludedIds: [], excludedReasons: {}, totalMeters: 0, walkTotal: 0, endAt: 660, routedReal: false,
  };
  foodMap.courses = [foodMap.course];
  A.saveFoodMap(foodMap);
});
await p.reload();
await p.waitForTimeout(200);
await p.evaluate(() => { city = '후쿠오카'; showSavedCourse(); });
await p.waitForTimeout(200);
const surveyCardVisible = await p.locator('#courseSurveyCard').isVisible();
t('3) 코스 생성 직후 화면에 짧은 설문 카드가 뜸', surveyCardVisible);
const primaryStillClickable = await p.locator('[data-dismiss]').first().isVisible();
t('3) 설문 카드가 있어도 코스 화면의 다른 버튼(확인)은 그대로 눌림', primaryStillClickable);
await p.fill('#courseSurveyBlocker', '이동 시간이 길었어요(UI 테스트)');
await p.click('[data-survey-answer="yes"]');
await p.waitForTimeout(200);
const surveyCardGoneAfterAnswer = await p.locator('#courseSurveyCard').count();
t('3) 응답 후 설문 카드가 화면에서 사라짐', surveyCardGoneAfterAnswer === 0);
const savedSurvey = openDb().prepare("SELECT type, description FROM feedback WHERE type = 'survey_usage' ORDER BY rowid DESC LIMIT 1").get();
t('3) 서버에 survey_usage로 실제 기록됨', savedSurvey && savedSurvey.description.includes('UI 테스트'));
// 같은 코스를 다시 열어도 이미 응답했으니 카드가 또 안 뜬다.
await p.evaluate(() => { sheet.close(); showSavedCourse(); });
await p.waitForTimeout(150);
const surveyCardOnSecondView = await p.locator('#courseSurveyCard').count();
t('3) 같은 여행 코스를 다시 봐도 설문 카드가 또 안 뜸(중복 방지)', surveyCardOnSecondView === 0);

// =====================================================================
// 4. 퍼널 측정 이벤트(signup_completed/feedback_submitted/survey_submitted)
//    가 화이트리스트 위반 없이 실제로 서버 events 표에 쌓인다.
// =====================================================================
await p.waitForTimeout(200); // daTrackSafe는 비동기라 마지막 이벤트가 도착할 시간을 준다.
const eventNames = openDb().prepare('SELECT name FROM events').all().map((r) => r.name);
t('4) signup_completed 이벤트가 실제로 기록됨', eventNames.includes('signup_completed'));
t('4) feedback_submitted 이벤트가 실제로 기록됨', eventNames.includes('feedback_submitted'));
t('4) survey_submitted 이벤트가 실제로 기록됨', eventNames.includes('survey_submitted'));

t('최종 콘솔/런타임 오류 0', errs.length === 0);
if (errs.length) console.log(errs);

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
await b.close();
server.close();
process.exit(fail ? 1 : 0);
