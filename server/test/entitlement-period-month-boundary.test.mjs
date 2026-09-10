'use strict';
/**
 * 2026-09-10 재검토(6차) 1절 — "30일 이용권이 월 경계를 넘어도 사용량·
 * 비용이 잘못 초기화되지 않게 검증." 이용권 기간은 달력월이 아니라
 * 그 이용권을 부여한 주문(order_id)에 고정된다(entitlement-usage.mjs
 * 의 currentPeriod) — 이 테스트는 사용 기록의 시각(updated_at/
 * created_at)이 서로 다른 달을 가리키도록 직접 조작한 뒤에도, 같은
 * period_id(주문)라면 사용량이 계속 누적되지(초기화되지 않고) 확인한다.
 *
 * 실행: node server/test/entitlement-period-month-boundary.test.mjs
 */
process.env.DB_PATH = ':memory:';
process.env.FORCE_TEST_MODE = 'true';
process.env.ROUTING_TEST_FORCE = 'success';
process.env.ENTITLEMENT_PAID_COURSE_LIMIT = '5';
process.env.ENTITLEMENT_PAID_PLACE_LOOKUP_LIMIT = '5';

const { createServer } = await import('../index.mjs');
const { openDb, uuid, nowIso } = await import('../db.mjs');
const { grantEntitlement } = await import('../routes/entitlement.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

async function api(method, path, { body, token } = {}) {
  const res = await fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch (e) {}
  return { status: res.status, json };
}
function directAccount(email) {
  const db = openDb();
  const id = uuid();
  db.prepare('INSERT INTO accounts (id, email, created_at, plan) VALUES (?, ?, ?, ?)').run(id, email, nowIso(), 'free');
  return id;
}
function directSession(accountId) {
  const db = openDb();
  const token = Buffer.from(String(Math.random())).toString('hex') + accountId;
  db.prepare('INSERT INTO sessions (token, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, accountId, new Date().toISOString(), new Date(Date.now() + 3600_000).toISOString());
  return token;
}

// 1월 20일에 구매(30일 이용권 → 만료는 2월 19일, 달력월을 넘는다).
const purchaseDate = new Date('2026-01-20T00:00:00.000Z');
const acc = directAccount('month-boundary@example.com');
const token = directSession(acc);
const orderId = 'order_' + uuid();
const db = openDb();
db.prepare('INSERT INTO orders (order_id, account_id, amount, status, entitlement_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
  .run(orderId, acc, 9900, 'paid', 30, purchaseDate.toISOString(), purchaseDate.toISOString());
// grantEntitlement는 "지금부터" 30일로 만료일을 계산한다 — 이 테스트는
// 실제 만료 여부가 아니라 "사용량이 달력월과 무관하게 같은 period_id에
// 계속 쌓이는지"만 검증하므로, 실제 지금 시각 기준으로 부여해도
// 무방하다(핵심은 아래에서 usage 기록의 시각을 직접 과거 달로 조작하는 것).
grantEntitlement(acc, 30, orderId);

const origin = { lat: 33.590, lng: 130.400 };
const places = [{ id: 'p1', name: 'A', lat: 33.591, lng: 130.401 }];

// 1월 안에 코스 하나를 만든다(같은 period_id=orderId로 기록됨).
const rJan = await api('POST', '/api/course/generate', { token, body: { idempotencyKey: 'k-jan', city: 'X', date: '2026-01-25', origin, places } });
t('1월 안의 코스 생성 성공', rJan.status === 200 && rJan.json.course.routedReal === true);

// 이 사용 기록의 시각을 실제로 "1월"을 가리키도록 직접 맞춘다(이미
// 그렇지만, 테스트 환경의 실제 "지금"이 어느 달이든 상관없이 재현
// 가능하도록 명시적으로 고정한다).
db.prepare('UPDATE entitlement_usage SET updated_at = ? WHERE account_id = ? AND period_id = ?')
  .run('2026-01-25T00:00:00.000Z', acc, orderId);

const usageAfterJan = await api('GET', '/api/account/usage', { token });
t('1월 사용 직후 사용량 1로 집계됨', usageAfterJan.json.courseGenerations.used === 1);

// 이제 "2월"에 같은 계정이 같은 이용권(같은 orderId)으로 코스를 하나
// 더 만든다 — 달력월이 바뀌었다는 이유로 사용량이 0으로 초기화되면
// 안 되고, 그대로 이어서 2가 돼야 한다.
const rFeb = await api('POST', '/api/course/generate', { token, body: { idempotencyKey: 'k-feb', city: 'X', date: '2026-02-05', origin, places } });
t('2월(달력월이 바뀐 뒤)에도 같은 이용권으로 코스 생성 계속 가능', rFeb.status === 200 && rFeb.json.course.routedReal === true);

const usageAfterFeb = await api('GET', '/api/account/usage', { token });
t('달력월이 바뀌어도 사용량이 초기화되지 않고 계속 누적됨(1월 1건 + 2월 1건 = 2건)', usageAfterFeb.json.courseGenerations.used === 2);
t('잔여 횟수도 월경계와 무관하게 정확히 계산됨(한도 5 - 사용 2 = 3)', usageAfterFeb.json.courseGenerations.remaining === 3);

// 장소 위치 확인도 마찬가지로 검증 — 1월에 확인한 장소 카운트가
// 2월에도 그대로 유지된 채 누적되는지.
const lookupJan = await api('GET', '/api/places/lookup?q=역&placeId=jan-place-1', { token });
t('1월 장소 확인 성공', lookupJan.status === 200);
db.prepare('UPDATE entitlement_usage SET updated_at = ? WHERE account_id = ? AND period_id = ?').run('2026-01-26T00:00:00.000Z', acc, orderId);
// 2026-09-10 재검토(7차) — entitlement_place_confirmed의 키가 클라이언트
// 로컬 placeId('jan-place-1')가 아니라 공급자가 실제로 돌려준
// real_place_id로 바뀌었다(2절 우회 수정). 이 시점엔 이 계정의 확인
// 기록이 이 조회 하나뿐이라 account_id만으로 특정해도 안전하다.
db.prepare('UPDATE entitlement_place_confirmed SET confirmed_at = ? WHERE account_id = ?').run('2026-01-26T00:00:00.000Z', acc);

const lookupFeb = await api('GET', '/api/places/lookup?q=타워&placeId=feb-place-1', { token });
t('2월 장소 확인도 같은 이용권 기간으로 이어서 누적됨', lookupFeb.status === 200);
const usageAfterBothLookups = await api('GET', '/api/account/usage', { token });
t('장소 확인 사용량도 월경계와 무관하게 2건으로 정확히 누적됨', usageAfterBothLookups.json.placeLookups.used === 2);

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
