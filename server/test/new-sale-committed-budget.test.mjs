'use strict';
/**
 * 2026-09-10 재검토(6차) 2절 — "전체 서비스 예산과 기존 유료 고객에게
 * 제공해야 할 잔여 사용량을 고려해 신규 판매 가능 여부를 판단하라."
 * 이미 활성인 유료 손님들의 약속된 잔여 몫(이용권당 원가 안전상한
 * 기준)을 먼저 빼고 나서도, 새 손님 한 명의 최악의 경우를 감당할
 * 여유가 남는지 확인한다.
 *
 * 실행: node server/test/new-sale-committed-budget.test.mjs
 */
process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'development';
process.env.COST_SAFETY_CAP_PAID_KRW_MICROS = '3000000'; // 3원 — 재현을 위해 작게
process.env.COST_PLACES_TEXT_SEARCH_KRW_MICROS = '1000000'; // 1원 — 최소 코스 원가 계산을 단순하게
process.env.COST_ROUTES_COMPUTE_KRW_MICROS = '1000000'; // 1원
process.env.COST_GLOBAL_MONTHLY_KRW_MICROS = '10000000'; // 전체 월 10원 — 3원짜리 손님 몇 명만 감당 가능

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
function makeActivePaidAccount(email) {
  const acc = directAccount(email);
  const orderId = 'order_' + uuid();
  const db = openDb();
  db.prepare('INSERT INTO orders (order_id, account_id, amount, status, entitlement_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(orderId, acc, 9900, 'paid', 30, nowIso(), nowIso());
  grantEntitlement(acc, 30, orderId);
  return { acc, orderId };
}

// 전체 월 예산 10원, 이용권 하나당 안전상한 3원. 활성 유료 손님 2명이
// 각자 아직 하나도 안 썼다고 가정하면, 그들에게 약속된 몫만 합쳐도
// 6원(3원×2)이다 — 남는 4원으로는 새 손님 한 명의 최악(3원)은 되지만,
// 손님을 하나 더 늘리면(3명째 활성 고객 몫 3원을 추가로 빼면) 남는
// 여유(1원)로는 새 손님을 못 받아야 한다.
{
  makeActivePaidAccount('existing-paid-1@example.com');
  makeActivePaidAccount('existing-paid-2@example.com');

  const { createOrder } = await import('../adapters/payment-toss.mjs');
  const newAcc = directAccount('new-customer-1@example.com');
  const order = createOrder(newAcc);
  t('활성 유료 손님 2명의 약속된 몫을 뺀 뒤에도 여유가 남아 새 결제가 허용됨', order.ok === true);
}

// 활성 유료 손님을 하나 더 늘려 3명으로 만들면(합계 9원 약속) 전체
// 예산(10원)에서 남는 여유(1원)로는 새 손님의 최악(3원)을 감당 못 해
// 새 결제가 막혀야 한다.
{
  makeActivePaidAccount('existing-paid-3@example.com');
  const { createOrder } = await import('../adapters/payment-toss.mjs');
  const newAcc2 = directAccount('new-customer-2@example.com');
  const order2 = createOrder(newAcc2);
  t('활성 유료 손님이 늘어 약속된 몫 합계가 예산을 압박하면 새 결제가 거부됨', order2.ok === false && order2.status === 503 && order2.reason === 'service-unavailable-for-new-sales');
}

// 기존 유료 손님 하나의 이용권이 만료되면(더 이상 활성 유료가 아니면)
// 그 손님에게 약속했던 몫이 계산에서 아예 빠져야 한다 — 그만큼 새
// 손님을 받을 여유가 다시 생겨야 한다("이미 다 썼다"와는 다른
// 경우다 — 만료는 애초에 더 못 쓴다는 뜻이라 committed 계산에서
// 완전히 제외돼야 맞다).
{
  const db = openDb();
  const row = db.prepare("SELECT id FROM accounts WHERE email = ?").get('existing-paid-3@example.com');
  db.prepare("UPDATE accounts SET plan_expires_at = ? WHERE id = ?").run('2000-01-01T00:00:00.000Z', row.id);

  const { createOrder } = await import('../adapters/payment-toss.mjs');
  const newAcc3 = directAccount('new-customer-3@example.com');
  const order3 = createOrder(newAcc3);
  t('만료된 기존 손님의 몫은 더 이상 계산에 안 들어가 새 손님에게 여유가 다시 생김', order3.ok === true);
}

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
