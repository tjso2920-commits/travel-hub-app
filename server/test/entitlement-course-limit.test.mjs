'use strict';
/**
 * 2026-09-10 재검토(6차) 1절 — "유료 이용권: 실제 코스 생성·재계산
 * 성공 30회"(테스트에서는 작은 값으로 재현). 멱등 재전송은 미차감,
 * 날짜별 성공은 각각 1회로 집계됨을 확인한다.
 *
 * 실행: node server/test/entitlement-course-limit.test.mjs
 */
process.env.DB_PATH = ':memory:';
process.env.FORCE_TEST_MODE = 'true';
process.env.ROUTING_TEST_FORCE = 'success';
process.env.ENTITLEMENT_PAID_COURSE_LIMIT = '2';

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

const acc = directAccount('paid-course-limit@example.com');
const token = directSession(acc);
const orderId = 'order_' + uuid();
const db = openDb();
db.prepare('INSERT INTO orders (order_id, account_id, amount, status, entitlement_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
  .run(orderId, acc, 9900, 'paid', 30, nowIso(), nowIso());
grantEntitlement(acc, 30, orderId);

const origin = { lat: 33.590, lng: 130.400 };
const places = [{ id: 'p1', name: 'A', lat: 33.591, lng: 130.401 }];

// 1일차 — 첫 번째 성공.
const r1 = await api('POST', '/api/course/generate', { token, body: { idempotencyKey: 'k-day1', city: 'X', date: '2026-01-01', origin, places } });
t('1일차 코스 생성 성공(1/2)', r1.status === 200 && r1.json.course.routedReal === true);

// 같은 idempotencyKey로 재전송 — 멱등 재생, 사용량 추가 차감 없음.
const r1replay = await api('POST', '/api/course/generate', { token, body: { idempotencyKey: 'k-day1', city: 'X', date: '2026-01-01', origin, places } });
t('같은 멱등키 재전송은 저장된 결과를 그대로 재생함', r1replay.status === 200 && r1replay.json.replay === true);

// 2일차 — 다른 날짜, 별도 성공으로 집계(2/2).
const r2 = await api('POST', '/api/course/generate', { token, body: { idempotencyKey: 'k-day2', city: 'X', date: '2026-01-02', origin, places } });
t('2일차 코스 생성 성공(2/2, 날짜별로 별도 집계)', r2.status === 200 && r2.json.course.routedReal === true);

const usageAfterTwo = await api('GET', '/api/account/usage', { token });
t('두 날짜 성공 후 사용량이 정확히 2로 집계됨(멱등 재전송은 안 늘어남)', usageAfterTwo.json.courseGenerations.used === 2);
t('잔여 코스 생성 횟수가 0으로 정확히 표시됨', usageAfterTwo.json.courseGenerations.remaining === 0);

// 3일차 — 한도(2) 초과, 실제 라우팅 호출 없이 403으로 거부돼야 한다.
const r3 = await api('POST', '/api/course/generate', { token, body: { idempotencyKey: 'k-day3', city: 'X', date: '2026-01-03', origin, places } });
t('한도(2)를 넘는 3번째 코스 생성은 403으로 거부됨', r3.status === 403 && r3.json.reason === 'entitlement-course-limit-reached');

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
