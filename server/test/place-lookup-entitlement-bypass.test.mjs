'use strict';
/**
 * 2026-09-10 재검토(7차) 2절 — "신규 장소 확인 한도 우회 차단."
 *
 * ChatGPT가 실제로 재현한 우회: 무료 위치확인 한도를 1로 두고, 같은
 * 클라이언트 placeId에 서로 다른 검색어를 보내면 서로 다른 실제 장소
 * 6곳을 확인받고도 서버에 기록된 사용량은 1로만 남았다 — "신규 여부"를
 * 클라이언트가 불러주는 문자열(placeId)만으로 판정하고, 실제로 어떤
 * 장소가 확정됐는지와 전혀 대조하지 않았기 때문이다.
 *
 * 이 테스트는 entitlement-usage.mjs의 두 단계(reserve 전 잠정 예약 →
 * finalize 시 실제 real_place_id로 재판정) 구조가 지시된 3가지 조건을
 * 실제로 만족하는지 확인한다:
 *   (a) 같은 id + 다른 검색어 → 실제로 다른 장소면 각각 신규로 과금
 *   (b) 다른 id + 같은 실제 장소 → 비과금(이미 낸 비용 재사용)
 *   (c) 동시 요청(성공/실패, 성공/성공-중복) — 예약이 정확히 복원되고
 *       이미 성공한 기록을 잘못 지우지 않음
 *
 * 실행: node server/test/place-lookup-entitlement-bypass.test.mjs
 */
process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'development';
process.env.ENTITLEMENT_FREE_PLACE_LOOKUP_LIMIT = '2';

const { createServer } = await import('../index.mjs');
const { openDb, uuid, nowIso } = await import('../db.mjs');

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
function lookup(token, q, placeId) {
  return api('GET', `/api/places/lookup?q=${encodeURIComponent(q)}&placeId=${encodeURIComponent(placeId)}`, { token });
}

// 테스트 어댑터(place-lookup.mjs)는 질의 문자열의 해시로 결정론적
// 좌표/placeId를 만든다 — 해시%5===0이면 not-found. 미리 계산해 둔,
// 서로 다른 실제 결과를 내는 안전한 질의들(모두 not-found 아님):
// '알파'→test-1619776, '베타'→test-1550368, '감마'→test-1413048,
// '델타'→test-1477704. '에타'는 해시%5===0(not-found)라 실패 재현에 쓴다.
const Q_A = '알파', Q_B = '베타', Q_C = '감마', Q_D = '델타', Q_NOTFOUND = '에타';

// =====================================================================
// (a) 같은 클라이언트 placeId + 서로 다른 검색어 → 실제로 다른 장소가
//     나오면 각각 신규로 과금돼야 한다(예전엔 여기서 우회가 났다).
// =====================================================================
{
  const acc = directAccount('bypass-a@example.com');
  const token = directSession(acc);
  const SLOT = 'client-slot-fixed';

  const r1 = await lookup(token, Q_A, SLOT);
  t('(a) 첫 검색 성공(신규 장소 1)', r1.status === 200 && r1.json.ok === true);
  const place1 = r1.json.placeId;

  const r2 = await lookup(token, Q_B, SLOT);
  t('(a) 같은 로컬 id에 다른 검색어를 보내도 실제로 다른 장소가 나오면 성공', r2.status === 200 && r2.json.ok === true);
  const place2 = r2.json.placeId;
  t('(a) 두 검색이 실제로 서로 다른 실제 장소를 가리킴(재현 조건 확인)', place1 !== place2);

  const summaryAfterTwo = await api('GET', '/api/account/usage', { token });
  t('(a) 서로 다른 실제 장소 2곳을 확인한 만큼 사용량이 정확히 2로 올라감(우회 차단 핵심)', summaryAfterTwo.json.placeLookups.used === 2);

  // 한도(2)를 이미 채웠다 — 같은 로컬 id로 세 번째 "실제로 다른" 장소를
  // 또 확인하려 하면 정직하게 막혀야 한다.
  const r3 = await lookup(token, Q_C, SLOT);
  t('(a) 한도를 채운 뒤 같은 id로 또 다른 실제 장소를 확인하려 하면 거부됨', r3.status === 402 && r3.json.reason === 'entitlement-place-lookup-limit-reached');
}

