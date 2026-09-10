'use strict';
/**
 * 계정별 서버 저장 — 장소 보관함(account_places)과 날짜별 일정
 * (account_courses). 클라이언트의 foodMap.places/foodMap.courses 배열과
 * 1:1로 대응한다(2026-09-10 재검토: "브라우저에만 저장되어 계정별 서버
 * 보관이 연결되지 않았다"는 지적 반영).
 *
 * 2026-09-10 재검토(7차) — "/api/places 전체치환으로 오래된 기기가
 * 최신 장소 수정을 덮어쓰는 문제"를 실제로 고쳤다. 예전엔 PUT이 매번
 * "계정 전체 삭제 후 재삽입"이라, 오래된 스냅샷을 들고 있던 기기가
 * 나중에 저장을 누르면 최신 기기의 수정이 조용히 사라졌다(재현:
 * `scripts/test-sync-protection-screens.mjs`의 시나리오 (a)). 여기서도
 * trips.mjs/visits.mjs가 이미 쓰는 것과 같은 패턴을 그대로 적용한다:
 *
 *  - 행(장소/코스)마다 version을 두고, 들어온 값의 version이 서버
 *    버전보다 뒤처지면(오래된 기기) 조용히 덮어쓰지 않고 conflicts로
 *    보고한다 — 서버의 최신 값이 그대로 남는다. 실제로 더 늦게 수정한
 *    기기가 반드시 이긴다는 보장은 아니지만("버전이 최신인 쪽이
 *    이긴다"), 최소한 "뒤처진 기기가 최신 값을 못 본 채 덮어쓰는" 사고는
 *    구조적으로 막는다.
 *  - 장소 삭제(중복 병합으로 없어지는 쪽)는 "배열에 없다"로 추측하지
 *    않는다 — 그건 "이 기기가 아직 그 장소를 모른다"와 구분이 안 된다.
 *    클라이언트가 deletedIds로 명시적으로 알려온 id만 무덤 표시로
 *    지운다(visits.mjs의 removed_visit_dates와 같은 원리).
 *  - 응답에는 항상 이 계정의 현재 전체 목록(삭제 제외)을 실어 보내
 *    클라이언트가 그 결과로 로컬을 맞출 수 있게 한다(trips/visits와
 *    동일한 패턴 — src/design/spots.js의 daSyncPush 참고).
 */
import { openDb, nowIso } from '../db.mjs';

function serializePlaceRow(row) {
  let data = {};
  try { data = JSON.parse(row.data); } catch (e) { data = {}; }
  return { ...data, id: row.place_id, version: row.version };
}

export function getPlaces(accountId) {
  const db = openDb();
  const rows = db.prepare('SELECT place_id, data, version FROM account_places WHERE account_id = ? AND deleted = 0').all(accountId);
  return { ok: true, places: rows.map(serializePlaceRow) };
}

/* 버전 비교 + 보수적 병합(7차 신규) — incomingDeletedIds는 이 기기가
   명시적으로 지운(중복 병합 등) 장소 id만 담는다. */
