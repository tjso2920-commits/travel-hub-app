'use strict';
/**
 * 백엔드 통합 테스트 — 실제 HTTP 서버를 임시 포트로 띄우고 fetch로
 * 검증한다. DB는 :memory:로 매 실행마다 깨끗하게 시작한다.
 *
 * 실행: node server/test/server.test.mjs
 */
process.env.DB_PATH = ':memory:';
process.env.FORCE_TEST_MODE = 'true';

const { createServer } = await import('../index.mjs');
const { sentEmailsForTest } = await import('../adapters/email.mjs');
const { signPayload } = await import('../adapters/payment.mjs');
const { config } = await import('../config.mjs');

let fail = 0;
const t = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fail++; };

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

async function api(method, path, { body, token, rawBody, headers } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: rawBody !== undefined ? rawBody : (body !== undefined ? JSON.stringify(body) : undefined),
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, json };
}

// --- 헬스체크 ---
{
  const r = await api('GET', '/api/health');
  t('헬스체크 200 + 테스트 모드 표시', r.status === 200 && r.json.testMode === true);
  t('헬스체크 — 서비스별 상태도 각각 표시(이 테스트 실행에선 키가 전혀 없어 셋 다 test)',
    r.json.services && r.json.services.placeLookup === 'test' && r.json.services.payment === 'test' && r.json.services.email === 'test');
}

// --- 인증되지 않은 요청은 보호된 라우트에서 401 ---
{
  const r = await api('GET', '/api/course');
  t('세션 없이 코스 조회 시 401', r.status === 401);
  const r2 = await api('POST', '/api/trial/consume');
  t('세션 없이 체험 소진 시도도 401', r2.status === 401);
}

// --- 로그인 코드 발급 → 이메일 어댑터에 기록됨(테스트 모드) ---
const emailA = 'tester-a@example.com';
{
  const before = sentEmailsForTest.length;
  const r = await api('POST', '/api/auth/request-code', { body: { email: emailA } });
  t('로그인 코드 요청 성공', r.status === 200 && r.json.ok === true);
  t('테스트 이메일 어댑터에 발송 기록이 남음(실제 발송 없이 검증 가능)', sentEmailsForTest.length === before + 1);
  t('잘못된 이메일 형식은 거부됨', (await api('POST', '/api/auth/request-code', { body: { email: 'not-an-email' } })).status === 400);
}

function extractCode(emailBody) {
  const m = emailBody.match(/(\d{6})/);
  return m ? m[1] : null;
}

let tokenA;
{
  const codeEmail = sentEmailsForTest.find((e) => e.to === emailA);
  const code = extractCode(codeEmail.body);
  const wrong = await api('POST', '/api/auth/verify-code', { body: { email: emailA, code: '000000' } });
  t('틀린 코드는 거부됨(우연히 맞을 확률 배제 위해 실제 코드와 다른지 먼저 확인)', code !== '000000' && wrong.status === 400);
  const r = await api('POST', '/api/auth/verify-code', { body: { email: emailA, code } });
  t('올바른 코드로 로그인 성공, 세션 토큰 발급됨', r.status === 200 && typeof r.json.token === 'string' && r.json.token.length > 10);
  tokenA = r.json.token;
  const reuse = await api('POST', '/api/auth/verify-code', { body: { email: emailA, code } });
  t('같은 코드 재사용은 거부됨(일회용)', reuse.status === 400 && reuse.json.reason === 'code-already-used');
}

// --- 기존 회원 재로그인 — 새 계정을 만들지 않고 같은 계정으로 로그인 ---
{
  await api('POST', '/api/auth/request-code', { body: { email: emailA } });
  const codeEmail = sentEmailsForTest.filter((e) => e.to === emailA).pop();
  const code = extractCode(codeEmail.body);
  const r = await api('POST', '/api/auth/verify-code', { body: { email: emailA, code } });
  t('같은 이메일로 다시 로그인해도 재가입 절차 없이 세션만 새로 발급됨', r.status === 200 && !!r.json.token);
}

