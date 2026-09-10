'use strict';
/**
 * 실제 도보 경로 계산 — Google Routes API(WALK 모드)로 서버에서 계산한다.
 *
 * **중요한 한계 고지**: 이 세션은 `developers.google.com` 접속이 막혀
 * (EGRESS_BLOCKED) 공식 문서를 다시 대조하지 못했다. 아래 엔드포인트·
 * 필드명은 학습된 지식 기준이며, 실제 키를 넣기 전 반드시 최신 공식
 * 문서와 대조해야 한다.
 *
 * 2026-09-10 재검토(3차) 지시 그대로 반영한 설계 결정:
 * 1. **"API 한 번으로 모든 최적화가 된다고 가정하지 않는다."** 방문
 *    순서 최적화(`optimizeWaypointOrder`)가 도보(WALK) 모드에서도
 *    문서대로 동작하는지, 어떤 요금제(Basics/Advanced 등)에 속하는지
 *    이 세션에서 확인하지 못했다 — 그래서 아예 그 옵션을 쓰지 않는다.
 *    방문 순서는 **우리가 직접** 좌표 기반 최근접 이웃(nearest-neighbor)
 *    휴리스틱으로 정한다(API 호출 0회, 순수 로컬 계산). **이건 전역
 *    최단 경로를 보장하지 않는다** — 화면에도 "가장 짧은 순서"라고
 *    말하지 않고 "방문 순서" 정도로만 표현해야 한다(과장 금지).
 * 2. **"실제 호출 수·행렬 요소 수를 비용에 반영한다."** 순서가 이미
 *    정해져 있으므로, 그 순서 그대로 `computeRoutes`를 **딱 한 번만**
 *    호출해 전체 구간(origin→p1→p2→…→pN)의 실제 도보 거리·시간을
 *    한�위에 받는다. 정거장 수가 N개면 이동 구간은 N개이고, 필요한
 *    API 호출은 항상 1회다(행렬 API처럼 N×M칸을 다 계산해서 비싸지는
 *    구조를 피했다).
 * 3. 실패(네트워크 오류, 4xx/5xx, 응답에 legs 없음)하면 예전과 동일하게
 *    직선거리 추정으로 정직하게 대체한다(routedReal=false) — 성공한
 *    척 하지 않는다.
 */
import { config } from '../config.mjs';
import { markVerified } from '../status.mjs';

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
   좌표 해시로 결정론적으로 나눈다. **production에서는 services.routing
   이 'real' 아니면 'unavailable'뿐이라 이 함수 자체가 절대 호출되지
   않는다** — computeWalkingRoute의 분기 참고. */
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
  // "성공"을 흉내 낼 때도 실제 좌표 기반 거리(haversine)를 쓰되, 도보
  // 타당 속도로만 시간을 재계산한다 — 이 값 자체가 실제 상용 라우팅
  // API 응답은 아니다(테스트/개발 전용 시뮬레이션이라는 걸 respondsWith
  // 쪽 fallbackReason 대신 routedReal=true로 그대로 반영하는 이유는,
  // 이게 "실제 성공"과 똑같은 형태의 값으로 뒤 단계 로직을 검증해야
  // 하기 때문이다 — 실 서비스 판정은 항상 config.services.routing이
  // 하지 이 값이 하지 않는다).
  const walkLegs = legs.map((l) => ({ distanceMeters: l.distanceMeters, seconds: l.distanceMeters / 1.2 }));
  return { routedReal: true, legs: walkLegs };
}

/* 실제 Google Routes 호출 — 이미 정해진 순서(ordered) 그대로 origin→
   p1→…→pN 전체 구간을 한 번에 요청한다. WALK 모드 응답이 말이 안 되게
   빠르면(자동차 프로필 오응답 의심 등) 실제 경로로 인정하지 않는다 —
   이 방어는 공개 OSRM 시절부터 있던 것과 같은 이유지만, 이제 검증
   대상은 상용 API 응답이라 발생 가능성은 낮다. 그래도 "도보 API URL을
   불렀다"는 사실 자체를 도보 검증으로 삼지 말라는 지시에 따라 속도
   타당성 검사는 유지한다(다만 이건 보조 방어일 뿐, 실제 성공 여부의
   핵심 근거는 이제 Google 자체가 WALK 모드로 계산했다는 것이다). */
async function callGoogleRoutes(origin, ordered) {
  const waypoints = [origin, ...ordered].map((p) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } }));
  const body = {
    origin: waypoints[0],
    destination: waypoints[waypoints.length - 1],
    intermediates: waypoints.slice(1, -1),
    travelMode: 'WALK',
    optimizeWaypointOrder: false,
  };
  const res = await fetch(`${config.google.routesApiBase}/directions/v2:computeRoutes`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': config.google.routesKey,
      'X-Goog-FieldMask': 'routes.legs.distanceMeters,routes.legs.duration',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { ok: false, reason: 'http-error', status: res.status };
  const json = await res.json();
  const route = json.routes && json.routes[0];
  const legs = route && route.legs;
  // 지점이 origin+ordered(N개)면 구간(leg)은 항상 N개(origin→p1,
  // p1→p2, …, p(N-1)→pN)다 — 응답 모양이 이거랑 다르면 신뢰하지 않는다.
  const expectedLegCount = ordered.length;
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

/* 공개 진입점 — origin + 순서 미정 장소 목록을 받아 (1) 순서를 정하고
   (2) 실제 경로 또는 추정을 반환한다. 반환 형식은 예전 클라이언트
   course.js의 결과와 최대한 비슷하게 맞춰 호출부 변경을 최소화했다. */
export async function computeWalkingRoute(origin, places) {
  const ordered = orderByNearestNeighbor(origin, places);
  if (config.services.routing !== 'real') {
    const sim = simulateTestRoute(origin, ordered);
    return { ok: true, routedReal: sim.routedReal, ordered, legs: sim.legs, fallbackReason: sim.fallbackReason };
  }
  try {
    const result = await callGoogleRoutes(origin, ordered);
    if (!result.ok) {
      return { ok: true, routedReal: false, ordered, legs: estimateLegs(origin, ordered).map((l) => ({ distanceMeters: l.distanceMeters, seconds: l.seconds })), fallbackReason: result.reason };
    }
    const legsSeconds = result.legs.map((l) => ({ distanceMeters: l.distanceMeters, seconds: parseDurationSeconds(l.duration) }));
    if (!legsAreWalkPlausible(result.legs)) {
      return { ok: true, routedReal: false, ordered, legs: estimateLegs(origin, ordered).map((l) => ({ distanceMeters: l.distanceMeters, seconds: l.seconds })), fallbackReason: 'implausible-speed' };
    }
    markVerified('routing');
    return { ok: true, routedReal: true, ordered, legs: legsSeconds };
  } catch (e) {
    return { ok: true, routedReal: false, ordered, legs: estimateLegs(origin, ordered).map((l) => ({ distanceMeters: l.distanceMeters, seconds: l.seconds })), fallbackReason: 'network-error' };
  }
}
