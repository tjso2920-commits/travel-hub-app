'use strict';
/**
 * 실제 코스 생성(로드맵 ⑥) — "오늘 동선"에 담은 곳을 실제 방문 순서·
 * 이동시간으로 바꾼다.
 *
 * 2026-09-09 코드 검토: "직선거리 정렬을 실제 최단 동선으로 표시하지
 * 마세요. 도보 우선 실제 경로부터 완성하고, 다른 수단은 연결된 범위만
 * 제공하세요." — 도보는 실제 라우팅(OSRM 공개 서버, API 키·계정 불필요,
 * router.project-osrm.org)으로 먼저 계산한다. 그 서버에 닿지 않으면(네트워크
 * 문제·요청 폭주 등) 직선거리+보정계수 추정으로 넘어가되, 화면에
 * "직선거리 기준 추정(실제 경로 연결 실패)"라고 정직하게 다르게 표시한다 —
 * 실패를 성공인 것처럼 보여주지 않는다.
 *
 * 좌표 없는 장소는 조용히 빼지 않는다 — courseGenerate가 항상 excluded
 * 목록과 이유를 같이 돌려준다.
 *
 * OSRM 공개 데모 서버는 평가·소규모 용도로 운영진이 공개한 무료 서비스다
 * (계정·키 없음). 이 앱의 실제 트래픽 규모에서 계속 문제없이 동작할지는
 * 실사용으로 확인해야 한다 — 트래픽이 늘면 자체 라우팅 서버(같은 OSRM을
 * 직접 운영)로 옮기는 걸 출시 전 계획에 넣어야 한다(비용 발생 항목,
 * 최종 보고서 참고).
 */
function courseGpsDistance(a, b) {
  const r = Math.PI / 180, a1 = a.lat * r, a2 = b.lat * r, da = (b.lat - a.lat) * r, dl = (b.lng - a.lng) * r;
  const z = Math.sin(da / 2) ** 2 + Math.cos(a1) * Math.cos(a2) * Math.sin(dl / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(z), Math.sqrt(1 - z));
}
const OSRM_FOOT_URL = 'https://router.project-osrm.org/trip/v1/foot/';
const COURSE_DEFAULT_DWELL_MIN = 40;

/* 실제 경로 연결이 안 될 때만 쓰는 대체 순서(가까운 곳부터) — 이름순·
   원래 담은 순서 그대로 두지 않는다. 그래도 "실제 최단 동선"이라고
   부르지 않는다 — 아래 courseStraightLineEstimate가 표시용 라벨을
   따로 만든다. */
function courseNearestNeighborOrder(origin, points) {
  const remaining = points.slice();
  const order = [];
  let cur = origin;
  while (remaining.length) {
    let bestIdx = 0, bestDist = Infinity;
    remaining.forEach((p, i) => {
      const d = courseGpsDistance(cur, p);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    });
    order.push(remaining.splice(bestIdx, 1)[0]);
    cur = order[order.length - 1];
  }
  return order;
}
function courseStraightLineEstimate(origin, ordered) {
  const legs = [];
  let prev = origin;
  ordered.forEach((p) => {
    const meters = courseGpsDistance(prev, p) * 1.3; // 실제 길은 직선이 아니다 — 통상 보정 계수
    const seconds = ((meters / 1000) / 4.5) * 3600; // 도보 시속 4.5km 가정
    legs.push({ meters, seconds });
    prev = p;
  });
  return { legs, totalMeters: legs.reduce((s, l) => s + l.meters, 0), totalSeconds: legs.reduce((s, l) => s + l.seconds, 0) };
}
/* OSRM /trip/ — 여러 지점의 실제 도보 방문 순서 최적화 + 구간별 실제
   거리·소요시간을 한 번에 받는다. source=first로 출발지를 고정한다. */