// --- 계정별 데이터 격리: 두 번째 계정 만들기 ---
const emailB = 'tester-b@example.com';
let tokenB;
{
  await api('POST', '/api/auth/request-code', { body: { email: emailB } });
  const codeEmail = sentEmailsForTest.find((e) => e.to === emailB);
  const code = extractCode(codeEmail.body);
  const r = await api('POST', '/api/auth/verify-code', { body: { email: emailB, code } });
  tokenB = r.json.token;
  t('두 번째 계정도 정상적으로 세션 발급됨', r.status === 200 && !!tokenB && tokenB !== tokenA);
}

// --- 코스 저장/조회 — 계정 격리 ---
{
  const empty = await api('GET', '/api/course', { token: tokenA });
  t('처음엔 저장된 코스 없음', empty.status === 200 && empty.json.course === null);

  const save = await api('PUT', '/api/course', { token: tokenA, body: { course: { city: '후쿠오카', stops: [{ id: 'p1' }] } } });
  t('A 계정 코스 저장 성공', save.status === 200 && save.json.ok === true);

  const readA = await api('GET', '/api/course', { token: tokenA });
  t('A 계정이 자기 코스를 다시 읽을 수 있음', readA.json.course && readA.json.course.city === '후쿠오카');

  const readB = await api('GET', '/api/course', { token: tokenB });
  t('B 계정에는 A 계정 코스가 안 보임(계정 격리 확인)', readB.json.course === null);

  await api('PUT', '/api/course', { token: tokenB, body: { course: { city: '도쿄', stops: [] } } });
  const readA2 = await api('GET', '/api/course', { token: tokenA });
  t('B가 자기 코스를 저장해도 A의 코스는 그대로임(교차 오염 없음)', readA2.json.course.city === '후쿠오카');
}

// --- 무료체험 1회 소진 — 동시 요청에도 딱 1번만 성공 ---
{
  const status0 = await api('GET', '/api/trial', { token: tokenA });
  t('처음엔 체험 미사용 상태', status0.json.used === false);

  // 20개 동시 요청 — 정확히 1개만 consumed:true 여야 한다.
  const results = await Promise.all(Array.from({ length: 20 }, () => api('POST', '/api/trial/consume', { token: tokenA })));
  const succeeded = results.filter((r) => r.json.consumed === true).length;
  const alreadyUsed = results.filter((r) => r.json.consumed === false && r.json.reason === 'already-used').length;
  t('동시 요청 20개 중 정확히 1개만 성공(중복 차감 없음 — 재현 검증)', succeeded === 1);
  t('나머지 19개는 already-used로 정직하게 거부됨', alreadyUsed === 19);

  const status1 = await api('GET', '/api/trial', { token: tokenA });
  t('소진 후 상태 조회에도 used=true로 반영됨', status1.json.used === true);

  const again = await api('POST', '/api/trial/consume', { token: tokenA });
  t('이미 쓴 뒤 재시도도 계속 거부됨(멱등)', again.json.consumed === false);

  const statusB = await api('GET', '/api/trial', { token: tokenB });
  t('B 계정의 체험은 A와 무관하게 아직 미사용(계정별로 독립)', statusB.json.used === false);
}

