'use strict';
/**
 * 재방문 여행자 지원(2026-09-10 재검토 5차 5-③) — 다음 여행 코스 후보
 * 제안. 이 파일은 실제 코스를 생성하지 않는다(비용 드는 라우팅·장소조회
 * API를 전혀 안 부른다 — course-generation.mjs만 그 일을 한다) — 그저
 * "이번엔 어떤 장소들을 고려해 볼까"를 정리해 화면에 보여줄 후보 목록만
 * 만든다. 사람이 최종적으로 무엇을 담을지 고르고, 그 결과(코스 생성
 * 요청의 places 배열)는 여기서 절대 걸러지지 않는다 — "사용자가 명시적
 * 으로 선택한 곳은 방문 상태와 무관하게 항상 반영돼야 한다"는 지시는
 * course-generation.mjs가 클라이언트가 보낸 places 배열을 방문 상태로
 * 다시 거르는 코드를 아예 두지 않는 방식으로 지킨다(구조적 보장 —
 * 이 제안 함수는 그저 참고용 정렬/후보 목록일 뿐, 강제 필터가 아니다).
 *
 * 옵션:
 * - preferUnvisited(미방문 우선): 후보를 배제하지 않고 "정렬"만 한다 —
 *   미방문을 앞에 두되 방문한 곳도 그대로 목록에 남는다(완전히 숨기면
 *   "이미 가본 곳도 다시 담고 싶다"는 요청과 충돌한다).
 * - includeWantRevisit(다시 가고 싶음 포함): want_revisit=true인 장소는
 *   방문 여부와 무관하게 후보에 합쳐진다.
 * - fromTripId: 특정 과거 여행 하나를 지정하면, 그 여행의 코스에 담겼던
 *   장소 중 "방문 기록이 없는 곳"만 이월 후보로 뽑는다("과거 여행에
 *   담았지만 방문하지 못한 장소를 다음 여행에 쉽게 이월"). 지정하지
 *   않으면 계정 전체 보관함을 후보 풀로 쓴다.
 * - mustIncludeIds: 화면에서 이미 사용자가 고른 장소 id들 — 방문 상태와
 *   무관하게 항상 후보 목록에 포함시킨다(명시적 선택 우선 원칙을 이
 *   후보 목록 단계에서도 그대로 반영).
 *
 * 첫 화면 설정을 늘리지 않는다는 지시에 따라 새 화면/새 API 키 설정은
 * 없다 — 기존 "다음 코스 만들기" 버튼이 이 제안 목록을 부른 뒤 그대로
 * 기존 코스 생성 화면으로 넘겨준다(사진 일기·자동 GPS 타임라인·신규
 * 외부 API 없음).
 */
import { openDb } from '../db.mjs';

function placeIdsFromCourseData(rawData) {
  let obj = null;
  try { obj = JSON.parse(rawData); } catch (e) { obj = null; }
  const stops = (obj && Array.isArray(obj.stops)) ? obj.stops : [];
  const ids = new Set();
  for (const s of stops) {
    const id = typeof s === 'string' ? s : (s && s.id);
    if (id) ids.add(String(id));
  }
  return ids;
}

export function suggestNextTripPlaces(accountId, { fromTripId, preferUnvisited = true, includeWantRevisit = true, mustIncludeIds = [] } = {}) {
  const db = openDb();
  const visitRows = db.prepare('SELECT * FROM place_visits WHERE account_id = ?').all(accountId);
  const visitMap = new Map(visitRows.map((r) => [r.place_id, r]));

  let poolIds;
  let carriedFromTripId = null;
  if (fromTripId) {
    const trip = db.prepare('SELECT account_id FROM trips WHERE trip_id = ?').get(fromTripId);
    if (!trip || trip.account_id !== accountId) return { ok: false, status: 404, reason: 'trip-not-found' };
    const courseRows = db.prepare('SELECT data FROM trip_courses WHERE trip_id = ?').all(fromTripId);
    const idsInTrip = new Set();
    for (const r of courseRows) for (const id of placeIdsFromCourseData(r.data)) idsInTrip.add(id);
    // 이월 후보 = 그 여행에 담겼지만 방문 기록이 없는(visited가 아닌) 곳만.
    poolIds = [...idsInTrip].filter((id) => {
      const v = visitMap.get(id);
      return !(v && v.visited);
    });
    carriedFromTripId = fromTripId;
  } else {
    poolIds = db.prepare('SELECT place_id FROM account_places WHERE account_id = ?').all(accountId).map((r) => r.place_id);
  }

  const idSet = new Set(poolIds);
  if (includeWantRevisit) {
    for (const r of visitRows) if (r.want_revisit) idSet.add(r.place_id);
  }
  for (const id of mustIncludeIds) idSet.add(String(id));

  const placeDataRows = db.prepare('SELECT place_id, data FROM account_places WHERE account_id = ?').all(accountId);
  const placeDataMap = new Map(placeDataRows.map((r) => [r.place_id, JSON.parse(r.data)]));
  const mustSet = new Set(mustIncludeIds.map(String));

  let list = [...idSet].map((id) => {
    const v = visitMap.get(id);
    return {
      placeId: id,
      place: placeDataMap.get(id) || null,
      visited: !!(v && v.visited),
      wantRevisit: !!(v && v.want_revisit),
      mustInclude: mustSet.has(id),
    };
  });

  if (preferUnvisited) {
    // 배제가 아니라 정렬이다 — 미방문을 앞에 두되, 이미 방문한 곳(특히
    // "다시 가고 싶음"으로 표시된 곳)도 목록에 그대로 남는다.
    list = list.map((x, i) => ({ x, i })).sort((a, b) => {
      if (a.x.visited !== b.x.visited) return a.x.visited ? 1 : -1;
      return a.i - b.i; // 안정 정렬(원래 순서 보존)
    }).map((w) => w.x);
  }

  return { ok: true, status: 200, suggestions: list, carriedFromTripId };
}