export function syncPlaces(accountId, incomingPlaces, incomingDeletedIds) {
  if (!Array.isArray(incomingPlaces)) return { ok: false, status: 400, reason: 'invalid-places' };
  const deletedIds = Array.isArray(incomingDeletedIds) ? incomingDeletedIds : [];
  const db = openDb();
  const now = nowIso();
  const conflicts = [];
  db.exec('BEGIN');
  try {
    const getStmt = db.prepare('SELECT * FROM account_places WHERE account_id = ? AND place_id = ?');
    const insertStmt = db.prepare('INSERT INTO account_places (account_id, place_id, data, deleted, updated_at, version) VALUES (?, ?, ?, 0, ?, ?)');
    const updateStmt = db.prepare('UPDATE account_places SET data = ?, deleted = 0, updated_at = ?, version = ? WHERE account_id = ? AND place_id = ?');
    for (const p of incomingPlaces) {
      if (!p || !p.id) continue;
      const placeId = String(p.id);
      const existing = getStmt.get(accountId, placeId);
      const incomingVersion = Number(p.version) || 0;
      if (!existing) {
        insertStmt.run(accountId, placeId, JSON.stringify(p), now, Math.max(1, incomingVersion));
        continue;
      }
      if (existing.deleted) {
        // 다른 기기가 이미 이 id를 지웠다(예: 중복 병합) — 되살리지
        // 않는다. 이 기기가 그 사실을 아직 몰랐다는 신호로만 보고한다.
        conflicts.push({ placeId, reason: 'deleted-elsewhere' });
        continue;
      }
      if (incomingVersion >= existing.version) {
        updateStmt.run(JSON.stringify(p), now, existing.version + 1, accountId, placeId);
      } else {
        conflicts.push({ placeId, reason: 'stale-version', serverVersion: existing.version });
      }
    }
    for (const rawId of deletedIds) {
      if (!rawId) continue;
      const placeId = String(rawId);
      const existing = getStmt.get(accountId, placeId);
      if (!existing) {
        db.prepare('INSERT INTO account_places (account_id, place_id, data, deleted, updated_at, version) VALUES (?, ?, ?, 1, ?, 1)').run(accountId, placeId, '{}', now);
      } else if (!existing.deleted) {
        db.prepare('UPDATE account_places SET deleted = 1, updated_at = ?, version = ? WHERE account_id = ? AND place_id = ?').run(now, existing.version + 1, accountId, placeId);
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return { ok: false, status: 500, reason: 'transaction-failed' };
  }
  const serverRows = db.prepare('SELECT place_id, data, version FROM account_places WHERE account_id = ? AND deleted = 0').all(accountId);
  return { ok: true, status: 200, count: incomingPlaces.length, conflicts, places: serverRows.map(serializePlaceRow) };
}

function serializeCourseRow(row) {
  let data = {};
  try { data = JSON.parse(row.data); } catch (e) { data = {}; }
  return { ...data, version: row.version };
}

export function getCourses(accountId) {
  const db = openDb();
  const rows = db.prepare('SELECT city, date, data, version FROM account_courses WHERE account_id = ? AND deleted = 0').all(accountId);
  return { ok: true, courses: rows.map(serializeCourseRow) };
}

/* account_courses는 tripId가 없는 레거시 코스만 담당한다(trip에 딸린
   코스는 trips.mjs의 trip_courses가 버전 보호를 이미 갖고 있다 —
   2026-09-10 재검토 6차). 같은 (city, date) 자리를 두 기기가 서로 다른
   시점에 고치는 위험은 여기도 똑같이 있어 같은 버전 비교 방식을
   적용한다. */
export function syncCourses(accountId, incomingCourses) {
  if (!Array.isArray(incomingCourses)) return { ok: false, status: 400, reason: 'invalid-courses' };
  const db = openDb();
  const now = nowIso();
  const conflicts = [];
  db.exec('BEGIN');
  try {
    const getStmt = db.prepare('SELECT * FROM account_courses WHERE account_id = ? AND city = ? AND date = ?');
    for (const c of incomingCourses) {
      if (!c || !c.city || !c.date) continue;
      const city = String(c.city), date = String(c.date);
      const existing = getStmt.get(accountId, city, date);
      const incomingVersion = Number(c.version) || 0;
      if (!existing) {
        db.prepare('INSERT INTO account_courses (account_id, city, date, data, deleted, updated_at, version) VALUES (?, ?, ?, ?, 0, ?, ?)')
          .run(accountId, city, date, JSON.stringify(c), now, Math.max(1, incomingVersion));
        continue;
      }
      if (incomingVersion >= existing.version) {
        db.prepare('UPDATE account_courses SET data = ?, deleted = 0, updated_at = ?, version = ? WHERE account_id = ? AND city = ? AND date = ?')
          .run(JSON.stringify(c), now, existing.version + 1, accountId, city, date);
      } else {
        conflicts.push({ city, date, reason: 'stale-version', serverVersion: existing.version });
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return { ok: false, status: 500, reason: 'transaction-failed' };
  }
  const serverRows = db.prepare('SELECT city, date, data, version FROM account_courses WHERE account_id = ? AND deleted = 0').all(accountId);
  return { ok: true, status: 200, count: incomingCourses.length, conflicts, courses: serverRows.map(serializeCourseRow) };
}

/* 코스 생성이 성공했을 때 그 한 건만 upsert하는 용도(course-generation.mjs
   가 쓴다) — 매번 전체 배열을 다시 안 올려도 되게 하는 짧은 경로.
   여기도 매 upsert마다 version을 올려 둬야, 나중에 다른 기기가 전체
   배열을 동기화(syncCourses)할 때 "이 날짜는 이미 그 기기가 알던 것보다
   새 버전"이라고 정확히 비교할 수 있다. */
export function upsertAccountCourse(accountId, course) {
  const db = openDb();
  const now = nowIso();
  db.prepare(`
    INSERT INTO account_courses (account_id, city, date, data, deleted, updated_at, version) VALUES (?, ?, ?, ?, 0, ?, 1)
    ON CONFLICT(account_id, city, date) DO UPDATE SET data = excluded.data, deleted = 0, updated_at = excluded.updated_at, version = account_courses.version + 1
  `).run(accountId, String(course.city), String(course.date), JSON.stringify(course), now);
}