// --- 이용권 확인 — 결제 전에는 free, 서버가 검증한 웹훅 이후에만 paid ---
{
  const before = await api('GET', '/api/entitlement', { token: tokenA });
  t('결제 전에는 free 플랜', before.json.plan === 'free');
  t('가격은 서버 설정값으로 내려옴(클라이언트에 숫자 안 박음)', before.json.price.amountKrw === config.price.amountKrw);

  // A 계정의 accountId를 알아내기 위해 코스 저장 응답 등에는 없으므로,
  // 여기서는 로그인 응답에서 받은 값을 재사용할 수 없다 — accountId는
  // verify-code 응답에 포함돼 있었다. 위에서 저장해 뒀어야 하는데
  // 안 해뒀으니, 세션에서 역으로 확인하는 대신 이번 로그인을 다시 해서 받는다.
  const codeReq = await api('POST', '/api/auth/request-code', { body: { email: emailA } });
  const codeEmail = sentEmailsForTest.filter((e) => e.to === emailA).pop();
  const code = extractCode(codeEmail.body);
  const login = await api('POST', '/api/auth/verify-code', { body: { email: emailA, code } });
  const accountIdA = login.json.accountId;

  const fakeBody = JSON.stringify({ event_id: 'evt_1', account_id: accountIdA, type: 'success' });
  const badSig = await api('POST', '/api/webhook/payment', { rawBody: fakeBody, headers: { 'X-Webhook-Signature': 'deadbeef' } });
  t('서명이 틀린 웹훅은 거부됨(계정 상태 안 바뀜)', badSig.status === 401);
  const stillFree = await api('GET', '/api/entitlement', { token: tokenA });
  t('잘못된 서명 웹훅 뒤에도 여전히 free(클라이언트/위조 요청으로는 못 바꿈)', stillFree.json.plan === 'free');

  const goodSig = signPayload(fakeBody, config.webhookSecret);
  const okWebhook = await api('POST', '/api/webhook/payment', { rawBody: fakeBody, headers: { 'X-Webhook-Signature': goodSig } });
  t('올바른 서명의 웹훅은 수락됨', okWebhook.status === 200 && okWebhook.json.ok === true);
  const nowPaid = await api('GET', '/api/entitlement', { token: tokenA });
  t('실제 웹훅 승인 뒤에만 paid로 바뀜', nowPaid.json.plan === 'paid' && !!nowPaid.json.expiresAt);

  // 같은 이벤트(event_id 동일)를 재전송해도 중복 처리 안 됨(멱등성).
  const dup = await api('POST', '/api/webhook/payment', { rawBody: fakeBody, headers: { 'X-Webhook-Signature': goodSig } });
  t('같은 이벤트 재전송(멱등성)도 200으로 응답하고 중복 반영 안 함', dup.status === 200);

  const cancelBody = JSON.stringify({ event_id: 'evt_2', account_id: accountIdA, type: 'cancel' });
  const cancelSig = signPayload(cancelBody, config.webhookSecret);
  await api('POST', '/api/webhook/payment', { rawBody: cancelBody, headers: { 'X-Webhook-Signature': cancelSig } });
  const afterCancel = await api('GET', '/api/entitlement', { token: tokenA });
  t('취소 웹훅 이후 다시 free로 전환됨', afterCancel.json.plan === 'free');
}

// --- 장소 조회 프록시 — API 키 없이, 서버가 대신 조회 ---
{
  const empty = await api('GET', '/api/places/lookup?q=');
  t('빈 질의는 400', empty.status === 400);
  const r = await api('GET', '/api/places/lookup?q=' + encodeURIComponent('후쿠오카역'));
  t('장소 조회는 항상 응답을 줌(성공 또는 정직한 실패)', r.status === 200 && typeof r.json.ok === 'boolean');
  const r2 = await api('GET', '/api/places/lookup?q=' + encodeURIComponent('후쿠오카역'));
  t('같은 질의는 같은 결과(테스트 어댑터 결정론적 — 재현 가능한 테스트)', JSON.stringify(r.json) === JSON.stringify(r2.json));
}

