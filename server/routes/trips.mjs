'use strict';
/**
 * 재방문 여행자 지원(2026-09-10 재검토 5차 5-①) — 장소 보관함(account_places)
 * 은 계정 단위로 그대로 두고, 여행은 각자 고유한 tripId·이름·날짜·숙소·
 * 코스 저장을 갖는다. 같은 도시로 여러 번 떠난 여행도 각각 따로
 * 저장·열람·전환할 수 있어야 하고, 새 여행을 만들거나 도시를 바꿔도
 * 기존 기록은 절대 지워지지 않는다(예전 account_courses의 "계정당 도시+
 * 날짜 하나"라는 암묵적 단일-여행 가정을 깬다).
 *
 * 무료·유료 경계(5-④): 이 파일의 모든 함수는 순수 기록 읽기/쓰기이지,
 * 코스를 새로 "생성"하지 않는다 — 실제 유료 API 호출(장소조회·경로계산)
 * 은 전혀 일으키지 않으므로 전부 무료다. 코스 재계산은 여전히
 * course-generation.mjs(무료체험/이용권 검사)를 거친다 — 이 파일은 그
 * 결과를 "어느 여행에" 저장할지만 다룬다.
 */
import { openDb, uuid, nowIso } from '../db.mjs';

function ownedTrip(db, accountId, tripId) {
  const row = db.prepare('SELECT * FROM trips WHERE trip_id = ?').get(tripId);
  if (!row || row.account_id !== accountId) return null;
  return row;
}

