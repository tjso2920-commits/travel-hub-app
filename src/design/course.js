'use strict';
/**
 * 실제 코스 생성(로드맵 ⑥) — "오늘 동선"에 담은 곳을 실제 방문 순서·
 * 이동시간으로 바꾼다.
 *
 * 2026-09-09 코드 검토(2차): 이전 버전은 OSRM Trip 서비스를
 * roundtrip=false&source=first로 부르면서 destination을 안 넘겼다(기본값
 * any). 그런데 OSRM 공식 문서(https://project-osrm.org/docs/v5.24.0/api/)
 * 기준으로 Trip 서비스가 실제로 지원하는 조합은 세 가지뿐이다:
 *   roundtrip=true,  source=any,   destination=any
 *   roundtrip=true,  source=first, destination=any
 *   roundtrip=false, source=first, destination=last
 * roundtrip=false + destination 생략(=any)은 이 목록에 없는, 지원이
 * 확인되지 않은 조합이었다 — 서버가 매번 어떻게 반응할지 보장이 없다.
 * "마지막에 고른 곳을 강제로 목적지로 고정"(destination=last)하는 것도
 * 하지 않는다 — 사용자가 실제로 그곳에서 끝내고 싶어한다는 근거가 없는데
 * 임의로 그렇게 확정해 버리면 안 된다(사용자 지시사항). 대신 공식적으로
 * 지원되는 roundtrip=true(=source에서 출발해 전부 들르고 source로 돌아오는
 * 순환 경로)로 요청하고, 응답에서 "돌아오는 마지막 구간"만 잘라내
 * 편도로 쓴다 — 방문 순서·구간별 실거리는 그대로 유효하고, 우리가 원하는
 * 건 애초에 순환 여부가 아니라 "방문 순서 + 구간 실거리"뿐이다.
 *
 * 도보 프로필 검증: URL 경로 문자열이 /foot/든 뭐든, 실제로 그 프로필로
 * 데이터가 빌드돼 있는지는 서버 쪽 사정이라 클라이언트에서 확신할 수
 * 없다(예: 공개 데모 서버가 설정을 바꾸거나, 프록시가 조용히 다른
 * 프로필로 응답하는 경우). 그래서 응답을 그대로 믿지 않고, 평균 이동
 * 속도가 사람이 걷는 범위를 벗어나면("도보"라기엔 너무 빠르면 자동차
 * 프로필로 잘못 응답했을 가능성이 크다) 실제 경로로 인정하지 않고
 * 직선거리 추정으로 넘어간다(courseSpeedPlausible).
 *
 * 이 파일은 mock 응답(Playwright page.route 가로채기)으로만 검증됐다 —
 * 이 개발 환경의 네트워크 정책이 router.project-osrm.org로 나가는 실제
 * 요청을 막고 있어(프록시 CONNECT 403 확인됨), 진짜 공개 서버에 실제로
 * 연결되는지는 이 환경에서 확인하지 못했다. "실제 도보 경로 완료"라고
 * 부르지 않는다 — 확인된 것은 "지원되는 파라미터 조합으로 요청을 만들고,
 * 그럴듯한 형태의 응답을 정확히 해석하며, 말이 안 되는 속도의 응답은
 * 걸러낸다"는 점까지다. 실제 서버 연결 자체는 이 앱이 실제로 배포된
 * 환경(네트워크 제한이 없는 곳)에서 별도로 확인해야 한다.
 *
 * 그 서버에 닿지 않거나 응답이 못 미더우면(네트워크 문제·요청 폭주·
 * 비정상 속도 등) 직선거리+보정계수 추정으로 넘어가되, 화면에 "직선거리
 * 기준 추정(실제 경로 연결 실패)"라고 정직하게 다르게 표시한다 — 실패를
 * 성공인 것처럼 보여주지 않는다.
 *
 * 좌표 없는 장소는 조용히 빼지 않는다 — courseGenerate가 항상 excluded
 * 목록과 이유를 같이 돌려준다. 가용 시간(budgetMinutes)을 넘겨 받으면
 * 그 시간 안에 못 들르는 곳도 "시간 안에 안 들어감"이라는 별도 이유로
 * excluded에 넣는다(좌표가 없어서 빠진 것과 구분).
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
/* 사람 도보로 말이 되는 평균 속도 범위(m/s). 위쪽은 상당히 빠른 걸음
   (약 7.9km/h)까지 여유를 주되, 자동차 프로필로 잘못 응답한 경우(보통
   시속 수십km) 는 확실히 걸러낸다. 구간이 아주 짧으면(정지·GPS 오차
   수준) 속도 계산이 튀므로 그런 구간은 판단에서 뺀다. */
