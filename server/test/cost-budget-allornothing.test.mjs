'use strict';
/**
 * 비용 예산이 여러 번의 연결된 Routes 호출 중 일부만 감당할 수 있을 때,
 * 절반은 실제 경로·절반은 추정으로 뒤섞이지 않고 전부 추정으로
 * 정직하게 대체되는지 확인한다(2026-09-10 재검토 4차 — "동시 요청 시
 * 예상 비용을 먼저 예약해 한도 초과를 방지"의 all-or-nothing 설계).
 * 예산이 충분하면 실제 호출이 나가고, 부족하면 실제 호출을 한 번도
 * 하지 않는다.
 *
 * 실행: node server/test/cost-budget-allornothing.test.mjs
 */
process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'development';
process.env.GOOGLE_ROUTES_API_KEY = 'fake-routes-key';
process.env.ROUTES_MAX_INTERMEDIATES_PER_CALL = '25';
process.env.COST_ROUTES_COMPUTE_KRW_MICROS = '1000000'; // 세그먼트 1건당 1원
// 계정당 하루 한도를 "세그먼트 1건 값"으로 정확히 맞춘다 — 이 코스는
// 실제로 2번의 연결된 호출이 필요하므로(아래 60곳), 예산은 1건만 감당
// 가능해 "일부만 실제, 나머지 추정"으로 뒤섞일 뻔한 상황을 만든다.
process.env.COST_PER_ACCOUNT_DAILY_KRW_MICROS = '1000000';

const { computeWalkingRoute } = await import('../adapters/routing.mjs');
const { openDb } = await import('../db.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

function mockFetchCounting() {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    const legCount = 1 + (body.intermediates ? body.intermediates.length : 0);
    const legs = Array.from({ length: legCount }, () => ({ distanceMeters: 100, duration: '80s' }));
    return { ok: true, status: 200, json: async () => ({ routes: [{ legs }] }) };
  };
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}
function place(id, i) { return { id, lat: 33.5 + i * 0.001, lng: 130.4 + i * 0.001 }; }

const origin = { lat: 33.590, lng: 130.400 };
const places = Array.from({ length: 60 }, (_, i) => place('p' + i, i + 1)); // 2번의 연결된 호출이 필요한 규모

const before = openDb().prepare('SELECT COUNT(*) AS n FROM cost_ledger').get().n;
const mock = mockFetchCounting();
const r = await computeWalkingRoute(origin, places, 'acct-partial-budget');
mock.restore();
const after = openDb().prepare('SELECT COUNT(*) AS n FROM cost_ledger').get().n;

t('예산이 일부 세그먼트만 감당 가능하면 실제 호출을 한 번도 안 함(all-or-nothing)', mock.calls.length === 0);
t('비용 원장에도 아무것도 기록되지 않음(쓰지 않은 돈)', after === before);
t('결과는 정직하게 추정(routedReal=false)으로 대체됨', r.routedReal === false);
t('실패 사유가 예산 초과로 명시됨', r.fallbackReason === 'cost-budget-exceeded');
t('추정이어도 방문 순서·구간 자체는 만들어짐(60곳 전부)', r.legs.length === 60);

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
