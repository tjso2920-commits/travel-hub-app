'use strict';
/**
 * 실제 도보 경로 계산 — Google Routes API(WALK 모드)로 서버에서 계산한다.
 *
 * **중요한 한계 고지**: 이 세션은 `developers.google.com` 접속이 막혀
 * (EGRESS_BLOCKED) 공식 문서를 다시 대조하지 못했다(2026-09-10 재검토
 * 4차에서도 재시도했지만 여전히 막힘). 아래 엔드포인트·필드명은 학습된
 * 지식 기준이며, 실제 키를 넣기 전 반드시 최신 공식 문서와 대조해야
 * 한다.
 *
 * 2026-09-10 재검토(3차) 지시 그대로 반영한 설계 결정:
 * 1. **"API 한 번으로 모든 최적화가 된다고 가정하지 않는다."** 방문
 *    순서는 우리가 직접 좌표 기반 최근접 이웃(nearest-neighbor)
 *    휴리스틱으로 정한다(API 호출 0회, 순수 로컬 계산). **이건 전역
 *    최단 경로를 보장하지 않는다** — 화면에도 "가장 짧은 순서"라고
 *    말하지 않고 "방문 순서" 정도로만 표현해야 한다(과장 금지).
 * 2. 실패(네트워크 오류, 4xx/5xx, 응답에 legs 없음)하면 직선거리
 *    추정으로 정직하게 대체한다(routedReal=false) — 성공한 척 하지
 *    않는다.
 *
 * **2026-09-10 재검토(4차) — 실제로 재현된 치명적 버그를 고침**: 예전
 * 버전은 `config.services.routing !== 'real'`이면 무조건 `simulateTestRoute`
 * (가짜 성공을 만들 수 있는 테스트 시뮬레이터)로 빠졌다. 이 조건은
 * `services.routing`이 `'test'`일 때뿐 아니라 **운영(production)에서
 * 키가 없어 `'unavailable'`일 때도 참이 된다** — 즉 운영에서 경로 API
 * 키를 안 넣으면 시뮬레이터가 `routedReal:true`인 가짜 실제 경로를
 * 만들어낼 수 있었다(ChatGPT가 `APP_ENV=production` + 키 없음 상태에서
 * 실제로 재현: origin/synthetic 좌표로 routedReal=true를 받아냄). 이제는
 * `services.routing`의 세 값(`'real'`/`'test'`/`'unavailable'`)을 전부
 * 명시적으로 분기한다 — `'test'`가 아니면 시뮬레이터 함수 자체를 절대
 * 호출하지 않는다.
 *
 * **4차 추가 — 경유지 상한과 비용 통제**: Google Routes는 중간 경유지가
 * 최대 `routesMaxIntermediatesPerCall`개(ChatGPT 확인 기준 25개)이고,
 * `routesHighVolumeThreshold`개(11개) 이상이면 더 비싼 요금 구간이라고
 * 한다. 임의 개수를 한 요청에 다 넣지 않고, 넘치면 여러 번의 연결된
 * 호출로 나눈다(구간 경계를 공유해 실제 이동 구간이 끊기지 않게 한다).
 * 실제 호출을 보내기로 결정하는 매 순간 cost-ledger에 예상 비용을
 * 확정 기록한다(예산을 넘으면 아예 호출하지 않고 정직한 추정으로
 * 대체한다 — 무료체험을 쓰지 않는다는 course-generation.mjs의 판단
 * 근거가 되는 routedReal=false가 자연히 적용된다).
 */
import { config } from '../config.mjs';
import { markVerified } from '../status.mjs';
import { fetchWithTimeout } from '../net.mjs';
import { chargeCostBatch } from '../cost-ledger.mjs';
import { currentPeriod } from '../entitlement-usage.mjs';
import { splitIntoSegments, skuForSegment } from '../route-segments.mjs';

const WALK_MIN_PLAUSIBLE_MPS = 0.3;
const WALK_MAX_PLAUSIBLE_MPS = 2.2;

function haversineMeters(a, b) {
  const r = Math.PI / 180;
  const a1 = a.lat * r, a2 = b.lat * r, da = (b.lat - a.lat) * r, dl = (b.lng - a.lng) * r;
  const z = Math.sin(da / 2) ** 2 + Math.cos(a1) * Math.cos(a2) * Math.sin(dl / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(z), Math.sqrt(1 - z));
}

/* 최근접 이웃 휴리스틱 — 출발지에서 가장 가까운 곳부터 차례로 골라
   순서를 정한다. 정거장이 많지 않은(여행 코스 특성상 보통 한 자리
   숫자~십수 개) 상황을 가정한 단순 구현이다. 전역 최적해가 아니라는
   점을 호출부(course-generation.mjs)가 화면 문구에도 반영해야 한다. */
