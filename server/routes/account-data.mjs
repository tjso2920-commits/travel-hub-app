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
 * trips.mjs/visits.mjs가 이미 쓰는 것과 같은 패턴을 그대로 적용한다.
 *
 * 2026-09-10 재검토(8차) — ChatGPT가 7차 결과물에서 재현한 문제: 클라
 * 이언트가 "수정한 뒤 스스로 계산한 다음 버전"을 보내던 예전 방식과
 * `incomingVersion >= existing.version`(같아도 통과) 조합에서는, 원본
 * (버전 1)을 읽은 기기 A·B가 각각 편집 후 "버전 2"를 보내면 — A가
 * 먼저 수락돼 서버가 2가 된 뒤에도 B의 "버전 2"가 또 통과해 A의
 * 수정을 지워버렸다(같은 버전끼리도 그냥 통과됐기 때문).
 *
 * 고친 개념: 클라이언트가 보내는 `version` 필드는 이제 "내가 이
 * 수정을 만들 때 근거로 삼은 서버 버전"(기준 버전)이다 — 절대
 * "내가 계산한 다음 버전"이 아니다. 서버는 **정확히 같을 때만**
 * (`===`, `>=`가 아니다) 수락하고, 그 자리에서 새 버전 번호를 직접
 * 발급한다(existing.version + 1) — 클라이언트가 무슨 숫자를 보냈든
 * 그 숫자를 그대로 저장하지 않는다. 기준 버전이 안 맞으면(뒤처졌든,
 * 말도 안 되게 앞섰든) 무조건 충돌로 보고하고 서버의 현재 값
 * (`serverPlace`)을 그대로 실어 보내 클라이언트가 재병합하거나
 * 사용자에게 확인받을 수 있게 한다 — 서버 값도, 이 기기의 미저장
 * 수정도 어느 쪽도 조용히 사라지지 않는다(src/design/import-adapter.js
 * 의 daRemergePlaceConflict가 이 정보로 3-way 재병합을 한다).
 *
 * 내용이 실제로 안 바뀐 재전송(재시도·중복 저장 등)은 기준 버전이
 * 맞아도 버전을 올리지 않는다 — 안 그러면 아무 실질 변경도 없는데
 * 다른 기기의 기준 버전이 부당하게 뒤처진 것처럼 보이게 된다.
 *
 * 삭제(중복 병합 등)에도 같은 원칙을 적용한다 — "배열에 없다"로
 * 추측하지 않고 클라이언트가 `{id, baseVersion}`으로 명시한 것만
 * 지우되, 그 baseVersion이 서버의 현재 버전과 다르면(그 사이 다른
 * 기기가 이 장소를 실제로 고쳤다면) 조용히 지우지 않고 충돌로
 * 보고한다 — 방금 채워진 좌표 같은 정당한 최신 수정이 삭제로
 * 사라지는 사고를 막는다.
 */
import { openDb, nowIso } from '../db.mjs';

function serializePlaceRow(row) {
  let data = {};
  try { data = JSON.parse(row.data); } catch (e) { data = {}; }
  return { ...data, id: row.place_id, version: row.version };
}

// 버전/식별자·수정시각처럼 "내용 자체"가 아닌 필드를 뺀 뒤 비교한다 —
// 이 값이 같으면 실질적으로 아무것도 안 바뀐 재전송이다.
function placeContentEqual(incoming, existingData) {
  const { version, id, ...incomingRest } = incoming || {};
  const { version: ev, id: eid, ...existingRest } = existingData || {};
  return JSON.stringify(incomingRest) === JSON.stringify(existingRest);
}

export function getPlaces(accountId) {
  const db = openDb();
  const rows = db.prepare('SELECT place_id, data, version FROM account_places WHERE account_id = ? AND deleted = 0').all(accountId);
  return { ok: true, places: rows.map(serializePlaceRow) };
}

/* 기준 버전 대조 + 보수적 병합(7차 도입, 8차 재설계) — incomingDeletedIds
   는 이 기기가 명시적으로 지운(중복 병합 등) 장소를 {id, baseVersion}
   형태로 담는다(8차부터 — 삭제도 기준 버전 대조를 받는다). */
