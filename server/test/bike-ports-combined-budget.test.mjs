'use strict';
/**
 * 자전거 공유 반납 포트 안내(차리차리 등) — 2026-09-16 ChatGPT 재검토
 * 3절: "computeBicycleRoute와 computeWalkingRoute가 비용을 각각
 * 검사한다. 두 구간의 전체 요청 계획을 먼저 만들고 계정·이용권·서비스
 * 전체 예산을 함께 검사·예약하라. 전체 예산이 부족하면 첫 공급자
 * 호출부터 실행하지 말라."
 *
 * cost-budget-allornothing.test.mjs와 같은 원칙(자전거 세그먼트 하나만
 * 보면 예산 안에 들지만, 자전거+도보 합계는 예산을 넘는 상황)을
 * 재현한다 — 예전 버전은 computeBicycleRoute가 먼저 자기 몫만 확인해
 * 통과·과금·호출까지 끝내고, 그다음 computeWalkingRoute가 따로 확인해
 * 예산이 모자라면 도보만 실패했다(자전거는 실제로 이미 돈을 쓰고
 * 호출까지 나간 뒤였다). 지금은 routing.mjs의 computeBikeGuideRoutes가
 * 두 구간을 하나의 chargeCostBatch로 묶으므로, 이 시나리오에서 실제
 * 공급자 호출이 "0번"이어야 한다(all-or-nothing).
 *
 * 실행: node server/test/bike-ports-combined-budget.test.mjs
 * 실제 스크래핑 데이터는 쓰지 않는다 — 합성 좌표만 쓴다.
 */
process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'development';
process.env.GOOGLE_ROUTES_API_KEY = 'fake-routes-key';
process.env.ROUTES_MAX_INTERMEDIATES_PER_CALL = '25';
process.env.ROUTES_HIGH_VOLUME_THRESHOLD = '11';
// 자전거 세그먼트(1건) + 도보 세그먼트(1건) = 2건, 각 1원. 계정 일일
// 한도를 1.5원으로 잡아 "자전거 세그먼트 1건만 보면 통과하지만 합계
// 2건은 못 넘는" 상황을 만든다(cost-budget-allornothing.test.mjs와
// 같은 구성).
process.env.COST_ROUTES_COMPUTE_KRW_MICROS = '1000000';
process.env.COST_ROUTES_COMPUTE_HIGHVOLUME_KRW_MICROS = '1000000';
process.env.COST_PER_ACCOUNT_DAILY_KRW_MICROS = '1500000';
process.env.COST_SAFETY_CAP_FREE_KRW_MICROS = '1500000';

const { createServer } = await import('../index.mjs');
const { sentEmailsForTest } = await import('../adapters/email.mjs');
const { openDb, nowIso } = await import('../db.mjs');
const { setTestAccessByEmail } = await import('../routes/entitlement.mjs');
const { config } = await import('../config.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

t('사전 조건 — 세그먼트 단가가 1원으로 정확히 설정됨', config.costEstimate.routesComputeMicros === 1_000_000);
t('사전 조건 — 계정 일일 한도(1.5원)가 세그먼트 1건(1원)보다는 크다(자전거 하나만 보면 통과할 수 있는 상황을 일부러 만듦)', config.costBudget.perAccountDailyMicros > config.costEstimate.routesComputeMicros);

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

// paid-daily-burst-budget.test.mjs와 같은 원칙 — 이 테스트도 실제
// HTTP로 자신의 로컬 서버를 부르므로(api() 헬퍼), 전역 fetch를 그냥
// 다 가로채면 로컬 서버 호출 자체까지 "공급자 호출"로 잘못 셀 수
// 있다. base로 시작하는 호출(로컬 서버)은 그대로 통과시키고, 실제
// Google Routes computeRoutes 호출만 센다.
function mockFetchCounting() {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith(base)) return originalFetch(url, init);
    const body = JSON.parse(init.body);
    calls.push({ url: u, body });
    const legCount = 1 + (body.intermediates ? body.intermediates.length : 0);
    const legs = Array.from({ length: legCount }, () => ({ distanceMeters: 100, duration: '80s' }));
    return { ok: true, status: 200, json: async () => ({ routes: [{ legs }] }) };
  };
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

async function api(method, path, { body, token } = {}) {
  const res = await fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, json };
}
async function login(email) {
  await api('POST', '/api/auth/request-code', { body: { email } });
  const code = sentEmailsForTest.filter((e) => e.to === email).pop().body.match(/(\d{6})/)[1];
  return (await api('POST', '/api/auth/verify-code', { body: { email, code } })).json;
}

{
  const db = openDb();
  const now = nowIso();
  db.prepare(`INSERT INTO bike_share_ports (provider_id, region_code, port_id, title, address, capacity, lat, lng, imported_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run('charichari', 'FUK', 'TEST-A', '합성 포트 A', '합성주소 A', 10, 33.590, 130.401, now);
  db.prepare(`INSERT INTO bike_share_import_meta (provider_id, region_code, source_url, endpoint, retrieved_at, port_count, imported_at) VALUES (?,?,?,?,?,?,?)`)
    .run('charichari', 'FUK', 'https://example.invalid/map', 'https://example.invalid/graphql', now, 1, now);
}

const acc = await login('bike-combined-budget@example.com');
setTestAccessByEmail('bike-combined-budget@example.com', true);

const origin = { lat: 33.5905, lng: 130.4015 };
const destination = { lat: 33.592, lng: 130.403 };

const before = openDb().prepare('SELECT COUNT(*) AS n FROM cost_ledger').get().n;
const mock = mockFetchCounting();
const r = await api('POST', '/api/bike-ports/guide', { token: acc.token, body: {
  idempotencyKey: 'combined-budget-1', providerId: 'charichari', regionCode: 'FUK', portId: 'TEST-A', origin, destination,
} });
mock.restore();
const after = openDb().prepare('SELECT COUNT(*) AS n FROM cost_ledger').get().n;

t('자전거 세그먼트 하나만 보면 예산 안에 들어도, 두 구간 합계가 예산을 넘으면 실제 공급자 호출을 한 번도 안 함', mock.calls.length === 0);
t('비용 원장에도 아무것도 기록되지 않음(자전거만 먼저 기록되는 절반짜리 상태 없음)', after === before);
t('안내 생성 자체는 200으로 응답함(정직한 추정/미지원으로 대체)', r.status === 200);
t('자전거 구간은 예산 초과로 real:false', r.json.guide.bikeLeg.real === false && r.json.guide.bikeLeg.reason === 'cost-budget-exceeded');
t('도보 구간도 예산 초과로 real:false지만 정직한 추정 숫자는 있음', r.json.guide.walkLeg.real === false && typeof r.json.guide.walkLeg.distanceMeters === 'number');
t('둘 다 실제 성공이 아니므로 무료체험 미차감', r.json.trialConsumed === false);

console.log(fail === 0 ? '\n전체 통과' : `\n${fail}개 실패`);
process.exit(fail === 0 ? 0 : 1);
