'use strict';
/**
 * 재방문 여행자 지원(2026-09-10 재검토 5차 5-②) — 방문 기록. 필터
 * "미방문/방문함/다시가고싶음"은 저장된 값이 아니라 아래 두 독립
 * 불리언에서 계산해 낸다:
 *   - 미방문 = !visited
 *   - 방문함 = visited
 *   - 다시가고싶음 = wantRevisit (visited와 무관하게 따로 켤 수 있다 —
 *     "방문함"이면서 동시에 "다시 가고 싶음"도 가능해야 한다는 지시)
 *
 * **코스에 장소를 담는 행위는 이 파일의 그 무엇도 절대 부르지 않는다**
 * (course-generation.mjs/trips.mjs 어디에서도 이 파일을 import하지
 * 않는다 — "장소를 코스에 추가해도 자동으로 방문 처리되면 안 된다"는
 * 지시를 코드 경로 자체를 아예 안 잇는 방식으로 지킨다). 방문 완료
 * 처리·취소는 오직 사용자가 명시적으로 부르는 markVisited/unmarkVisited
 * 뿐이다.
 *
 * removedVisitDates(무덤 표시): unmarkVisited로 지운 날짜를 기록해 둔다 —
 * R5-7 동기화에서 오래된 기기가 그 날짜를 여전히 들고 있다가 다시
 * 합쳐져도 되살아나지 않게 막는 근거(visits-sync.mjs 참고).
 *
 * 무료·유료 경계(5-④): 이 파일은 DB만 읽고 쓴다 — 유료 외부 API(장소
 * 조회·경로 계산)를 절대 부르지 않으므로, 방문 표시·기록 열람은 항상
 * 완전히 무료다(무료체험·이용권 상태와 전혀 무관하게 언제나 동작).
 */
import { openDb, nowIso } from '../db.mjs';