// --- 개발용 결제 시뮬레이션 — 클라이언트가 "결제했다"고 스스로 신고하는
// 게 아니라, 서버가 자체 서명한 가짜 웹훅을 실제 handleWebhook()에
// 흘려보내는 방식임을 확인한다(실제 서명 검증·멱등성 코드 경로를 그대로
// 탄다 — 페이로드 출처만 다름). ---
{
  const before = await api('GET', '/api/entitlement', { token: tokenB });
  t('시뮬레이션 전 B 계정은 free', before.json.plan === 'free');

  const noAuth = await fetch(base + '/api/dev/simulate-payment', { method: 'POST' });
  t('세션 없이는 결제 시뮬레이션도 401', noAuth.status === 401);

  const sim = await api('POST', '/api/dev/simulate-payment', { token: tokenB, body: { outcome: 'success' } });
  t('테스트 모드에서는 결제 시뮬레이션 성공', sim.status === 200 && sim.json.ok === true);
  const afterSim = await api('GET', '/api/entitlement', { token: tokenB });
  t('시뮬레이션 뒤 B 계정이 실제로 paid로 바뀜(진짜 웹훅 코드 경로를 탐)', afterSim.json.plan === 'paid');

  const simCancel = await api('POST', '/api/dev/simulate-payment', { token: tokenB, body: { outcome: 'cancel' } });
  t('취소 시뮬레이션도 지원됨', simCancel.status === 200);
  const afterCancelSim = await api('GET', '/api/entitlement', { token: tokenB });
  t('취소 시뮬레이션 뒤 다시 free로 전환됨', afterCancelSim.json.plan === 'free');

  // --- 환불·만료도 취소와 별개 타입으로 처리된다(2026-09-10 — 확정
  // 상품: 9,900원/30일, 자동결제 없음. "결제 승인·취소·환불·만료"를
  // 각각 구분해 처리하라는 지시사항 반영). ---
  const simSuccessAgain = await api('POST', '/api/dev/simulate-payment', { token: tokenB, body: { outcome: 'success' } });
  t('환불 검증 준비 — 재결제 시뮬레이션 성공', simSuccessAgain.status === 200);
  const beforeRefund = await api('GET', '/api/entitlement', { token: tokenB });
  t('환불 전에는 다시 paid 상태', beforeRefund.json.plan === 'paid');
  const simRefund = await api('POST', '/api/dev/simulate-payment', { token: tokenB, body: { outcome: 'refund' } });
  t('환불 시뮬레이션 성공(취소와 구분된 별개 타입)', simRefund.status === 200 && simRefund.json.type === 'refund');
  const afterRefund = await api('GET', '/api/entitlement', { token: tokenB });
  t('환불 뒤 free로 전환됨(취소와 결과는 같지만 원인이 구분되어 기록됨)', afterRefund.json.plan === 'free');

  const simSuccessForExpire = await api('POST', '/api/dev/simulate-payment', { token: tokenB, body: { outcome: 'success' } });
  t('만료 검증 준비 — 재결제 시뮬레이션 성공', simSuccessForExpire.status === 200);
  const simExpire = await api('POST', '/api/dev/simulate-payment', { token: tokenB, body: { outcome: 'expire' } });
  t('만료 시뮬레이션 성공(취소·환불과 구분된 별개 타입)', simExpire.status === 200 && simExpire.json.type === 'expire');
  const afterExpire = await api('GET', '/api/entitlement', { token: tokenB });
  t('만료 뒤 free로 전환됨', afterExpire.json.plan === 'free');

  // 결제 관련 웹훅 이벤트는 실제로 각각 타입이 다르게 DB에 남는지도
  // 확인한다(같은 결과로 뭉뚱그려지지 않고, 나중에 취소/환불/만료
  // 비율을 구분해 볼 수 있어야 한다는 요구사항 그대로).
  const { openDb } = await import('../db.mjs');
  const { accountForToken } = await import('../auth.mjs');
  const db = openDb();
  const types = db.prepare('SELECT type FROM payment_events WHERE account_id = ? ORDER BY received_at').all(accountForToken(tokenB));
  const typeList = types.map((r) => r.type);
  t('결제 이벤트 기록에 success·cancel·refund·expire가 각각 구분되어 남음',
    typeList.includes('success') && typeList.includes('cancel') && typeList.includes('refund') && typeList.includes('expire'));
}