async function courseRealRoute(origin, points, timeoutMs) {
  if (typeof fetch !== 'function') return null;
  const coords = [origin].concat(points).map((p) => p.lng + ',' + p.lat).join(';');
  const url = OSRM_FOOT_URL + coords + '?source=first&roundtrip=false&overview=false';
  let ctrl = null, timer = null;
  try {
    ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    if (ctrl) timer = setTimeout(() => ctrl.abort(), timeoutMs || 8000);
    const res = await fetch(url, ctrl ? { signal: ctrl.signal } : {});
    if (timer) clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.code !== 'Ok' || !data.trips || !data.trips[0] || !Array.isArray(data.waypoints)) return null;
    const trip = data.trips[0];
    const withIdx = points.map((p, i) => ({ p, idx: data.waypoints[i + 1] && data.waypoints[i + 1].waypoint_index }));
    if (withIdx.some((x) => typeof x.idx !== 'number')) return null;
    withIdx.sort((a, b) => a.idx - b.idx);
    const ordered = withIdx.map((x) => x.p);
    const legs = (trip.legs || []).map((l) => ({ meters: l.distance, seconds: l.duration }));
    if (legs.length !== ordered.length) return null;
    return { ordered, legs, totalMeters: trip.distance, totalSeconds: trip.duration };
  } catch (e) {
    if (timer) clearTimeout(timer);
    return null;
  }
}
/* 코스 생성 본체. origin={lat,lng}, points=spots 배열(선택한 곳들).
   좌표 없는 곳은 excluded로 분리해 절대 조용히 빼지 않는다. */
async function courseGenerate(origin, points, opts) {
  opts = opts || {};
  const withCoords = points.filter((p) => A.hasCoords(p));
  const withoutCoords = points.filter((p) => !A.hasCoords(p));
  if (!withCoords.length) return { ok: false, reason: 'no-coords', excluded: withoutCoords };
  let real = null;
  try { real = await courseRealRoute(origin, withCoords, opts.timeoutMs); } catch (e) { real = null; }
  let ordered, legs, totalMeters, totalSeconds, routedReal;
  if (real) {
    ordered = real.ordered; legs = real.legs; totalMeters = real.totalMeters; totalSeconds = real.totalSeconds; routedReal = true;
  } else {
    ordered = courseNearestNeighborOrder(origin, withCoords);
    const est = courseStraightLineEstimate(origin, ordered);
    legs = est.legs; totalMeters = est.totalMeters; totalSeconds = est.totalSeconds; routedReal = false;
  }
  const dwellMin = opts.dwellMin || COURSE_DEFAULT_DWELL_MIN;
  let clock = opts.startMinutes || 9 * 60;
  const stops = ordered.map((p, i) => {
    const walkMin = Math.max(1, Math.round(legs[i].seconds / 60));
    clock += walkMin;
    const stop = { id: p.id, name: p.name, walk: walkMin, at: clock, dwell: dwellMin };
    clock += dwellMin;
    return stop;
  });
  return {
    ok: true,
    routedReal,
    stops,
    excluded: withoutCoords,
    totalMeters, totalSeconds,
    walkTotal: stops.reduce((s, x) => s + x.walk, 0),
    endAt: clock,
  };
}
/* 도보만 "실제 경로"를 완성한다. 대중교통·자전거·택시는 이번 단계에서
   자체 계산을 안 하고, 실제로 동작하는 구글 지도 길찾기로 바로 넘긴다
   (연결된 범위만 제공 — 자체 추정을 만들어 내지 않는다는 뜻). */
function courseDirectionsLink(from, to, mode) {
  const modeParam = { walking: 'walking', transit: 'transit', driving: 'driving', bicycling: 'bicycling' }[mode] || 'walking';
  const origin = from.lat + ',' + from.lng;
  const dest = to.lat + ',' + to.lng;
  return 'https://www.google.com/maps/dir/?api=1&origin=' + encodeURIComponent(origin) + '&destination=' + encodeURIComponent(dest) + '&travelmode=' + modeParam;
}
function courseClockLabel(mins) {
  mins = ((mins % 1440) + 1440) % 1440;
  const h = Math.floor(mins / 60), m = mins % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

window.CourseGen = {
  generate: courseGenerate,
  gpsDistance: courseGpsDistance,
  directionsLink: courseDirectionsLink,
  clockLabel: courseClockLabel,
  DEFAULT_DWELL_MIN: COURSE_DEFAULT_DWELL_MIN,
};
