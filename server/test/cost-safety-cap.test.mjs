'use strict';
/**
 * 2026-09-10 재검토(6차) 2절 — 내부 원가 안전상한(무료체험 누적/유료
 * 이용권당 누적)이 실제로 추가 외부 호출을 막는지 확인한다. 이 상한은
 * 고객에게 보여주는 "몇 번 남았는지"(entitlement-usage.test.mjs가
 * 검증)와는 별개 층이다 — 같은 장소를 반복 재조회하면(신규 한도는 안
 * 깎이지만) 실제 비용은 계속 나가므로, 이 안전상한이 그 반복 재조회
 * 남용까지 결국 막아 준다는 걸 재현한다.
 *
 * 실행: node server/test/cost-safety-cap.test.mjs
 */
process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'development';
process.env.GOOGLE_PLACES_API_KEY = 'fake-places-key';
process.env.COST_PLACES_TEXT_SEARCH_KRW_MICROS = '1000000'; // 1원 — 계산을 간단히
process.env.COST_SAFETY_CAP_FREE_KRW_MICROS = '3000000'; // 3원 — 재현을 위해 작게
process.env.ENTITLEMENT_FREE_PLACE_LOOKUP_LIMIT = '100'; // 신규 한도는 충분히 크게 둬서, 이 테스트가 안전상한만 순수하게 겨냥하게 함

const { createServer } = await import('../index.mjs');
const { openDb, uuid, nowIso } = await import('../db.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

function jsonResponse(status, body) { return { ok: status >= 200 && status < 300, status, json: async () => body }; }
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith(base)) return originalFetch(url, init);
  return jsonResponse(200, { places: [{ id: 'place_x', displayName: { text: 'X' }, formattedAddress: 'Y', location: { latitude: 33.5, longitude: 130.4 } }] });
};

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

const acc = directAccount('cost-safety-cap@example.com');
const token = directSession(acc);

// 같은 장소(reuse-target)를 반복 재조회한다 — 신규 한도(100)는 절대
// 안 걸리지만(재사용은 항상 isNew:false), 매번 실제 외부 호출이 나가
// 실제 비용은 계속 쌓인다. 안전상한(3원)을 3번째 호출에서 넘는다.
let okCount = 0, blockedStatus = null;
for (let i = 0; i < 5; i++) {
  // 질의 문자열을 매번 살짝 바꿔 캐시를 우회한다(캐시가 있으면 실제
  // 외부 호출·비용 자체가 안 생겨 이 테스트 목적과 안 맞다) — 대신
  // placeId는 고정해 서버가 "이미 확인된 같은 장소를 다시 조회하는
  // 상황"(공급자 정책상 재조회 — 신규 한도는 안 깎이지만 비용은 계속
  // 나가는 경우)으로 정확히 취급하게 한다.
  const r = await api('GET', `/api/places/lookup?q=${encodeURIComponent('반복재조회장소' + i)}&placeId=repeat-1`, { token });
  if (r.status === 200) okCount++;
  else if (blockedStatus === null) blockedStatus = r;
}
t('안전상한 안에서는 정상 처리됨(3원 한도, 1원씩 3건)', okCount === 3);
t('안전상한을 넘으면 비용 한도 초과로 차단됨(503)', blockedStatus && blockedStatus.status === 503 && blockedStatus.json.reason === 'cost-budget-exceeded');
t('차단 상세 사유가 이용권 기간 안전상한임을 구분해 표시함', blockedStatus && blockedStatus.json.detail === 'entitlement-period-cost-safety-cap-exceeded');

globalThis.fetch = originalFetch;
console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
