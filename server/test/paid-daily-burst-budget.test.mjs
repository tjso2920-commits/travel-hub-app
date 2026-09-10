'use strict';
/**
 * 2026-09-10 재검토(7차) 3절 — "하루 비용 제한과 판매 약속의 충돌 해결."
 *
 * 문제: 계정별 하루 비용 한도(perAccountDailyMicros, 기본 500원)가
 * 무료/유료 구분 없이 똑같이 적용됐다. 위치확인 단가(약 44.8원/건)
 * 기준 500원은 11건 만에 소진돼, 유료 이용권이 파는 "50곳 위치확인"을
 * 하루 안에 몰아 쓰는 것 자체가 애초에 막혀 있었다 — 의도한 정책이
 * 아니라 무료체험 크기에 맞춘 값을 유료에도 그대로 재사용한 버그였다.
 *
 * 이 테스트는 **기본 설정값**(costBudget·costSafetyCap·entitlementUsage
 * 전부 env로 덮어쓰지 않은 실제 출고 기본값)으로, 유료 고객이 실제로
 * "하루 안에 50곳 위치확인 + 코스 생성 1회"를 마칠 수 있는지 목(mock)
 * 비용 응답으로 검증한다 — 외부 공급자만 fetch를 가로채 모의하고,
 * 서버 쪽 코드 경로(비용 원장·이용권 차감·일일 한도 확인)는 전부 진짜로
 * 실행된다.
 *
 * 실행: node server/test/paid-daily-burst-budget.test.mjs
 */
process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'development';
process.env.GOOGLE_PLACES_API_KEY = 'fake-places-key';
process.env.GOOGLE_ROUTES_API_KEY = 'fake-routes-key';
// costBudget/costSafetyCap/entitlementUsage는 일부러 전부 기본값 그대로
// 둔다 — "출고 시 기본 설정으로 실제로 이 시나리오가 되는지"를 검증하는
// 것이 이 테스트의 핵심이다.

const { createServer } = await import('../index.mjs');
const { openDb, uuid, nowIso } = await import('../db.mjs');
const { grantEntitlement } = await import('../routes/entitlement.mjs');
const { config } = await import('../config.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

function jsonResponse(body) { return { ok: true, status: 200, json: async () => body }; }
const originalFetch = globalThis.fetch;
let placesCalls = 0, routesCalls = 0;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith(base)) return originalFetch(url, init);
  if (u.includes('places:searchText')) {
    placesCalls++;
    const body = JSON.parse(init.body);
    // 질의마다 실제로 다른 실제 장소로 확정되게(50곳이 진짜 서로 다른
    // real_place_id를 받아야 이 테스트가 "50곳을 실제로 확인"한 걸
    // 증명한다).
    return jsonResponse({ places: [{ id: 'real-place-' + body.textQuery, displayName: { text: body.textQuery }, formattedAddress: '테스트 주소', location: { latitude: 33.5, longitude: 130.4 } }] });
  }
  if (u.includes('computeRoutes')) {
    routesCalls++;
    const body = JSON.parse(init.body);
    const legCount = 1 + (body.intermediates ? body.intermediates.length : 0);
    const legs = Array.from({ length: legCount }, () => ({ distanceMeters: 300, duration: '240s' }));
    return jsonResponse({ routes: [{ legs }] });
  }
  throw new Error('unexpected fetch: ' + u);
};

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

t('사전 조건 — 위치확인 단가가 실제 문서화된 약 44.8원임(재현 조건 확인)', Math.abs(config.costEstimate.placesTextSearchMicros - 44_800_000) < 100_000);
t('사전 조건 — 유료 이용권의 위치확인 한도가 50곳임', config.entitlementUsage.paidPlaceLookupLimit === 50);
t('사전 조건 — 계정별 하루 비용 한도(기본값)가 500원으로, 50곳(2,240원)보다 훨씬 작음(고쳐야 하는 상황 재현)', config.costBudget.perAccountDailyMicros < 50 * config.costEstimate.placesTextSearchMicros);

const acc = directAccount('paid-burst@example.com');
const token = directSession(acc);
const orderId = 'order_' + uuid();
const db = openDb();
db.prepare('INSERT INTO orders (order_id, account_id, amount, status, entitlement_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
  .run(orderId, acc, 9900, 'paid', 30, nowIso(), nowIso());
grantEntitlement(acc, 30, orderId);

// 하루 안에(같은 날짜·같은 프로세스 실행 안에서) 50곳을 전부 실제로
// 위치확인한다 — 실제 서로 다른 검색어로 서로 다른 실제 장소를 확인해
// 우회(2절)가 아니라 정말 정직하게 50곳을 채운다.
let okCount = 0; let blocked = null;
for (let i = 0; i < 50; i++) {
  const q = '유료고객장소' + i;
  const r = await api('GET', `/api/places/lookup?q=${encodeURIComponent(q)}&placeId=${encodeURIComponent('paid-place-' + i)}`, { token });
  if (r.status === 200 && r.json.ok === true) okCount++;
  else if (!blocked) blocked = r;
}
t('유료 고객이 하루 안에 실제로 50곳을 전부 위치확인함(우회 없이 각각 실제로 다른 장소)', okCount === 50);
if (!(okCount === 50)) {
  console.log('블락된 응답:', JSON.stringify(blocked));
}
t('실제 위치확인 외부 호출도 정확히 50번 나감(캐시·중복 없이 진짜 50건)', placesCalls === 50);

const summaryAfterLookups = await api('GET', '/api/account/usage', { token });
t('계정 사용량에 50곳이 정확히 반영됨', summaryAfterLookups.json.placeLookups.used === 50);
t('위치확인 한도를 완전히 다 썼다고 정확히 표시됨(잔여 0)', summaryAfterLookups.json.placeLookups.remaining === 0);

// 51번째(새로운 실제 장소)는 이용권 한도(50)에 걸려 정직하게 거부돼야
// 한다 — 이때도 비용 문제가 아니라 "이용권 다 썼다"는 정확한 사유가
// 나와야 한다(3절 "정확한 사유" 지시).
const over = await api('GET', '/api/places/lookup?q=유료고객장소51번째&placeId=paid-place-over', { token });
t('50곳을 다 쓴 뒤 51번째 새 장소는 이용권 한도로 정직하게 거부됨(비용 문제로 오인되지 않음)', over.status === 402 && over.json.reason === 'entitlement-place-lookup-limit-reached');

// 같은 날, 같은 유료 고객이 코스 생성까지 이어서 한다(원장 3절
// "첫 코스 생성에 필요한 예산도 고려" — 위치확인 50건을 다 쓴 뒤에도
// 코스 생성 예산이 남아 있어야 한다).
const origin = { lat: 33.590, lng: 130.400 };
const places = Array.from({ length: 8 }, (_, i) => ({ id: 'course-place-' + i, name: 'P' + i, lat: 33.591 + i * 0.001, lng: 130.401 + i * 0.001 }));
const gen = await api('POST', '/api/course/generate', { token, body: { idempotencyKey: 'paid-burst-course-1', city: '테스트시티', date: '2026-03-01', origin, places } });
t('같은 날 위치확인 50건에 이어 코스 생성도 실제 경로로 성공함', gen.status === 200 && gen.json.course.routedReal === true);
t('실제 Routes 호출도 나감(추정으로 대체되지 않음)', routesCalls >= 1);

const summaryAfterCourse = await api('GET', '/api/account/usage', { token });
t('코스 생성 사용량도 1건으로 정확히 반영됨', summaryAfterCourse.json.courseGenerations.used === 1);

globalThis.fetch = originalFetch;
console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
