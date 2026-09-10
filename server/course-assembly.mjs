'use strict';
/**
 * 이동 구간(legs)이 정해진 뒤 "몇 시에 어디 도착·언제까지 있다 다음
 * 곳으로"를 계산하는 부분 — 예전에 클라이언트 `src/design/course.js`의
 * `courseGenerate()` 안에 있던 시간 예산·제외 로직을 그대로 서버로
 * 옮겼다(로직을 새로 만들지 않고 검증된 것을 옮김 — 동작이 달라지면
 * 안 되므로 원본 주석의 설명도 그대로 유지한다).
 */
const DEFAULT_DWELL_MIN = 40;

export function assembleCourse({ places, startMinutes, budgetMinutes, dwellMin, routeResult }) {
  const withCoords = places.filter((p) => typeof p.lat === 'number' && typeof p.lng === 'number');
  const withoutCoords = places.filter((p) => !(typeof p.lat === 'number' && typeof p.lng === 'number'));
  const excludedReasons = {};
  withoutCoords.forEach((p) => { excludedReasons[p.id] = 'no-coords'; });
  if (!withCoords.length) return { ok: false, reason: 'no-coords', excluded: withoutCoords, excludedReasons };

  const { routedReal, ordered, legs, fallbackReason } = routeResult;
  const dwell = dwellMin || DEFAULT_DWELL_MIN;
  const start = startMinutes || 0;
  const deadline = (typeof budgetMinutes === 'number' && budgetMinutes > 0) ? start + budgetMinutes : Infinity;

  // 구간은 방문 순서대로 이어진 실제(또는 추정) 이동 구간이다 — 중간에
  // 한 곳만 "시간이 안 돼서" 건너뛰면 그다음 구간 거리가 실제 이동
  // 경로와 안 맞게 된다. 시간 안에 못 들어가는 첫 곳을 만나면 그 뒤로는
  // 전부 "시간 안에 못 들어감"으로 뺀다(순서를 건너뛰며 계속 넣지 않음).
  let clock = start;
  const stops = [];
  const timeExcluded = [];
  let overBudget = false;
  ordered.forEach((p, i) => {
    if (overBudget) { timeExcluded.push(p); excludedReasons[p.id] = 'time-budget'; return; }
    const walkMin = Math.max(1, Math.round(legs[i].seconds / 60));
    const arriveAt = clock + walkMin;
    const leaveAt = arriveAt + dwell;
    if (leaveAt > deadline) { overBudget = true; timeExcluded.push(p); excludedReasons[p.id] = 'time-budget'; return; }
    clock = arriveAt;
    stops.push({ id: p.id, name: p.name, walk: walkMin, at: clock, dwell });
    clock = leaveAt;
  });
  const keptMeters = legs.slice(0, stops.length).reduce((s, l) => s + l.distanceMeters, 0);
  return {
    ok: true,
    routedReal,
    fallbackReason: routedReal ? undefined : fallbackReason,
    stops,
    excluded: withoutCoords.concat(timeExcluded),
    excludedReasons,
    totalMeters: keptMeters,
    walkTotal: stops.reduce((s, x) => s + x.walk, 0),
    endAt: clock,
  };
}
