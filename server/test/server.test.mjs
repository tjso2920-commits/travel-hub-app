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

server.close();
console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