export function orderByNearestNeighbor(origin, places) {
  const remaining = places.slice();
  const ordered = [];
  let current = origin;
  while (remaining.length) {
    let bestIdx = 0, bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversineMeters(current, remaining[i]);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    const next = remaining.splice(bestIdx, 1)[0];
    ordered.push(next);
    current = next;
  }
  return ordered;
}

function estimateLegs(origin, ordered) {
  const points = [origin, ...ordered];
  const legs = [];
  for (let i = 0; i < points.length - 1; i++) {
    const meters = haversineMeters(points[i], points[i + 1]);
    legs.push({ distanceMeters: meters, seconds: meters / 1.2 }); // 평균 도보 속도 가정(추정 표기)
  }
  return legs;
}

/* 테스트/개발 전용 시뮬레이션 — 실제 Google Routes에 연결하지 않고도
   "실제 경로 성공"과 "실패→추정 대체" 두 코드 경로를 서버 테스트에서
   결정론적으로 재현하기 위한 것이다(장소조회 테스트 어댑터와 같은
   목적). `config.routingTestForce`로 명시적으로 고르거나, 안 정하면
   좌표 해시로 결정론적으로 나눈다. 아래 computeWalkingRoute는
   `services.routing === 'test'`일 때만 이 함수를 부른다 — 그 외
   ('real'/'unavailable')에서는 절대 호출되지 않는다. */
function simulateTestRoute(origin, ordered) {
  const legs = estimateLegs(origin, ordered);
  let simulateSuccess;
  if (config.routingTestForce === 'success') simulateSuccess = true;
  else if (config.routingTestForce === 'failure') simulateSuccess = false;
  else {
    let hash = 0;
    [origin, ...ordered].forEach((p) => { hash = (hash * 31 + Math.round((p.lat + p.lng) * 10000)) | 0; });
    simulateSuccess = Math.abs(hash) % 5 !== 0;
  }
  if (!simulateSuccess) return { routedReal: false, legs, fallbackReason: 'test-adapter-simulated-failure' };
  const walkLegs = legs.map((l) => ({ distanceMeters: l.distanceMeters, seconds: l.distanceMeters / 1.2 }));
  return { routedReal: true, legs: walkLegs };
}

/* points를 "한 번의 computeRoutes 호출로 처리 가능한 조각"들로 나눈다
   (server/route-segments.mjs로 옮김 — 2026-09-11 재검토 12차: "실제
   경로 실행과 AI 분류 예산 예약이 같은 비용 계산 함수를 쓰게 하라"는
   지시대로, entitlement-usage.mjs의 예약 계산도 이 정확히 같은 함수를
   그대로 재사용한다. 순환 참조 방지를 위해 이 어댑터 밖에 둔 것일 뿐,
   알고리즘은 예전과 완전히 동일하다). */

/* 실제 Google Routes 호출 — 세그먼트(이미 정해진 순서의 연속 구간)
   하나를 한 번의 computeRoutes 요청으로 처리한다. WALK 모드 응답이
   말이 안 되게 빠르면(자동차 프로필 오응답 의심 등) 이 세그먼트 전체를
   실제 경로로 인정하지 않는다. */
async function callGoogleRoutesSegment(segmentPoints) {
  const waypoints = segmentPoints.map((p) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } }));
  const body = {
    origin: waypoints[0],
    destination: waypoints[waypoints.length - 1],
    intermediates: waypoints.slice(1, -1),
    travelMode: 'WALK',
    optimizeWaypointOrder: false,
  };
  const res = await fetchWithTimeout(`${config.google.routesApiBase}/directions/v2:computeRoutes`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': config.google.routesKey,
      'X-Goog-FieldMask': 'routes.legs.distanceMeters,routes.legs.duration',
    },
    body: JSON.stringify(body),
  }, config.externalRequestTimeoutMs);
  if (!res.ok) return { ok: false, reason: 'http-error', status: res.status };
  const json = await res.json();
  const route = json.routes && json.routes[0];
  const legs = route && route.legs;
  const expectedLegCount = segmentPoints.length - 1;
  if (!legs || legs.length !== expectedLegCount) return { ok: false, reason: 'unexpected-legs-shape' };
  return { ok: true, legs };
}

function parseDurationSeconds(v) {
  if (typeof v === 'number') return v;
  const m = String(v || '').match(/^(\d+(?:\.\d+)?)s$/);
  return m ? Number(m[1]) : NaN;
}

function legsAreWalkPlausible(legs) {
  return legs.every((l) => {
    const seconds = parseDurationSeconds(l.duration);
    if (!seconds || seconds <= 0) return false;
    const mps = l.distanceMeters / seconds;
    return mps >= WALK_MIN_PLAUSIBLE_MPS && mps <= WALK_MAX_PLAUSIBLE_MPS;
  });
}

