'use strict';
/**
 * 계정별 서버 저장 — 장소 보관함(account_places)과 날짜별 일정
 * (account_courses). 클라이언트의 foodMap.places/foodMap.courses 배열과
 * 1:1로 대응한다(2026-09-10 재검토: "브라우저에만 저장되어 계정별 서버
 * 보관이 연결되지 않았다"는 지적 반영).
 *
 * 병합 정책은 여기서 정하지 않는다 — "마지막에 저장한 기기가 이긴다"
 * 같은 단순 정책이 데이터를 조용히 지울 수 있어서, 실제 병합(이미
 * 검증된 daMerge류 로직)은 클라이언트가 로그인 시 서버 데이터를 받아
 * 로컬 데이터와 병합한 뒤 다시 통째로 올리는 방식으로 처리한다(로그인
 * 흐름 참고, src/design/spots.js). 이 라우트들은 순수하게 "지금 이
 * 계정의 서버 저장값을 그대로 읽고 쓴다"만 담당한다.
 */
import { openDb, nowIso } from '../db.mjs';

export function getPlaces(accountId) {
  const db = openDb();
  const rows = db.prepare('SELECT data FROM account_places WHERE account_id = ?').all(accountId);
  return { ok: true, places: rows.map((r) => JSON.parse(r.data)) };
}

/* 전체 치환(클라이언트가 병합을 마친 최종 배열을 통째로 올린다) —
   부분 diff 동기화보다 단순하고, 이 규모(개인 저장 목록, 수백 건
   수준)에서는 매번 전체를 보내도 무리가 없다. 트랜잭션으로 묶어
   중간에 실패해도 반쯤 지워진 상태로 안 남게 한다. */
export function putPlaces(accountId, places) {
  if (!Array.isArray(places)) return { ok: false, status: 400, reason: 'invalid-places' };
  const db = openDb();
  const now = nowIso();
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM account_places WHERE account_id = ?').run(accountId);
    const stmt = db.prepare('INSERT INTO account_places (account_id, place_id, data, updated_at) VALUES (?, ?, ?, ?)');
    for (const p of places) {
      if (!p || !p.id) continue;
      stmt.run(accountId, String(p.id), JSON.stringify(p), now);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return { ok: false, status: 500, reason: 'transaction-failed' };
  }
  return { ok: true, status: 200, count: places.length };
}

export function getCourses(accountId) {
  const db = openDb();
  const rows = db.prepare('SELECT data FROM account_courses WHERE account_id = ?').all(accountId);
  return { ok: true, courses: rows.map((r) => JSON.parse(r.data)) };
}

export function putCourses(accountId, courses) {
  if (!Array.isArray(courses)) return { ok: false, status: 400, reason: 'invalid-courses' };
  const db = openDb();
  const now = nowIso();
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM account_courses WHERE account_id = ?').run(accountId);
    const stmt = db.prepare('INSERT INTO account_courses (account_id, city, date, data, updated_at) VALUES (?, ?, ?, ?, ?)');
    for (const c of courses) {
      if (!c || !c.city || !c.date) continue;
      stmt.run(accountId, String(c.city), String(c.date), JSON.stringify(c), now);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return { ok: false, status: 500, reason: 'transaction-failed' };
  }
  return { ok: true, status: 200, count: courses.length };
}

/* 코스 생성이 성공했을 때 그 한 건만 upsert하는 용도(course-generation.mjs
   가 쓴다) — 매번 전체 배열을 다시 안 올려도 되게 하는 짧은 경로. */
export function upsertAccountCourse(accountId, course) {
  const db = openDb();
  const now = nowIso();
  db.prepare(`
    INSERT INTO account_courses (account_id, city, date, data, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(account_id, city, date) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(accountId, String(course.city), String(course.date), JSON.stringify(course), now);
}