// =====================================================================
// (b) 서로 다른 클라이언트 placeId가 결국 같은 실제 장소로 확인되면
//     두 번째는 비과금이어야 한다(이미 낸 비용의 재사용).
// =====================================================================
{
  const acc = directAccount('bypass-b@example.com');
  const token = directSession(acc);

  const r1 = await lookup(token, Q_A, 'local-slot-1');
  t('(b) 첫 로컬 슬롯으로 장소 확인 성공', r1.status === 200 && r1.json.ok === true);

  const r2 = await lookup(token, Q_A, 'local-slot-2'); // 다른 로컬 id, 같은 검색어 → 같은 실제 장소
  t('(b) 다른 로컬 id가 같은 실제 장소로 확인돼도 요청 자체는 성공', r2.status === 200 && r2.json.ok === true);
  t('(b) 실제로 같은 장소를 가리킴(재현 조건 확인)', r1.json.placeId === r2.json.placeId);

  const summary = await api('GET', '/api/account/usage', { token });
  t('(b) 같은 실제 장소를 다른 로컬 id로 다시 확인해도 사용량은 그대로 1(비과금)', summary.json.placeLookups.used === 1);

  // 남은 한도(1곳 더)로 실제로 새로운 장소는 정상 과금돼야 한다 —
  // (b)의 무료 재사용이 한도 자체를 갉아먹지 않았는지 확인.
  const r3 = await lookup(token, Q_D, 'local-slot-3');
  t('(b) 무료 재사용 이후에도 남은 한도로 진짜 신규 장소는 정상 과금됨', r3.status === 200 && r3.json.ok === true);
  const summary2 = await api('GET', '/api/account/usage', { token });
  t('(b) 최종 사용량 2 (신규 1 + 무료재사용 0 + 신규 1)', summary2.json.placeLookups.used === 2);
}

// =====================================================================
// (c) 동시 요청 — 성공/실패가 섞여도 예약이 정확히 복원되고, 완전히
//     같은 조건의 중복 동시 요청도 이중 과금되지 않는다.
// =====================================================================
{
  const acc = directAccount('bypass-c1@example.com');
  const token = directSession(acc);
  // 성공(새 실제 장소) + 실패(not-found)를 동시에 보낸다.
  const [ok1, fail1] = await Promise.all([
    lookup(token, Q_A, 'c-ok'),
    lookup(token, Q_NOTFOUND, 'c-fail'),
  ]);
  t('(c) 동시 요청 중 성공 건은 정상 처리됨', ok1.status === 200 && ok1.json.ok === true);
  t('(c) 동시 요청 중 실패(not-found) 건은 실패로 정직하게 보고됨', fail1.status === 200 && fail1.json.ok === false);
  const summaryC1 = await api('GET', '/api/account/usage', { token });
  t('(c) 실패 건은 예약이 되돌려져 사용량에 안 잡히고, 성공 건만 1로 정확히 잡힘', summaryC1.json.placeLookups.used === 1);

  // 완전히 같은 로컬 id + 같은 검색어로 된 요청을 동시에 두 번 보낸다
  // (레이스로 이중 과금되지 않아야 하고, 둘 다 같은 실제 결과를 받아야
  // 한다 — 서버가 먼저 응답한 쪽만 반영하고 나머지를 잃어버리면 안 됨).
  const acc2 = directAccount('bypass-c2@example.com');
  const token2 = directSession(acc2);
  const [d1, d2] = await Promise.all([
    lookup(token2, Q_A, 'dup-slot'),
    lookup(token2, Q_A, 'dup-slot'),
  ]);
  t('(c) 완전히 같은 조건의 동시 중복 요청 둘 다 성공으로 응답받음', d1.status === 200 && d1.json.ok === true && d2.status === 200 && d2.json.ok === true);
  const summaryC2 = await api('GET', '/api/account/usage', { token: token2 });
  t('(c) 완전히 같은 조건의 동시 중복 요청은 딱 1건으로만 과금됨(이중 과금 방지)', summaryC2.json.placeLookups.used === 1);
}

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
