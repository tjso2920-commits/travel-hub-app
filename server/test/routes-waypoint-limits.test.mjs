'use strict';
/**
 * Google Routes 중간 경유지 상한 검증(2026-09-10 재검토 4차 7절) —
 * "중간 경유지 최대 25개, 11개 이상이면 더 비싼 요금 구간"이라는
 * ChatGPT 확인 사항을 실제로 코드가 지키는지 확인한다. 25개를 넘는
 * 코스는 여러 번의 연결된 호출로 나뉘어야 하고, 연결 구간이 끊기지
 * 않아야 하며, 실제 호출 수가 계산과 맞아야 한다.
 *
 * 실행: node server/test/routes-waypoint-limits.test.mjs
 */
process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'development';
process.env.GOOGLE_ROUTES_API_KEY = 'fake-routes-key';
process.env.ROUTES_MAX_INTERMEDIATES_PER_CALL = '25';
process.env.ROUTES_HIGH_VOLUME_THRESHOLD = '11';

const { config } = await import('../config.mjs');
const { computeWalkingRoute } = await import('../adapters/routing.mjs');
const { openDb } = await import('../db.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

t('사전 조건 — routing real 모드', config.services.routing === 'real');

function mockFetchCounting() {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    const legCount = 1 + (body.intermediates ? body.intermediates.length : 0);
    const legs = Array.from({ length: legCount }, () => ({ distanceMeters: 100, duration: '80s' })); // 1.25 m/s — 도보 타당 범위
    return { ok: true, status: 200, json: async () => ({ routes: [{ legs }] }) };
  };
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

function place(id, i) { return { id, lat: 33.5 + i * 0.001, lng: 130.4 + i * 0.001 }; }

// --- 25개 이하(경유지 24개, 총 26지점 이하)면 한 번의 호출로 처리된다 ---
{
  const origin = { lat: 33.590, lng: 130.400 };
  const places = Array.from({ length: 20 }, (_, i) => place('p' + i, i + 1)); // 경유지 19개 + 도착지 1개
  const mock = mockFetchCounting();
  const r = await computeWalkingRoute(origin, places, 'acct-small');
  mock.restore();
  t('경유지 25개 이하는 실제 호출이 딱 1번만 나감', mock.calls.length === 1);
  t('요청 하나의 intermediates 개수가 실제 경유지 수(19)와 일치', mock.calls[0].body.intermediates.length === 19);
  t('구간 수가 정거장 수와 일치(20)', r.legs.length === 20);
  t('실제 경로로 인정됨', r.routedReal === true);
}

// --- 25개를 넘으면(예: 40곳) 여러 번의 연결된 호출로 나뉜다 ---
{
  const origin = { lat: 33.590, lng: 130.400 };
  const places = Array.from({ length: 40 }, (_, i) => place('q' + i, i + 1));
  const mock = mockFetchCounting();
  const r = await computeWalkingRoute(origin, places, 'acct-large');
  mock.restore();
  // 총 지점 수 = 41(origin+40). 세그먼트당 최대 27지점(경유지 25+양끝 2).
  // 41 → [0..26](27지점) + [26..40](15지점) = 2번의 호출.
  t('경유지 상한을 넘으면 여러 번의 연결된 호출로 나뉨(2번)', mock.calls.length === 2);
  const totalLegsRequested = mock.calls.reduce((s, c) => s + 1 + c.body.intermediates.length, 0);
  t('나뉜 호출들의 구간 수를 합치면 실제 필요한 구간 수(40)와 정확히 일치(연결 구간 보존, 이중 계산 없음)', totalLegsRequested === 40);
  t('최종 결과의 구간 수도 정거장 수(40)와 일치', r.legs.length === 40);
  t('나뉘어도 결과 하나로 합쳐져 실제 경로로 인정됨', r.routedReal === true);

  // 두 번째 호출의 origin이 첫 번째 호출의 destination과 같아야
  // 실제 이동 구간이 끊기지 않는다.
  const firstDest = mock.calls[0].body.destination.location.latLng;
  const secondOrigin = mock.calls[1].body.origin.location.latLng;
  t('세그먼트 경계가 이어짐(첫 호출의 도착지 = 두 번째 호출의 출발지)', firstDest.latitude === secondOrigin.latitude && firstDest.longitude === secondOrigin.longitude);
}

// --- 11개 이상인 세그먼트는 고요금(highvolume) SKU로 비용이 기록된다 ---
{
  const origin = { lat: 33.590, lng: 130.400 };
  const places15 = Array.from({ length: 15 }, (_, i) => place('h' + i, i + 1)); // 경유지 14개(>=11) — highvolume
  const mock = mockFetchCounting();
  const before = openDb().prepare('SELECT COUNT(*) AS n FROM cost_ledger WHERE sku = ?').get('routes-compute-highvolume').n;
  await computeWalkingRoute(origin, places15, 'acct-highvolume');
  mock.restore();
  const after = openDb().prepare('SELECT COUNT(*) AS n FROM cost_ledger WHERE sku = ?').get('routes-compute-highvolume').n;
  t('경유지 11개 이상인 구간은 고요금(highvolume) SKU로 비용이 기록됨', after - before === 1);

  const places5 = Array.from({ length: 5 }, (_, i) => place('l' + i, i + 1)); // 경유지 4개(<11) — 일반 SKU
  const mock2 = mockFetchCounting();
  const beforeNormal = openDb().prepare('SELECT COUNT(*) AS n FROM cost_ledger WHERE sku = ?').get('routes-compute').n;
  await computeWalkingRoute(origin, places5, 'acct-normal');
  mock2.restore();
  const afterNormal = openDb().prepare('SELECT COUNT(*) AS n FROM cost_ledger WHERE sku = ?').get('routes-compute').n;
  t('경유지 11개 미만은 일반 SKU로 비용이 기록됨', afterNormal - beforeNormal === 1);
}

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
