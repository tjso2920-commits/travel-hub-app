/**
 * 짧은 구매 흐름 종단 검증 — 실제 Chromium + 실제 서버(임시 포트).
 *
 * 2026-09-10 재검토(3차): "샘플은 로그인 없이, 실제 개인화 무료 코스는
 * 간편 로그인 후 제공"으로 흐름이 바뀌었다 — 실제 데이터로는 첫 코스
 * 부터 로그인이 필요하다. 무료체험/이용권 판정도 더 이상 클라이언트가
 * 미리 서버에 물어보고 화면을 고르지 않는다 — 실제 생성 시도
 * (POST /api/course/generate)가 402를 돌려줄 때만 반응적으로 이용권
 * 화면을 띄운다(서버가 유일한 판정 주체). 라우팅 결과는
 * ROUTING_TEST_FORCE=success로 고정해 "실제 경로 성공"만 재현한다
 * (실패 시 미차감 회계는 generation-trial-charging-*.test.mjs에서 따로
 * 검증했으므로 여기서는 짧은 구매 흐름 자체에 집중한다).
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

// --- 유입 채널 측정 — 페이지가 뜨자마자 한 번 기록된다 ---
{
  const db = openDb();
  const inflow = db.prepare("SELECT * FROM events WHERE name = 'channel_inflow'").all();
  t('페이지 진입 시 channel_inflow 이벤트가 실제로 서버에 기록됨', inflow.length >= 1);
}

// --- 데이터 준비: 좌표 있는 곳 2곳 담기 ---
await p.evaluate(() => {
  foodMap.places = [
    { id: 'c1', name: '출발점', lat: 33.590, lng: 130.400, cat: '카페·디저트', catConfirmed: true, sourceLists: [] },
    { id: 'c2', name: '두번째곳', lat: 33.591, lng: 130.401, cat: '맛집·식당', catConfirmed: true, sourceLists: [] },
  ];
  delete foodMap.course; delete foodMap.courses; delete foodMap.session;
  A.saveFoodMap(foodMap);
});
await p.reload();
await p.waitForTimeout(300);
await p.evaluate(() => { ['c1', 'c2'].forEach((id) => route.add(id)); });
await p.evaluate(() => showRoute());
await p.waitForTimeout(150);
await p.click('[data-build-course]');
await p.waitForTimeout(200);
const firstSheetTitle = await p.textContent('#sheetLabel');
t('실제 데이터는 첫 코스부터 로그인부터 요구함(샘플만 예외)', firstSheetTitle === '로그인');

// --- 로그인 진행 ---
const testEmail = 'purchase-flow-tester@example.com';
const placesBeforeLogin = await p.evaluate(() => JSON.stringify(foodMap.places));
await p.fill('#loginEmail', testEmail);
await p.click('#loginSendBtn');
await p.waitForTimeout(200);
const codeTitle = await p.textContent('#sheetLabel');
t('코드 요청 후 코드 입력 화면으로 넘어감', codeTitle === '코드 확인');
const emailSent = sentEmailsForTest.filter((e) => e.to === testEmail).pop();
t('실제로 로그인 코드가 이메일 어댑터에 기록됨(테스트 모드 — 실발송 없이 검증)', !!emailSent);
const code = emailSent.body.match(/(\d{6})/)[1];
await p.fill('#loginCode', code);
await p.click('#loginVerifyBtn');
await p.waitForFunction(() => document.getElementById('sheetLabel').textContent !== '코드 확인', { timeout: 5000 });
const afterLoginTitle = await p.textContent('#sheetLabel');
t('로그인 성공 뒤 원래 하려던 동작(출발지 정하기)을 곧바로 이어감', afterLoginTitle === '출발지 정하기');
t('로그인 후에도 이미 가져온 장소가 그대로 남아 있음(로그인이 로컬 데이터를 안 지움)',
  (await p.evaluate(() => JSON.stringify(foodMap.places))) === placesBeforeLogin);

// --- 첫(무료) 코스 생성 ---
await p.click('[data-start-pick="c1"]');
await p.waitForTimeout(800);
const firstCourse = await p.evaluate(() => foodMap.course);
t('첫 코스가 실제로 만들어짐', firstCourse && firstCourse.stops.length === 1);
t('실제 경로 성공으로 만들어짐(routedReal=true)', firstCourse.routedReal === true);
await p.evaluate(() => document.getElementById('close').click());
await p.waitForTimeout(150);
{
  const db = openDb();
  const gen = db.prepare("SELECT * FROM events WHERE name = 'course_generated'").all();
  t('코스 생성 이벤트가 서버에 기록됨(장소명 없이 개수만)', gen.length >= 1 && JSON.parse(gen[0].props).stop_count === 1);
}

// --- 두 번째 코스 시도 — 이미 로그인돼 있으니 곧바로 출발지 화면이
// 뜨고(로그인 확인은 이제 클라이언트 몫), 실제 생성을 시도한 순간
// 서버가 402(결제 필요)를 돌려줘야 그때 이용권 화면으로 이어진다. ---
await p.evaluate(() => showRoute());
await p.waitForTimeout(150);
await p.click('[data-course-new]');
await p.waitForTimeout(200);
const secondSheetTitle = await p.textContent('#sheetLabel');
t('이미 로그인된 상태라 "새로 만들기"는 곧바로 출발지 화면', secondSheetTitle === '출발지 정하기');
const courseBeforeSecondAttempt = await p.evaluate(() => foodMap.course);
await p.click('[data-start-pick="c1"]');
await p.waitForTimeout(500);
const afterAttemptTitle = await p.textContent('#sheetLabel');
t('무료체험을 이미 쓴 뒤 생성 시도는 서버가 402를 돌려줘 이용권 화면으로 이어짐', afterAttemptTitle === '이용권');
t('이용권 화면이 뜨는 동안 기존 코스는 안 바뀜', JSON.stringify(await p.evaluate(() => foodMap.course)) === JSON.stringify(courseBeforeSecondAttempt));
const paywallText = await p.textContent('#sheetContent');
t('이용권 화면에 금액이 표시됨', /9,?900원/.test(paywallText));
t('이용권 화면에 기간이 표시됨', /30일/.test(paywallText));
t('이용권 화면에 자동결제 여부가 명시됨', paywallText.includes('자동결제'));
// 2026-09-10 재검토(6차) 2절 — "구매 화면에 포함 사용량을 표시하라".
// 서버 설정값(config.entitlementUsage)을 하드코딩하지 않고 그대로
// 반영하는지 확인 — 실제 서버 응답(/api/entitlement)에서 읽어 비교한다.
{
  const entRes = await fetch(apiBase + '/api/entitlement', { headers: { Authorization: `Bearer ${await p.evaluate(() => foodMap.session && foodMap.session.token)}` } });
  const entJson = await entRes.json();
  const { includedPlaceLookups, includedCourseGenerations } = entJson.price;
  t('이용권 화면에 포함된 위치 확인 횟수가 서버 설정값 그대로 표시됨',
    paywallText.includes(`새로운 장소 위치 확인 최대 ${includedPlaceLookups}곳`));
  t('이용권 화면에 포함된 코스 생성 횟수가 서버 설정값 그대로 표시됨',
    paywallText.includes(`코스 생성·재계산 최대 ${includedCourseGenerations}회`));
}
{
  const db = openDb();
  const paywallEvt = db.prepare("SELECT * FROM events WHERE name = 'paywall_viewed'").all();
  t('이용권 화면 노출이 서버에 측정됨', paywallEvt.length >= 1);
}

// --- 결제 실패 시에도 사용자가 갇히지 않고 이용권 화면에 그대로 남아
// 재시도하거나 돌아갈 수 있어야 한다. 이 샌드박스에는 실제 토스 키가
// 없어 /api/payment/config가 unavailable을 돌려주므로, 화면은 자동으로
// 개발용 시뮬레이션 경로로 대체된다(daRunDevSimulatedPayment) — 그
// 엔드포인트 하나만 일부러 500으로 가로챈다. ---
const courseBeforePayFail = await p.evaluate(() => foodMap.course);
await p.route('**/api/dev/simulate-payment', (route) => route.fulfill({ status: 500, body: '{}' }), { times: 1 });
await p.click('#payBtn');
await p.waitForTimeout(300);
const afterPayFailTitle = await p.textContent('#sheetLabel');
t('결제 실패 후에도 이용권 화면에 그대로 남아 있음(갇히지 않고 바로 재시도 가능)', afterPayFailTitle === '이용권');
t('결제 실패는 기존 코스·진행 상태를 전혀 건드리지 않음', JSON.stringify(await p.evaluate(() => foodMap.course)) === JSON.stringify(courseBeforePayFail));
{
  const db = openDb();
  const failEvt = db.prepare("SELECT * FROM events WHERE name = 'payment_result'").all().filter((e) => JSON.parse(e.props).result === 'failure');
  t('결제 실패 이벤트도 서버에 기록됨', failEvt.length >= 1);
}
await p.unroute('**/api/dev/simulate-payment');

