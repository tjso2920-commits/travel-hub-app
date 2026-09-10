/**
 * 짧은 구매 흐름 종단 검증 — 실제 Chromium + 실제 서버(임시 포트).
 *
 * 2026-09-09 코드 검토(로드맵 ⑨⑩): "샘플 체험 → 가져오기 → 필요할 때만
 * 로그인 → 코스 결과 → 이용권 제시 → 결제 → 원래 코스로 복귀"를 실제로
 * 눌러서 끝까지 확인한다. 결제는 서버가 자체 서명한 웹훅을 실제
 * handleWebhook()에 흘려보내는 개발용 시뮬레이션을 쓴다(클라이언트가
 * "결제했다"고 스스로 신고하는 방식이 아니다 — server/routes/dev.mjs).
 * 측정 이벤트가 실제로 서버 DB에 쌓이는지도 함께 확인한다.
 */
import { chromium } from 'playwright';

/* 2026-09-09 코드 검토(2차) 재현된 버그: 정적 import는 호이스팅되어
   이 파일의 다른 코드보다 먼저 실행된다 — 그래서 아래 process.env
   설정을 정적 import보다 "먼저" 적어도 실제로는 config.mjs가 그 값을
   못 보고 먼저 로드돼 버렸다(서버가 :memory: 대신 진짜 server/data/
   app.db 파일을 계속 재사용해, 이전 실행에서 남은 "이미 결제 완료"
   상태가 다음 실행에 새어 들어가는 사고로 실제 재현됐다). 동적
   import(server/test/server.test.mjs와 같은 패턴)로 바꿔 환경변수가
   먼저 적용되게 한다. */
process.env.DB_PATH = ':memory:';
process.env.FORCE_TEST_MODE = 'true';
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

// window.API_BASE는 spots.js가 맨 처음 실행될 때(channel_inflow를
// 그 자리에서 곧바로 보낼 때)부터 이미 설정돼 있어야 한다 — 페이지
// 로드 뒤에 evaluate로 넣으면 이미 늦다. addInitScript로 매 탐색마다
// 문서 스크립트가 실행되기 전에 미리 심어 둔다.
await p.addInitScript((base) => { window.API_BASE = base; }, apiBase);
await p.goto('file://' + process.cwd() + '/src/design/index.html');
await p.waitForTimeout(300);

// --- 유입 채널 측정 — 페이지가 뜨자마자 한 번 기록된다 ---
await p.waitForTimeout(300);
{
  const db = openDb();
  const inflow = db.prepare("SELECT * FROM events WHERE name = 'channel_inflow'").all();
  t('페이지 진입 시 channel_inflow 이벤트가 실제로 서버에 기록됨', inflow.length >= 1);
}

// --- 데이터 준비: 좌표 있는 곳 2곳 담아 첫 코스(무료 체험) 생성 ---
await p.evaluate(() => {
  foodMap.lic = { name: 'q', date: '2026-01-01' };
  foodMap.places = [
    { id: 'c1', name: '출발점', lat: 33.590, lng: 130.400, cat: '카페·디저트', catConfirmed: true, sourceLists: [] },
    { id: 'c2', name: '두번째곳', lat: 33.591, lng: 130.401, cat: '맛집·식당', catConfirmed: true, sourceLists: [] },
  ];
  delete foodMap.course;
  delete foodMap.session;
  A.saveFoodMap(foodMap);
});
await p.reload();
await p.waitForTimeout(300);
await p.evaluate(() => { ['c1', 'c2'].forEach((id) => route.add(id)); });
await p.evaluate(() => showRoute());
await p.waitForTimeout(150);
await p.click('[data-build-course]'); // 첫 코스 — 게이트를 그냥 통과해야 한다(로그인 안 뜸)
await p.waitForTimeout(200);
const firstSheetTitle = await p.textContent('#sheetLabel');
t('첫 코스는 로그인 없이 곧바로 출발지 화면으로 감(무료 체험엔 로그인 요구 안 함)', firstSheetTitle === '출발지 정하기');
await p.click('[data-start-pick="c1"]');
await p.waitForTimeout(800);
const firstCourse = await p.evaluate(() => foodMap.course);
t('첫 코스가 실제로 만들어짐', firstCourse && firstCourse.stops.length === 1);
await p.evaluate(() => document.getElementById('close').click());
await p.waitForTimeout(150);