function estimateFallback(origin, ordered, fallbackReason) {
  return { ok: true, routedReal: false, ordered, legs: estimateLegs(origin, ordered).map((l) => ({ distanceMeters: l.distanceMeters, seconds: l.seconds })), fallbackReason };
}

/* 실제 호출 전체(세그먼트별로 나뉜 여러 번의 computeRoutes)를 순서대로
   실행한다. 실행하기 전에 "이 코스에 필요한 실제 호출 수·SKU"를 전부
   미리 계산해 예산을 확인한다 — 중간에 예산이 바닥나 일부 구간은 실제
   경로, 일부는 추정으로 섞이면 routedReal 하나로 "체험을 차감해도
   되는가"를 판단하는 이 시스템 전체의 전제가 깨진다(2026-09-10 재검토
   4차: "동시 요청 시 예상 비용을 먼저 예약해 한도 초과를 방지"). 그래서
   전부 아니면 전무(all-or-nothing)로 처리한다 — 예산이 하나라도
   모자라면 전체를 정직한 추정으로 대체하고 실제 호출은 한 번도 하지
   않는다. */
async function callGoogleRoutesAll(origin, ordered, accountId) {
  const points = [origin, ...ordered];
  const segments = splitIntoSegments(points);

  // 2026-09-10 재검토(5차) — ChatGPT가 재현한 버그 수정: 세그먼트마다
  // chargeCost를 따로 부르면, 앞쪽 세그먼트가 예산을 통과해 먼저
  // 기록된 뒤 뒤쪽 세그먼트에서 예산이 모자라 전체 작업을 포기해도
  // 앞쪽 기록은 원장에 그대로 남았다(실제 호출은 0번 나갔는데 비용은
  // 남는 모순 — 40곳/고요금1원/계정한도1원으로 재현됨). 이제 전체
  // 세그먼트 계획을 먼저 다 세운 뒤 `chargeCostBatch` 한 번으로
  // "전부 확인 → 전부 기록"을 하나의 DB 트랜잭션으로 처리한다 —
  // 하나라도 예산을 넘으면 그 무엇도 기록되지 않는다.
  const plan = segments.map((seg) => ({ sku: skuForSegment(seg) }));
  // 2026-09-10 재검토(6차) — 이 비용도 이 계정의 지금 이용권 기간에
  // 귀속시켜 내부 원가 안전상한(무료 누적 700원/유료 이용권당 누적
  // 3,500원)을 함께 확인한다(places.mjs의 장소 조회 비용과 같은 원칙).
  const period = accountId ? currentPeriod(accountId) : null;
  const charge = chargeCostBatch({ accountId, service: 'routes', charges: plan, periodId: period && period.periodId, periodCapMicros: period && period.costCapMicros });
  if (!charge.ok) return { ok: false, reason: 'cost-budget-exceeded', detail: charge.reason };
  // 예산 확인을 전부 통과했으니 이제 실제로 순서대로 호출한다. 이 시점
  // 이후의 실패(네트워크 오류·타임아웃 등)는 "돈은 이미 쓰기로 확정
  // 기록됐지만 결과를 못 받은" 상황이다 — cost-ledger.mjs 설계 참고.
  const allLegs = [];
  for (const seg of segments) {
    let result;
    try {
      result = await callGoogleRoutesSegment(seg);
    } catch (e) {
      return { ok: false, reason: 'network-error' };
    }
    if (!result.ok) return { ok: false, reason: result.reason };
    if (!legsAreWalkPlausible(result.legs)) return { ok: false, reason: 'implausible-speed' };
    allLegs.push(...result.legs.map((l) => ({ distanceMeters: l.distanceMeters, seconds: parseDurationSeconds(l.duration) })));
  }
  return { ok: true, legs: allLegs };
}

/* 공개 진입점 — origin + 순서 미정 장소 목록을 받아 (1) 순서를 정하고
   (2) 실제 경로 또는 추정을 반환한다. accountId는 비용 원장 기록용
   (로그인 없이는 이 함수까지 도달할 수 없으므로 항상 있어야 정상). */
export async function computeWalkingRoute(origin, places, accountId) {
  const ordered = orderByNearestNeighbor(origin, places);

  if (config.services.routing === 'test') {
    const sim = simulateTestRoute(origin, ordered);
    return { ok: true, routedReal: sim.routedReal, ordered, legs: sim.legs, fallbackReason: sim.fallbackReason };
  }
  if (config.services.routing !== 'real') {
    // 'unavailable' — 운영인데 키가 없다. 절대 시뮬레이터로 안 빠지고
    // 정직한 추정으로만 대체한다(이번에 고친 핵심 버그).
    return estimateFallback(origin, ordered, 'routing-service-unavailable');
  }

  const result = await callGoogleRoutesAll(origin, ordered, accountId);
  if (!result.ok) return estimateFallback(origin, ordered, result.reason);
  markVerified('routing');
  return { ok: true, routedReal: true, ordered, legs: result.legs };
}