// --- 결제 진행(개발용 시뮬레이션) ---
await p.click('#payBtn');
await p.waitForTimeout(400);
const afterPayTitle = await p.textContent('#sheetLabel');
t('결제 성공 후 원래 코스 만들기 흐름(출발지 정하기)으로 복귀함', afterPayTitle === '출발지 정하기');
{
  const db = openDb();
  const payEvents = db.prepare("SELECT * FROM events WHERE name IN ('payment_started','payment_result')").all();
  t('결제 시작·결과 이벤트가 서버에 기록됨', payEvents.some((e) => e.name === 'payment_started') && payEvents.some((e) => e.name === 'payment_result'));
  const account = db.prepare('SELECT plan FROM accounts WHERE email = ?').get(testEmail);
  t('실제로 계정이 paid로 바뀜(서버 DB 기준)', account && account.plan === 'paid');
}

// --- 결제 완료 뒤 실제로 두 번째 코스를 끝까지 만들 수 있음(유료 이용권으로 통과) ---
await p.click('[data-start-pick="c1"]');
await p.waitForTimeout(800);
const secondCourse = await p.evaluate(() => foodMap.course);
t('결제 후 실제로 두 번째 코스가 만들어짐', secondCourse && secondCourse.stops.length === 1);
await p.evaluate(() => document.getElementById('close').click());

