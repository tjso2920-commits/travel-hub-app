'use strict';
/**
 * 코스 저장/조회 — 계정별로 완전히 격리된다(코드 검토 ⑧: "계정당 데이터
 * 격리"). SQL의 WHERE account_id = ? 조건이 유일한 격리 경계다 —
 * account_id는 항상 세션 토큰에서만 뽑아 쓰고, 요청 본문(body)의 값을
 * 신뢰하지 않는다(그렇게 하면 다른 사람의 account_id를 실어 보내는
 * 것만으로 남의 데이터를 읽거나 덮어쓸 수 있게 된다 — 흔한 취약점).
 */
import { openDb, nowIso } from '../db.mjs';

export function getCourse(accountId) {
  const db = openDb();
  const row = db.prepare('SELECT data, updated_at FROM courses WHERE account_id = ?').get(accountId);
  if (!row) return { ok: true, course: null };
  return { ok: true, course: JSON.parse(row.data), updatedAt: row.updated_at };
}

export function saveCourse(accountId, courseData) {
  if (!courseData || typeof courseData !== 'object') return { ok: false, reason: 'invalid-course-data' };
  const db = openDb();
  const json = JSON.stringify(courseData);
  db.prepare(`
    INSERT INTO courses (account_id, data, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(accountId, json, nowIso());
  return { ok: true };
}