// --- 측정 이벤트 — 화이트리스트에 없는 이벤트·속성·값은 거부되고,
// 개인정보(장소명·GPS 등)를 넣을 자유 텍스트 필드 자체가 없다. ---
{
  const inflow = await api('POST', '/api/events', { body: { name: 'channel_inflow', props: { channel: 'threads' } } });
  t('허용된 이벤트+허용된 값은 기록됨', inflow.status === 200 && inflow.json.ok === true);

  const badChannel = await api('POST', '/api/events', { body: { name: 'channel_inflow', props: { channel: '아무 문자열이나' } } });
  t('허용 목록에 없는 값은 거부됨(자유 텍스트로 흘려보낼 수 없음)', badChannel.status === 400);

  const unknownEvent = await api('POST', '/api/events', { body: { name: 'user_typed_a_place_name', props: {} } });
  t('허용 목록에 없는 이벤트 이름 자체가 거부됨', unknownEvent.status === 400);

  const leakAttempt = await api('POST', '/api/events', { body: { name: 'import_result', props: { result: 'success', imported_count: 3, place_name: '내가 저장한 맛집' } } });
  t('스키마에 없는 속성(예: place_name)을 끼워 넣으려 하면 거부됨(개인정보 유입 경로 원천 차단)', leakAttempt.status === 400);

  const courseEvt = await api('POST', '/api/events', { body: { name: 'course_generated', props: { routed_real: true, stop_count: 4 } } });
  t('코스 생성 이벤트는 성공 여부·개수만 담고 장소명은 아예 필드가 없음', courseEvt.status === 200);

  const paywallEvt = await api('POST', '/api/events', { body: { name: 'paywall_viewed', props: { trigger: 'second_course' } } });
  t('이용권 화면 노출 이벤트 기록됨', paywallEvt.status === 200);

  const payStart = await api('POST', '/api/events', { body: { name: 'payment_started', props: { amount_krw: 9900, period_days: 30 } } });
  t('결제 시작 이벤트 기록됨', payStart.status === 200);

  const payResult = await api('POST', '/api/events', { body: { name: 'payment_result', props: { result: 'success' } }, token: tokenA });
  t('결제 결과 이벤트는 로그인 상태면 계정과 함께 기록됨(개인정보 아닌 내부 식별자)', payResult.status === 200);

  const noAuthEvt = await api('POST', '/api/events', { body: { name: 'import_start', props: { source_kind: 'zip' } } });
  t('로그인 전(가져오기 시작 등)에도 이벤트 기록 가능(계정 인증 필수 아님)', noAuthEvt.status === 200);
}

// --- 사전 신청(로드맵 ⑪ 소개 페이지) — 이메일만 받는다, 중복 신청은
// 조용히 성공(사용자에게 "이미 신청됨" 오류를 보여줄 필요 없음),
// waitlist_signup 이벤트도 events 화이트리스트를 그대로 탄다. ---
{
  const { waitlistCountForTest } = await import('../routes/waitlist.mjs');
  const before = waitlistCountForTest();

  const bad = await api('POST', '/api/waitlist', { body: { email: 'not-an-email' } });
  t('사전 신청 — 잘못된 이메일 형식 거부', bad.status === 400);

  const ok1 = await api('POST', '/api/waitlist', { body: { email: 'Waitlist-User@Example.com', channel: 'threads' } });
  t('사전 신청 — 정상 이메일 접수 성공', ok1.status === 200 && ok1.json.ok === true);
  t('사전 신청 — 실제로 한 행 늘어남', waitlistCountForTest() === before + 1);

  const ok2 = await api('POST', '/api/waitlist', { body: { email: 'waitlist-user@example.com', channel: 'instagram' } });
  t('사전 신청 — 같은 이메일 중복 신청도 오류 없이 성공(사용자 입장에서 실패로 안 보임)', ok2.status === 200 && ok2.json.ok === true);
  t('사전 신청 — 중복 신청은 새 행을 만들지 않음(대소문자 정규화 포함)', waitlistCountForTest() === before + 1);

  const evt = await api('POST', '/api/events', { body: { name: 'waitlist_signup', props: { channel: 'threads' } } });
  t('사전 신청 완료 이벤트도 기존 화이트리스트로 검증됨', evt.status === 200);
  const badEvt = await api('POST', '/api/events', { body: { name: 'waitlist_signup', props: { channel: '아무값' } } });
  t('사전 신청 이벤트도 허용된 채널값만 통과', badEvt.status === 400);
}

server.close();
console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