function parseArr(json) {
  try { const v = JSON.parse(json); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}

function serialize(row) {
  return {
    placeId: row.place_id,
    visited: !!row.visited,
    wantRevisit: !!row.want_revisit,
    visitedDates: parseArr(row.visited_dates),
    notes: row.notes || '',
    updatedAt: row.updated_at,
    version: row.version,
  };
}

function getOrDefault(db, accountId, placeId) {
  const row = db.prepare('SELECT * FROM place_visits WHERE account_id = ? AND place_id = ?').get(accountId, placeId);
  if (row) return row;
  return { account_id: accountId, place_id: placeId, visited: 0, want_revisit: 0, visited_dates: '[]', removed_visit_dates: '[]', notes: null, updated_at: nowIso(), version: 0 };
}

function upsertRow(db, row) {
  db.prepare(`
    INSERT INTO place_visits (account_id, place_id, visited, want_revisit, visited_dates, removed_visit_dates, notes, updated_at, version)
    VALUES (@account_id, @place_id, @visited, @want_revisit, @visited_dates, @removed_visit_dates, @notes, @updated_at, @version)
    ON CONFLICT(account_id, place_id) DO UPDATE SET
      visited = excluded.visited, want_revisit = excluded.want_revisit, visited_dates = excluded.visited_dates,
      removed_visit_dates = excluded.removed_visit_dates, notes = excluded.notes, updated_at = excluded.updated_at, version = excluded.version
  `).run(row);
}

export function getVisits(accountId) {
  const db = openDb();
  const rows = db.prepare('SELECT * FROM place_visits WHERE account_id = ?').all(accountId);
  return { ok: true, visits: rows.map(serialize) };
}

export function getVisit(accountId, placeId) {
  const db = openDb();
  return { ok: true, visit: serialize(getOrDefault(db, accountId, placeId)) };
}

/* 방문 완료 처리 — date(기본은 오늘)를 visited_dates에 추가한다(이미
   있으면 중복으로 안 쌓는다). 예전에 실수로 지웠던(tombstone) 같은
   날짜를 사용자가 다시 명시적으로 방문 처리하면, 그 무덤 표시도 지운다
   (사용자의 지금 의도가 가장 최신이므로). */
export function markVisited(accountId, placeId, { date, tripId, note } = {}) {
  if (!placeId) return { ok: false, status: 400, reason: 'missing-place-id' };
  const db = openDb();
  const row = getOrDefault(db, accountId, placeId);
  const d = date || nowIso().slice(0, 10);
  const dates = parseArr(row.visited_dates);
  if (!dates.some((x) => x.date === d)) dates.push({ date: d, tripId: tripId || null });
  const removed = parseArr(row.removed_visit_dates).filter((x) => x !== d);
  row.visited = 1;
  row.visited_dates = JSON.stringify(dates);
  row.removed_visit_dates = JSON.stringify(removed);
  if (note !== undefined) row.notes = note;
  row.updated_at = nowIso();
  row.version = (row.version || 0) + 1;
  upsertRow(db, row);
  return { ok: true, status: 200, visit: serialize(row) };
}

/* 방문 취소(실수로 표시한 것 되돌리기) — date를 지정하면 그 날짜만
   지운다. 지정하지 않으면 가장 최근 날짜 하나만 지운다(전체를 한 번에
   날리지 않는다 — 여러 번 방문한 기록은 보존). 지운 날짜는 무덤
   표시에 남겨 동기화 때 되살아나지 않게 한다. 날짜가 하나도 안 남으면
   visited를 다시 false로 되돌린다("미방문"으로 복귀). */
export function unmarkVisited(accountId, placeId, { date } = {}) {
  if (!placeId) return { ok: false, status: 400, reason: 'missing-place-id' };
  const db = openDb();
  const row = getOrDefault(db, accountId, placeId);
  const dates = parseArr(row.visited_dates);
  if (!dates.length) return { ok: true, status: 200, visit: serialize(row) }; // 이미 미방문 — 아무 것도 안 함(멱등)
  let removedDate;
  let next;
  if (date) {
    removedDate = date;
    next = dates.filter((x) => x.date !== date);
  } else {
    const last = dates[dates.length - 1];
    removedDate = last.date;
    next = dates.slice(0, -1);
  }
  const removedTombstones = parseArr(row.removed_visit_dates);
  if (!removedTombstones.includes(removedDate)) removedTombstones.push(removedDate);
  row.visited_dates = JSON.stringify(next);
  row.removed_visit_dates = JSON.stringify(removedTombstones);
  row.visited = next.length ? 1 : 0;
  row.updated_at = nowIso();
  row.version = (row.version || 0) + 1;
  upsertRow(db, row);
  return { ok: true, status: 200, visit: serialize(row) };
}

/* "다시 가고 싶음" — visited와 완전히 독립적으로 켜고 끈다. */
export function setWantRevisit(accountId, placeId, wantRevisit) {
  if (!placeId) return { ok: false, status: 400, reason: 'missing-place-id' };
  const db = openDb();
  const row = getOrDefault(db, accountId, placeId);
  row.want_revisit = wantRevisit ? 1 : 0;
  row.updated_at = nowIso();
  row.version = (row.version || 0) + 1;
  upsertRow(db, row);
  return { ok: true, status: 200, visit: serialize(row) };
}

/* 2026-09-10 재검토(5차) 6절 — "재방문 기록을 보호하는 동기화". 오래
   잠들어 있던 기기가 최신 방문 기록을 조용히 덮어쓰지 않게, 버전
   비교 후 충돌이면 무조건 신뢰해 덮어쓰지 않고 "보수적으로 재병합"
   한다:
   - 방문 날짜(visitedDates)는 절대 단순 덮어쓰기하지 않는다 — 서버의
     현재 날짜와 기기가 보낸 날짜의 합집합을 쓰되, 서버의 무덤 표시
     (removed_visit_dates — 다른 기기가 이미 명시적으로 지운 날짜)에
     있는 날짜는 되살리지 않는다. 이렇게 하면 "서로 다른 기기가 같은
     장소에 서로 다른 날짜를 남긴" 경우 둘 다 보존되고, "지운 뒤 오래된
     기기가 그 날짜를 다시 들고 나타난" 경우엔 안 되살아난다.
   - 방문/다시가고싶음/메모 같은 단일 값은 실제 수정 시각(updatedAt)이
     더 늦은 쪽이 이긴다(LWW) — 버전이 뒤처진 기기라도 그 기기의 수정이
     실제로 더 최근이면 반영한다(단순히 "버전 낮으면 무조건 무시"가
     아니라, 값 종류별로 안전한 병합 규칙을 따로 둔 것). */
export function syncVisits(accountId, incomingVisits) {
  if (!Array.isArray(incomingVisits)) return { ok: false, status: 400, reason: 'invalid-visits' };
  const db = openDb();
  const now = nowIso();
  const conflicts = [];
  for (const incoming of incomingVisits) {
    if (!incoming || !incoming.placeId) continue;
    const placeId = String(incoming.placeId);
    const existing = db.prepare('SELECT * FROM place_visits WHERE account_id = ? AND place_id = ?').get(accountId, placeId);
    const incomingVersion = Number(incoming.version) || 0;
    const incomingDates = Array.isArray(incoming.visitedDates) ? incoming.visitedDates : [];
    const incomingUpdatedAt = incoming.updatedAt || now;

    if (!existing) {
      upsertRow(db, {
        account_id: accountId, place_id: placeId,
        visited: incomingDates.length || incoming.visited ? 1 : 0,
        want_revisit: incoming.wantRevisit ? 1 : 0,
        visited_dates: JSON.stringify(incomingDates),
        removed_visit_dates: '[]',
        notes: incoming.notes || null,
        updated_at: incomingUpdatedAt,
        version: Math.max(1, incomingVersion),
      });
      continue;
    }

    // 2026-09-10 재검토(8차) — account_places에서 재현된 것과 같은
    // 결함: "기준 버전보다 크거나 같으면 통과"는 두 기기가 같은
    // 원본(같은 버전)에서 각자 다른 방문 날짜를 추가했을 때 나중
    // 요청이 먼저 요청의 날짜를 통째로 덮어쓸 수 있게 한다(그 사이
    // 서버 값은 이미 바뀌었는데, "내가 그 버전을 실제로 봤다"는
    // 보장이 없는 값을 그대로 믿었기 때문). 정확히 같을 때만("나는
    // 지금 서버가 들고 있는 값을 보고 수정했다") 단순 반영하고, 그
    // 외에는 전부 아래 else(합집합+무덤표시 보수적 병합)로 보낸다 —
    // 날짜 데이터는 절대 단순 덮어쓰기하지 않는다는 원칙을 지킨다.
    if (incomingVersion === existing.version) {
      // 이 기기가 서버와 정확히 같은 상태에서 보낸 값 — 그대로
      // 신뢰한다(서버 무덤 표시는 안전판으로 그대로 유지).
      upsertRow(db, {
        account_id: accountId, place_id: placeId,
        visited: incomingDates.length ? 1 : 0,
        want_revisit: incoming.wantRevisit ? 1 : 0,
        visited_dates: JSON.stringify(incomingDates),
        removed_visit_dates: existing.removed_visit_dates,
        notes: incoming.notes != null ? incoming.notes : existing.notes,
        updated_at: now,
        version: Math.max(existing.version, incomingVersion) + 1,
      });
    } else {
      // 충돌 — 기기의 버전이 뒤처져 있다(그 사이 다른 기기가 이미 이
      // 장소를 고쳤다). 날짜는 합집합-무덤표시로 보수적 병합, 단일
      // 값은 실제 수정 시각이 늦은 쪽이 이긴다.
      const serverDates = parseArr(existing.visited_dates);
      const serverTombstones = new Set(parseArr(existing.removed_visit_dates));
      const merged = new Map();
      for (const d of serverDates) merged.set(d.date, d);
      for (const d of incomingDates) if (!serverTombstones.has(d.date) && !merged.has(d.date)) merged.set(d.date, d);
      const mergedDates = [...merged.values()];
      const serverIsNewer = new Date(existing.updated_at).getTime() >= new Date(incomingUpdatedAt).getTime();
      upsertRow(db, {
        account_id: accountId, place_id: placeId,
        visited: mergedDates.length ? 1 : 0,
        want_revisit: serverIsNewer ? existing.want_revisit : (incoming.wantRevisit ? 1 : 0),
        visited_dates: JSON.stringify(mergedDates),
        removed_visit_dates: JSON.stringify([...serverTombstones]),
        notes: serverIsNewer ? existing.notes : (incoming.notes != null ? incoming.notes : existing.notes),
        updated_at: now,
        version: existing.version + 1,
      });
      conflicts.push({ placeId, reason: 'stale-version', serverVersion: existing.version, mergedDatesCount: mergedDates.length });
    }
  }
  const serverVisits = db.prepare('SELECT * FROM place_visits WHERE account_id = ?').all(accountId).map(serialize);
  return { ok: true, status: 200, conflicts, visits: serverVisits };
}

export function setNotes(accountId, placeId, notes) {
  if (!placeId) return { ok: false, status: 400, reason: 'missing-place-id' };
  const db = openDb();
  const row = getOrDefault(db, accountId, placeId);
  row.notes = notes || '';
  row.updated_at = nowIso();
  row.version = (row.version || 0) + 1;
  upsertRow(db, row);
  return { ok: true, status: 200, visit: serialize(row) };
}