function serializeTrip(row) {
  return {
    tripId: row.trip_id,
    city: row.city,
    name: row.name,
    startDate: row.start_date,
    endDate: row.end_date,
    lodging: row.lodging ? JSON.parse(row.lodging) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

export function listTrips(accountId) {
  const db = openDb();
  const rows = db.prepare('SELECT * FROM trips WHERE account_id = ? ORDER BY updated_at DESC').all(accountId);
  return { ok: true, trips: rows.map(serializeTrip) };
}

/* 새 여행 생성 — 같은 도시로 이미 여행이 있어도 전혀 상관하지 않고
   완전히 새로운 trip_id로 만든다("같은 도시 재방문 여행도 각각 따로
   저장"). 기존 여행은 절대 건드리지 않는다. */
export function createTrip(accountId, { city, name, startDate, endDate, lodging } = {}) {
  if (!city || !String(city).trim()) return { ok: false, status: 400, reason: 'missing-city' };
  const db = openDb();
  const now = nowIso();
  const tripId = 'trip_' + uuid();
  db.prepare('INSERT INTO trips (trip_id, account_id, city, name, start_date, end_date, lodging, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)')
    .run(tripId, accountId, String(city).trim(), name || null, startDate || null, endDate || null, lodging ? JSON.stringify(lodging) : null, now, now);
  return { ok: true, status: 200, trip: serializeTrip(db.prepare('SELECT * FROM trips WHERE trip_id = ?').get(tripId)) };
}

/* 여행 정보 수정(이름·날짜·숙소) — 도시를 바꾸는 것도 허용하지만("도시를
   바꿔도 기존 기록이 지워지면 안 된다"는 지시는 "새 여행/도시 전환이
   과거 여행을 지우지 않는다"는 뜻이지, 지금 이 여행 하나의 도시 값을
   고쳐 쓰는 것 자체를 금지하는 게 아니다 — 이 여행의 trip_courses는
   그대로 남는다). 소유자 대조 후에만 적용, 버전을 올려 동기화 충돌
   감지(R5-7)에 쓴다. */
export function updateTrip(accountId, tripId, patch = {}) {
  const db = openDb();
  const row = ownedTrip(db, accountId, tripId);
  if (!row) return { ok: false, status: 404, reason: 'trip-not-found' };
  const next = {
    city: patch.city != null ? String(patch.city).trim() : row.city,
    name: patch.name !== undefined ? patch.name : row.name,
    start_date: patch.startDate !== undefined ? patch.startDate : row.start_date,
    end_date: patch.endDate !== undefined ? patch.endDate : row.end_date,
    lodging: patch.lodging !== undefined ? (patch.lodging ? JSON.stringify(patch.lodging) : null) : row.lodging,
  };
  const now = nowIso();
  db.prepare('UPDATE trips SET city = ?, name = ?, start_date = ?, end_date = ?, lodging = ?, updated_at = ?, version = version + 1 WHERE trip_id = ?')
    .run(next.city, next.name, next.start_date, next.end_date, next.lodging, now, tripId);
  return { ok: true, status: 200, trip: serializeTrip(db.prepare('SELECT * FROM trips WHERE trip_id = ?').get(tripId)) };
}

export function getTripCourses(accountId, tripId) {
  const db = openDb();
  const trip = ownedTrip(db, accountId, tripId);
  if (!trip) return { ok: false, status: 404, reason: 'trip-not-found' };
  const rows = db.prepare('SELECT date, data, updated_at FROM trip_courses WHERE trip_id = ? ORDER BY date').all(tripId);
  return { ok: true, status: 200, courses: rows.map((r) => ({ date: r.date, ...JSON.parse(r.data), updatedAt: r.updated_at })) };
}

/* 코스 생성 성공 시 그 한 건만 upsert(course-generation.mjs가 부른다) —
   전체 배열을 매번 다시 안 올려도 되게 하는 짧은 경로(예전
   upsertAccountCourse와 같은 역할, trip 단위로 분리됐을 뿐). */
export function upsertTripCourse(accountId, tripId, date, data) {
  const db = openDb();
  const trip = ownedTrip(db, accountId, tripId);
  if (!trip) return { ok: false, status: 404, reason: 'trip-not-found' };
  const now = nowIso();
  db.prepare(`
    INSERT INTO trip_courses (trip_id, date, data, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(trip_id, date) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(tripId, String(date), JSON.stringify(data), now);
  db.prepare('UPDATE trips SET updated_at = ?, version = version + 1 WHERE trip_id = ?').run(now, tripId);
  return { ok: true };
}

/* 여행 하나의 날짜별 코스를 통째로 치환(클라이언트가 여러 날짜를 한
   번에 정리해 올릴 때) — account_places/account_courses의 기존 전체
   치환 패턴과 같지만, 범위가 "이 여행(trip_id) 하나"로 좁혀져 있어
   다른 여행·다른 계정 데이터는 절대 건드리지 않는다. */
/* 2026-09-10 재검토(5차) 6절 — "재방문 기록을 보호하는 동기화": 예전
   account_places/account_courses처럼 "기기가 통째로 올린 걸 무조건
   믿고 전부 덮어쓰는" 방식은 오래 잠들어 있던 기기가 최신 서버 기록을
   되돌려 버릴 수 있다. 여행은 trips.version으로 지킨다 — 기기가 마지막
   으로 알던 버전이 지금 서버 버전보다 낮으면(그 사이 다른 기기가 이미
   더 새로 고쳤다는 뜻) 그 여행의 필드값은 조용히 덮어쓰지 않고
   conflicts로 보고한다(클라이언트가 서버의 최신 값으로 다시 맞추게).
   새 tripId(서버가 모르는 여행)는 항상 그대로 받아들인다(다른 기기가
   각자 만든 새 여행끼리는 애초에 키가 겹치지 않아 충돌이 없다).
   각 여행의 날짜별 코스는 "전체 삭제 후 재삽입"이 아니라 날짜별
   upsert만 한다 — 이 기기가 모르는 다른 기기의 날짜를 지우지 않는다. */
export function syncTrips(accountId, incomingTrips) {
  if (!Array.isArray(incomingTrips)) return { ok: false, status: 400, reason: 'invalid-trips' };
  const db = openDb();
  const now = nowIso();
  const conflicts = [];
  db.exec('BEGIN');
  try {
    for (const incoming of incomingTrips) {
      if (!incoming || !incoming.tripId || !incoming.city) continue;
      const existing = db.prepare('SELECT * FROM trips WHERE trip_id = ?').get(incoming.tripId);
      if (existing && existing.account_id !== accountId) continue; // 다른 계정 소유 — 절대 건드리지 않음(계정 격리)

      const lodgingJson = incoming.lodging !== undefined ? (incoming.lodging ? JSON.stringify(incoming.lodging) : null) : null;
      let conflicted = false;
      if (!existing) {
        db.prepare('INSERT INTO trips (trip_id, account_id, city, name, start_date, end_date, lodging, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)')
          .run(incoming.tripId, accountId, String(incoming.city), incoming.name || null, incoming.startDate || null, incoming.endDate || null, lodgingJson, now, now);
      } else {
        // 2026-09-10 재검토(8차) — ChatGPT가 account_places에서 재현한
        // 것과 같은 결함이 여기도 있었다: "기준 버전보다 크거나 같으면
        // 통과"는 서버가 이미 그 버전으로 올라간 뒤에도 같은 버전을
        // 다시 주장하는 요청을 통과시킨다. 정확히 같을 때만 수락한다
        // (`===`) — 클라이언트가 실제로 지금 서버 값을 보고 수정한
        // 경우만 정의상 존재할 수 있는 값이다.
        const baseVersion = Number(incoming.version) || 0;
        if (baseVersion !== existing.version) {
          conflicted = true;
          conflicts.push({ tripId: incoming.tripId, reason: 'stale-base-version', serverVersion: existing.version, serverTrip: serializeTrip(existing) });
        } else {
          db.prepare('UPDATE trips SET city = ?, name = ?, start_date = ?, end_date = ?, lodging = ?, updated_at = ?, version = version + 1 WHERE trip_id = ?')
            .run(String(incoming.city), incoming.name || null, incoming.startDate || null, incoming.endDate || null, lodgingJson, now, incoming.tripId);
        }
      }
      if (!conflicted && Array.isArray(incoming.courses)) {
        for (const c of incoming.courses) {
          if (!c || !c.date) continue;
          db.prepare(`
            INSERT INTO trip_courses (trip_id, date, data, updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(trip_id, date) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
          `).run(incoming.tripId, String(c.date), JSON.stringify(c), now);
        }
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return { ok: false, status: 500, reason: 'transaction-failed' };
  }
  const serverTrips = db.prepare('SELECT * FROM trips WHERE account_id = ? ORDER BY updated_at DESC').all(accountId).map(serializeTrip);
  return { ok: true, status: 200, conflicts, trips: serverTrips };
}

export function putTripCourses(accountId, tripId, courses) {
  if (!Array.isArray(courses)) return { ok: false, status: 400, reason: 'invalid-courses' };
  const db = openDb();
  const trip = ownedTrip(db, accountId, tripId);
  if (!trip) return { ok: false, status: 404, reason: 'trip-not-found' };
  const now = nowIso();
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM trip_courses WHERE trip_id = ?').run(tripId);
    const stmt = db.prepare('INSERT INTO trip_courses (trip_id, date, data, updated_at) VALUES (?, ?, ?, ?)');
    for (const c of courses) {
      if (!c || !c.date) continue;
      stmt.run(tripId, String(c.date), JSON.stringify(c), now);
    }
    db.prepare('UPDATE trips SET updated_at = ?, version = version + 1 WHERE trip_id = ?').run(now, tripId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return { ok: false, status: 500, reason: 'transaction-failed' };
  }
  return { ok: true, status: 200, count: courses.length };
}
