'use strict';
/**
 * 비용 예산이 여러 번의 연결된 Routes 호출 중 일부만 감당할 수 있을 때,
 * 절반은 실제 경로·절반은 추정으로 뒤섞이지 않고 전부 추정으로
 * 정직하게 대체되는지 확인한다(2026-09-10 재검토 4차 — "동시 요청 시
 * 예상 비용을 먼저 예약해 한도 초과를 방지"의 all-or-nothing 설계).
 *
 * **2026-09-10 재검토(5차) — ChatGPT가 재현한 버그의 회귀 테스트**:
 * 예전 버전(4차)은 세그먼트마다 `chargeCost`를 따로 불렀다 — 첫
 * 세그먼트 "혼자만" 보면 예산 안에 들어 통과·기록되고, 두 번째
 * 세그먼트에서 예산을 넘겨 전체 작업을 포기해도 **첫 세그먼트의 기록은
 * 원장에 그대로 남았다**(실제 외부 호출은 결국 0번인데 비용 1건이
 * 남는 모순 — ChatGPT가 "장소 40곳, highvolume 1원, 계정 일일예산
 * 1원"으로 직접 재현). 이번 테스트는 그 정확한 상황(첫 세그먼트는
 * 예산 안에 들지만 전체 합계는 예산을 넘는 상황)을 재현해, 수정된
 * `chargeCostBatch`(전체 합계를 하나의 트랜잭션으로 먼저 다 확인한
 * 뒤에만 전부 기록)가 **첫 세그먼트조차 기록하지 않는지** 확인한다.
 *
 * 실행: node server/test/cost-budget-allornothing.test.mjs
 *
 * config.mjs가 프로세스 시작 시 한 번만 계산되는 싱글턴이라(다른 여러
 * 테스트 파일과 같은 이유), "예산 부족"과 "예산 충분" 두 시나리오를
 * 한 프로세스 안에서 서로 다른 값으로 비교할 수 없다 — 그래서 이
 * 파일은 자기 자신을 --scenario= 인자로 다시 실행하는 부모/자식
 * 패턴을 쓴다(scripts/test-course-generation.mjs와 같은 패턴).
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scenarioArg = process.argv.find((a) => a.startsWith('--scenario='));
if (!scenarioArg) {
  // 부모 프로세스 — 두 자식을 순서대로 실행하고 결과를 합산한다.
  const here = fileURLToPath(import.meta.url);
  let fail = 0;
  for (const scenario of ['insufficient', 'sufficient']) {
    console.log(`\n=== 시나리오: ${scenario} ===`);
    const res = spawnSync(process.execPath, [here, `--scenario=${scenario}`], { stdio: 'inherit' });
    if (res.status !== 0) fail++;
  }
  console.log(fail ? `\n실패한 시나리오 ${fail}건` : '\n전체 시나리오 통과');
  process.exit(fail ? 1 : 0);
}
const scenario = scenarioArg.split('=')[1];

process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'development';
process.env.GOOGLE_ROUTES_API_KEY = 'fake-routes-key';
process.env.ROUTES_MAX_INTERMEDIATES_PER_CALL = '25';
process.env.ROUTES_HIGH_VOLUME_THRESHOLD = '11';
// 60곳(+출발지) → 세그먼트 3개(경유지 25/25/7 — 앞의 두 개가
// highvolume). highvolume 세그먼트 1건당 1원, 일반 세그먼트도 1원으로
// 맞춘다(둘 다 같은 값이어야 계산이 단순해진다).
process.env.COST_ROUTES_COMPUTE_KRW_MICROS = '1000000'; // 세그먼트(일반) 1건당 1원
process.env.COST_ROUTES_COMPUTE_HIGHVOLUME_KRW_MICROS = '1000000'; // 세그먼트(고요금) 1건당 1원 — 4차 버그는 이 값을 안 정해서 기본 추정치(14원)로 계산돼 "첫 세그먼트부터 거절"되는 상황만 됐었다
// 'insufficient': 세그먼트 1건(1원)은 넘지만 3건 합계(3원)는 못 넘는
// 값 — 첫 세그먼트만 보면 통과할 수 있는 상황을 일부러 만든다.
// 'sufficient': 3건 합계(3원)를 넉넉히 감당하는 값.
process.env.COST_PER_ACCOUNT_DAILY_KRW_MICROS = scenario === 'sufficient' ? '10000000' : '1500000';

const { computeWalkingRoute } = await import('../adapters/routing.mjs');
const { openDb } = await import('../db.mjs');
const { config } = await import('../config.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

t('사전 조건 — highvolume 세그먼트 단가가 1원으로 정확히 설정됨(4차 버그처럼 기본 추정치로 새지 않음)', config.costEstimate.routesComputeHighVolumeMicros === 1_000_000);

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
const places = Array.from({ length: 60 }, (_, i) => place('p' + i, i + 1)); // 3개 세그먼트(H/H/일반)가 필요한 규모

const before = openDb().prepare('SELECT COUNT(*) AS n FROM cost_ledger').get().n;
const mock = mockFetchCounting();
const r = await computeWalkingRoute(origin, places, 'acct-partial-budget');
mock.restore();
const after = openDb().prepare('SELECT COUNT(*) AS n FROM cost_ledger').get().n;

if (scenario === 'insufficient') {
  t('사전 조건 — 계정 일일 한도(1.5원)가 세그먼트 1건(1원)보다는 크다(첫 세그먼트만 보면 통과할 수 있는 상황을 일부러 만듦)', config.costBudget.perAccountDailyMicros > config.costEstimate.routesComputeHighVolumeMicros);
  t('첫 세그먼트만 보면 예산 안에 들어도, 전체 합계가 예산을 넘으면 실제 호출을 한 번도 안 함(all-or-nothing)', mock.calls.length === 0);
  t('비용 원장에도 첫 세그먼트조차 기록되지 않음(예전 버그: 여기서 1건이 남았었다)', after === before);
  t('결과는 정직하게 추정(routedReal=false)으로 대체됨', r.routedReal === false);
  t('실패 사유가 예산 초과로 명시됨', r.fallbackReason === 'cost-budget-exceeded');
  t('추정이어도 방문 순서·구간 자체는 만들어짐(60곳 전부)', r.legs.length === 60);
} else {
  // 'sufficient' — 예산이 3개 세그먼트 합계(3원)를 넉넉히 감당하면
  // 실제로 3번 다 호출되고, 원장에도 정확히 3건이 기록돼야 한다.
  t('예산이 충분하면 세그먼트 수만큼 실제 호출이 나감(3번)', mock.calls.length === 3);
  t('비용 원장에도 정확히 3건이 기록됨', after - before === 3);
  t('결과는 실제 경로로 인정됨(routedReal=true)', r.routedReal === true);
  t('구간 수가 정거장 수(60)와 일치', r.legs.length === 60);
}

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