export function syncPlaces(accountId, incomingPlaces, incomingDeletedIds) {
  if (!Array.isArray(incomingPlaces)) return { ok: false, status: 400, reason: 'invalid-places' };
  const deletedItems = Array.isArray(incomingDeletedIds) ? incomingDeletedIds : [];
  const db = openDb();
  const now = nowIso();
  const conflicts = [];
  db.exec('BEGIN');
  try {
    const getStmt = db.prepare('SELECT * FROM account_places WHERE account_id = ? AND place_id = ?');
    const insertStmt = db.prepare('INSERT INTO account_places (account_id, place_id, data, deleted, updated_at, version) VALUES (?, ?, ?, 0, ?, 1)');
    const updateStmt = db.prepare('UPDATE account_places SET data = ?, deleted = 0, updated_at = ?, version = ? WHERE account_id = ? AND place_id = ?');
    for (const p of incomingPlaces) {
      if (!p || !p.id) continue;
      const placeId = String(p.id);
      const existing = getStmt.get(accountId, placeId);
      const baseVersion = Number(p.version) || 0;
      if (!existing) {
        // 서버가 처음 보는 장소 — 기준 버전과 무관하게 새로 만든다(다른
        // 기기가 이미 만든 장소와 id가 겹칠 일이 없으므로 충돌도 없다).
        insertStmt.run(accountId, placeId, JSON.stringify(p), now);
        continue;
      }
      if (existing.deleted) {
        // 다른 기기가 이미 이 id를 지웠다(예: 중복 병합) — 되살리지
        // 않는다. 이 기기가 그 사실을 아직 몰랐다는 신호로만 보고한다.
        conflicts.push({ placeId, reason: 'deleted-elsewhere' });
        continue;
      }
      const existingData = serializePlaceRow(existing);
      if (placeContentEqual(p, existingData)) {
        // 실질적으로 아무것도 안 바뀐 재전송 — 버전을 올리지 않는다.
        continue;
      }
      if (baseVersion === existing.version) {
        // 이 기기가 실제로 지금 서버가 들고 있는 값을 보고 수정했다는
        // 뜻이다 — 정확히 이 경우에만 수락하고, 새 버전은 서버가 직접
        // 매긴다(클라이언트가 보낸 숫자를 그대로 믿지 않는다).
        updateStmt.run(JSON.stringify(p), now, existing.version + 1, accountId, placeId);
      } else {
        // 기준 버전이 안 맞는다 — 뒤처졌든(다른 기기가 그 사이 고쳤다)
        // 말도 안 되게 앞섰든(잘못된 로컬 상태) 무조건 충돌로 보고하고
        // 서버의 현재 값을 그대로 실어 보낸다(재병합 근거).
        conflicts.push({ placeId, reason: 'stale-base-version', serverVersion: existing.version, serverPlace: existingData });
      }
    }
    for (const item of deletedItems) {
      if (!item) continue;
      const placeId = String(typeof item === 'object' ? item.id : item);
      if (!placeId || placeId === 'undefined') continue;
      const baseVersion = Number(typeof item === 'object' ? item.baseVersion : NaN) || 0;
      const existing = getStmt.get(accountId, placeId);
      if (!existing) {
        // 서버가 이 장소를 아예 모른다 — 지울 것도 없으니 무덤만
        // 남긴다(멱등 — 나중에 이 id로 뭔가 들어와도 되살아나지 않게).
        db.prepare('INSERT INTO account_places (account_id, place_id, data, deleted, updated_at, version) VALUES (?, ?, ?, 1, ?, 1)').run(accountId, placeId, '{}', now);
        continue;
      }
      if (existing.deleted) continue; // 이미 지워져 있음 — 멱등, 충돌 아님.
      if (baseVersion === existing.version) {
        db.prepare('UPDATE account_places SET deleted = 1, updated_at = ?, version = ? WHERE account_id = ? AND place_id = ?').run(now, existing.version + 1, accountId, placeId);
      } else {
        // 이 기기가 지우려는 근거(기준 버전)와 서버의 지금 값이 다르다
        // — 그 사이 다른 기기가 실제로 이 장소를 고쳤을 수 있다(예:
        // 좌표를 막 채워 넣음). 조용히 지우지 않고 충돌로 보고한다.
        conflicts.push({ placeId, reason: 'stale-base-version-delete', serverVersion: existing.version, serverPlace: serializePlaceRow(existing) });
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
      const baseVersion = Number(c.version) || 0;
      if (!existing) {
        db.prepare('INSERT INTO account_courses (account_id, city, date, data, deleted, updated_at, version) VALUES (?, ?, ?, ?, 0, ?, 1)')
          .run(accountId, city, date, JSON.stringify(c), now);
        continue;
      }
      const existingData = serializeCourseRow(existing);
      if (placeContentEqual(c, existingData)) {
        continue; // 실질적으로 안 바뀐 재전송 — 버전을 올리지 않는다.
      }
      if (baseVersion === existing.version) {
        db.prepare('UPDATE account_courses SET data = ?, deleted = 0, updated_at = ?, version = ? WHERE account_id = ? AND city = ? AND date = ?')
          .run(JSON.stringify(c), now, existing.version + 1, accountId, city, date);
      } else {
        conflicts.push({ city, date, reason: 'stale-base-version', serverVersion: existing.version, serverCourse: existingData });
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
