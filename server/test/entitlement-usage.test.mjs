'use strict';
/**
 * 2026-09-10 재검토(6차) 1-2절 — "이용권 횟수(고객 사용량)와 실제 비용
 * 원장을 분리"의 신규 장소 위치 확인 부분 검증. 작은 한도 값으로
 * 재현해 실제로 정확히 그 개수에서 막히는지, 재사용은 미차감되는지,
 * 실패는 미차감(예약 되돌림)되는지 확인한다.
 *
 * 실행: node server/test/entitlement-usage.test.mjs
 */
process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'development';
process.env.ENTITLEMENT_FREE_PLACE_LOOKUP_LIMIT = '2';
process.env.ENTITLEMENT_PAID_PLACE_LOOKUP_LIMIT = '3';
process.env.ENTITLEMENT_FREE_COURSE_LIMIT = '1';
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
  let json = null;
  try { json = await res.json(); } catch (e) { /* no body */ }
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

// ============================================================
// 1. 무료체험 — 신규 장소 위치 확인 최대 2곳(테스트용 축소값)까지만
//    되고, 그 이상은 실제 호출 전에 정직하게 막힌다.
// ============================================================
{
  const acc = directAccount('free-place-limit@example.com');
  const token = directSession(acc);

  const r1 = await api('GET', '/api/places/lookup?q=역&placeId=fp1', { token });
  const r2 = await api('GET', '/api/places/lookup?q=타워&placeId=fp2', { token });
  t('1번째 신규 장소 확인 성공', r1.status === 200);
  t('2번째 신규 장소 확인 성공', r2.status === 200);

  const r3 = await api('GET', '/api/places/lookup?q=공원&placeId=fp3', { token });
  t('3번째(한도 초과) 신규 장소 확인은 402로 정직하게 거부됨', r3.status === 402 && r3.json.reason === 'entitlement-place-lookup-limit-reached');

  const summary = await api('GET', '/api/account/usage', { token });
  t('계정 사용량 요약에 잔여 위치확인 0으로 정확히 반영됨', summary.status === 200 && summary.json.placeLookups.remaining === 0 && summary.json.placeLookups.used === 2);
}

// ============================================================
// 2. 이미 확인된 장소를 재조회하는 것은 신규 한도를 안 깎는다.
// ============================================================
{
  const acc = directAccount('reuse-no-charge@example.com');
  const token = directSession(acc);
  await api('GET', '/api/places/lookup?q=역&placeId=reuse1', { token });
  await api('GET', '/api/places/lookup?q=타워&placeId=reuse2', { token });
  // 한도(2)를 이미 다 썼다 — 그런데 같은 placeId(reuse1)를 다시
  // 조회하면 "신규"가 아니므로 한도와 무관하게 통과해야 한다.
  const again = await api('GET', '/api/places/lookup?q=역&placeId=reuse1', { token });
  t('이미 확인된 장소(reuse1)를 재조회하면 한도가 이미 소진돼도 차단되지 않음', again.status === 200);
  const summary = await api('GET', '/api/account/usage', { token });
  t('재조회는 신규 한도를 추가로 깎지 않음(그대로 2건)', summary.json.placeLookups.used === 2);
}

// ============================================================
// 3. 신규 장소인데 실제로 후보를 못 찾으면(실패) 한도를 깎지 않는다
//    (예약을 되돌림).
// ============================================================
{
  const acc = directAccount('failed-lookup-no-charge@example.com');
  const token = directSession(acc);
  // 테스트 어댑터는 질의 문자열의 해시가 5의 배수면 결정론적으로
  // not-found를 낸다(place-lookup.mjs의 testAdapter) — "없는곳1"은
  // 미리 계산해 둔, 항상 not-found가 나오는 질의다(재현 가능한 테스트).
  const r = await api('GET', `/api/places/lookup?q=${encodeURIComponent('없는곳1')}&placeId=nf1`, { token });
  t('사전 조건 — not-found 결과를 확보함', r.status === 200 && r.json.ok === false);
  const summary = await api('GET', '/api/account/usage', { token });
  t('실패(not-found)한 신규 장소 조회는 위치확인 한도를 안 깎음(사용 0건 유지)', summary.json.placeLookups.used === 0);
}

// ============================================================
// 4. 유료 이용권 — 한도가 무료(2)와 다르게 유료용(3)으로 적용됨.
// ============================================================
{
  const acc = directAccount('paid-place-limit@example.com');
  const token = directSession(acc);
  const orderId = 'order_' + uuid();
  const db = openDb();
  db.prepare('INSERT INTO orders (order_id, account_id, amount, status, entitlement_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(orderId, acc, 9900, 'paid', 30, nowIso(), nowIso());
  grantEntitlement(acc, 30, orderId);

  for (let i = 0; i < 3; i++) {
    const r = await api('GET', `/api/places/lookup?q=${encodeURIComponent('paid-place-' + i)}&placeId=${encodeURIComponent('pp' + i)}`, { token });
    t(`유료 계정 ${i + 1}번째 신규 장소 확인 성공`, r.status === 200);
  }
  const over = await api('GET', '/api/places/lookup?q=paid-over&placeId=pp-over', { token });
  t('유료 한도(3)를 넘으면 역시 402로 거부됨', over.status === 402 && over.json.reason === 'entitlement-place-lookup-limit-reached');
  const summary = await api('GET', '/api/account/usage', { token });
  t('유료 계정 사용량 요약은 kind=paid로 표시됨', summary.json.kind === 'paid');
  t('유료 계정 위치확인 한도가 3으로 반영됨(무료 2와 다름)', summary.json.placeLookups.limit === 3);
}

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