// --- 2026-09-10 재검토(6차) 2절 — "계정 화면에서 잔여 횟수를 확인할 수
// 있게 하라". 실제로 유료 이용권으로 전환된 뒤 프로필 화면을 열어
// 남은 위치 확인·코스 생성 횟수가 실제 서버 사용량 기준으로 표시되는지
// 확인한다(개발자 용어인 API/SKU는 화면에 없어야 한다). ---
{
  await p.click('[data-profile]');
  await p.waitForTimeout(200);
  const profileTitle = await p.textContent('#sheetLabel');
  t('프로필 버튼으로 실제 프로필 화면이 열림', profileTitle === '내 프로필');
  const profileText = await p.textContent('#sheetContent');
  t('프로필 화면에 유료 이용권으로 표시됨', profileText.includes('유료 이용권'));
  t('프로필 화면에 남은 위치 확인 횟수가 표시됨(개발자 용어 없이)', /남은 위치 확인: \d+곳\(전체 \d+곳 중\)/.test(profileText));
  t('프로필 화면에 남은 코스 생성 횟수가 표시됨', /남은 코스 생성: \d+회\(전체 \d+회 중\)/.test(profileText));
  t('프로필 화면에 API·SKU 같은 개발 용어가 노출되지 않음', !/\bAPI\b|\bSKU\b/i.test(profileText));
  const usageAfterOneCourse = await fetch(apiBase + '/api/account/usage', { headers: { Authorization: `Bearer ${await p.evaluate(() => foodMap.session && foodMap.session.token)}` } }).then((r) => r.json());
  t('프로필 화면의 잔여 코스 생성 횟수가 실제 서버 사용량과 일치함(코스 1회 사용 후)',
    profileText.includes(`남은 코스 생성: ${usageAfterOneCourse.courseGenerations.remaining}회(전체 ${usageAfterOneCourse.courseGenerations.limit}회 중)`));
  await p.evaluate(() => document.getElementById('close').click());
  await p.waitForTimeout(150);
}

// --- 환불 — 실제 서비스에서는 PG가 보내는 웹훅으로 이 상태가 바뀐다.
// 클라이언트가 스스로 "환불받았다"고 선언하지 않는다. ---
const sessionToken = await p.evaluate(() => foodMap.session && foodMap.session.token);
const refundRes = await fetch(apiBase + '/api/dev/simulate-payment', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
  body: JSON.stringify({ outcome: 'refund' }),
});
const refundJson = await refundRes.json();
t('환불 시뮬레이션 API 호출 성공(취소와 구분된 별개 타입)', refundRes.ok && refundJson.type === 'refund');
const entAfterRefundRes = await fetch(apiBase + '/api/entitlement', { headers: { Authorization: `Bearer ${sessionToken}` } });
const entAfterRefund = await entAfterRefundRes.json();
t('환불 후 서버 이용권 상태가 즉시 free로 바뀜', entAfterRefund.plan === 'free');

await p.evaluate(() => showRoute());
await p.waitForTimeout(150);
await p.click('[data-course-new]');
await p.waitForTimeout(200);
await p.click('[data-start-pick="c1"]');
await p.waitForTimeout(500);
const afterRefundAttemptTitle = await p.textContent('#sheetLabel');
t('환불 후 다음 코스 시도에서 다시 이용권 화면이 뜸(권한이 실제로 즉시 회수됨 — 캐시된 이전 상태로 통과되지 않음)', afterRefundAttemptTitle === '이용권');
await p.evaluate(() => document.getElementById('close').click());

t('최종 콘솔/런타임 오류 0', errs.length === 0);
if (errs.length) console.log('  ', errs.slice(0, 5));

await b.close();
server.close();
console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