const COURSE_MIN_PLAUSIBLE_MPS = 0.3;
const COURSE_MAX_PLAUSIBLE_MPS = 2.2;
function courseSpeedPlausible(legs) {
  const meaningful = legs.filter((l) => l.meters >= 80 && l.seconds > 0);
  if (!meaningful.length) return true; // 판단할 구간이 없으면 막지 않는다
  const totalM = meaningful.reduce((s, l) => s + l.meters, 0);
  const totalS = meaningful.reduce((s, l) => s + l.seconds, 0);
  const avg = totalM / totalS;
  if (avg < COURSE_MIN_PLAUSIBLE_MPS || avg > COURSE_MAX_PLAUSIBLE_MPS) return false;
  return true;
}
/* OSRM /trip/ — 여러 지점의 실제 도보 방문 순서 최적화 + 구간별 실제
   거리·소요시간을 한 번에 받는다.
   2026-09-09 코드 검토(2차): roundtrip=false는 destination=last와만
   공식 지원되고, "마지막 목적지를 임의로 고정"하는 건 금지 지시사항이라
   쓸 수 없다. 대신 공식 지원 조합인 roundtrip=true&source=first로 받아
   origin으로 돌아오는 마지막 구간만 버린다(courseRealRoute 반환값은
   여전히 "origin→...→마지막 방문지"까지의 편도 legs다). */
async function courseRealRoute(origin, points, timeoutMs) {
  if (typeof fetch !== 'function') return null;
  const coords = [origin].concat(points).map((p) => p.lng + ',' + p.lat).join(';');
  const url = OSRM_FOOT_URL + coords + '?source=first&roundtrip=true&overview=false';
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
    const allLegs = (trip.legs || []).map((l) => ({ meters: l.distance, seconds: l.duration }));
    // roundtrip=true라 마지막 구간은 "마지막 방문지 → origin"으로 돌아오는
    // 구간이다 — 이 앱은 왕복이 아니라 편도 코스만 필요하므로 그 구간을 버린다.
    if (allLegs.length !== ordered.length + 1) return null;
    const legs = allLegs.slice(0, ordered.length);
    const totalMeters = legs.reduce((s, l) => s + l.meters, 0);
    const totalSeconds = legs.reduce((s, l) => s + l.seconds, 0);
    if (!courseSpeedPlausible(legs)) return null; // 도보로 보기엔 말이 안 되는 속도 — 프로필 오응답 의심
    return { ordered, legs, totalMeters, totalSeconds };
  } catch (e) {
    if (timer) clearTimeout(timer);
    return null;
  }
}
/* 코스 생성 본체. origin={lat,lng}, points=spots 배열(선택한 곳들).
   좌표 없는 곳은 excluded로 분리해 절대 조용히 빼지 않는다.
   opts.budgetMinutes(가용 시간, 분)를 주면 그 시간 안에 못 들어가는
   뒤쪽 곳들도 excluded로 분리한다 — 다만 "좌표가 없어서"와 "시간이
   모자라서"는 서로 다른 이유이므로 excludedReasons에 곳 id별로
   구분해 담아 화면에서 다르게 안내할 수 있게 한다(2026-09-09 코드
   검토 2차 — 이전에는 budgetMinutes를 읽기만 하고 실제로는 안 썼다). */
async function courseGenerate(origin, points, opts) {
  opts = opts || {};
  const withCoords = points.filter((p) => A.hasCoords(p));
  const withoutCoords = points.filter((p) => !A.hasCoords(p));
  const excludedReasons = {};
  withoutCoords.forEach((p) => { excludedReasons[p.id] = 'no-coords'; });
  if (!withCoords.length) return { ok: false, reason: 'no-coords', excluded: withoutCoords, excludedReasons };
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
  const startMinutes = opts.startMinutes || 0;
  const deadline = (typeof opts.budgetMinutes === 'number' && opts.budgetMinutes > 0)
    ? startMinutes + opts.budgetMinutes : Infinity;
  let clock = startMinutes;
  const stops = [];
  const timeExcluded = [];
  // 구간(legs)은 경로 순서대로 이어진 실제 이동 구간이다 — 중간에 한 곳만
  // "시간이 안 돼서" 건너뛰면, 그다음 곳까지의 구간 거리는 더 이상 실제
  // 이동 경로와 안 맞는다(어차피 안 들른 곳을 지나서 이동한다는 가정이
  // 깨진다). 그래서 시간 안에 못 들어가는 첫 곳을 만나면 거기서부터는
  // 전부 "시간 안에 못 들어감"으로 뒤로 뺀다(순서를 건너뛰며 계속 넣지 않는다).
  let overBudget = false;
  ordered.forEach((p, i) => {
    if (overBudget) { timeExcluded.push(p); excludedReasons[p.id] = 'time-budget'; return; }
    const walkMin = Math.max(1, Math.round(legs[i].seconds / 60));
    const arriveAt = clock + walkMin;
    const leaveAt = arriveAt + dwellMin;
    if (leaveAt > deadline) { overBudget = true; timeExcluded.push(p); excludedReasons[p.id] = 'time-budget'; return; }
    clock = arriveAt;
    stops.push({ id: p.id, name: p.name, walk: walkMin, at: clock, dwell: dwellMin });
    clock = leaveAt;
  });
  const keptMeters = legs.slice(0, stops.length).reduce((s, l) => s + l.meters, 0);
  const keptSeconds = legs.slice(0, stops.length).reduce((s, l) => s + l.seconds, 0);
  return {
    ok: true,
    routedReal,
    stops,
    excluded: withoutCoords.concat(timeExcluded),
    excludedReasons,
    totalMeters: keptMeters, totalSeconds: keptSeconds,
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