{
  const db = openDb();
  const gen = db.prepare("SELECT * FROM events WHERE name = 'course_generated'").all();
  t('코스 생성 이벤트가 서버에 기록됨(장소명 없이 개수만)', gen.length >= 1 && JSON.parse(gen[0].props).stop_count === 1);
}

// --- 두 번째 코스 시도 — 이제 로그인을 요구해야 한다 ---
await p.evaluate(() => showRoute());
await p.waitForTimeout(150);
await p.click('[data-course-new]');
await p.waitForTimeout(200);
const secondSheetTitle = await p.textContent('#sheetLabel');
t('두 번째 코스 시도부터는 로그인 화면이 뜸(게이트 작동 확인)', secondSheetTitle === '로그인');

// --- 로그인 진행 ---
const testEmail = 'purchase-flow-tester@example.com';
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
// 로그인 확인 → (신규) 로그인 전 무료체험 소진 반영 → 코스 게이트 재확인
// (/api/trial, /api/entitlement)까지 순차적인 네트워크 왕복이 여러 번
// 걸린다 — 고정 시간 대기 대신 실제로 화면 제목이 바뀔 때까지 기다린다.
await p.waitForFunction(() => document.getElementById('sheetLabel').textContent !== '코드 확인', { timeout: 5000 });

// --- 로그인 직후 원래 하려던 동작(두 번째 코스 만들기)으로 자동 진행 —
// 로그인했지만 아직 무료체험을 이미 썼으므로 이번엔 이용권 화면이 떠야 한다 ---
const afterLoginTitle = await p.textContent('#sheetLabel');
t('로그인 성공 뒤 원래 하려던 동작을 이어감(이용권 화면으로)', afterLoginTitle === '이용권');
const paywallText = await p.textContent('#sheetContent');
t('이용권 화면에 금액이 표시됨', /9,?900원/.test(paywallText));
t('이용권 화면에 기간이 표시됨', /30일/.test(paywallText));
t('이용권 화면에 자동결제 여부가 명시됨', paywallText.includes('자동결제'));

{
  const db = openDb();
  const paywallEvt = db.prepare("SELECT * FROM events WHERE name = 'paywall_viewed'").all();
  t('이용권 화면 노출이 서버에 측정됨', paywallEvt.length >= 1);
}

// --- 결제 실패 시에도 사용자가 갇히지 않고 이용권 화면에 그대로 남아
// 재시도하거나 돌아갈 수 있어야 한다(2026-09-10: "결제 취소·실패
// 후에도 작업 중인 여행 화면으로 복귀"). 서버·네트워크는 살아있는데
// 결제 자체만 실패하는 상황을 흉내 내려고 이 엔드포인트 하나만
// 일부러 500으로 가로챈다. ---
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

// --- 결제 진행(개발용 시뮬레이션 — 서버가 스스로 서명한 웹훅을 실제
// handleWebhook()에 흘려보낸다) ---
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

// --- 환불 — 실제 서비스에서는 PG가 보내는 웹훅으로 이 상태가 바뀐다.
// 클라이언트가 스스로 "환불받았다"고 선언하지 않는다 — 서버 상태가
// 먼저 바뀌고, 클라이언트는 다음 코스 시도에서 그 사실을 그대로
// 확인할 뿐이다(2026-09-10: "결제 승인·취소·환불·이용권 만료에 따른
// 권한 처리"). ---
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
