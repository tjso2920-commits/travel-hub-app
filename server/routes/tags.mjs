'use strict';
/**
 * 2026-09-11 재검토(11차) 3절 — "태그 레지스트리를 계정별로 저장·
 * 동기화하고 계정 전환 시 격리해." 예전엔 foodMap.customTags가 이
 * 브라우저의 localStorage에만 있었고, 로그아웃하면 통째로 지웠다 —
 * 재로그인·다른 기기에서 이 계정이 만든 태그(이름·동의어·기본 태그
 * 이름 override)가 전혀 복원되지 않았다. account_places와 완전히
 * 같은 패턴(기준 버전 대조 + 내용 안 바뀐 재전송은 버전 안 올림 +
 * 소유 계정 격리)을 그대로 재사용한다 — 이미 검증된 코드 경로다.
 *
 * 한 행은 사용자가 만든 진짜 새 태그(source:'user') 또는 기본 태그의
 * 계정별 표시명 override(source:'builtin-override', id가 그 기본
 * 태그의 id와 같음) 둘 중 하나다 — import-adapter.js의 daRenameTag/
 * daCreateTag 참고. 어느 쪽이든 이 표에서 다루는 "행" 단위는 같다.
 */
import { openDb, nowIso } from '../db.mjs';

function serializeTagRow(row) {
  let data = {};
  try { data = JSON.parse(row.data); } catch (e) { data = {}; }
  return { ...data, id: row.tag_id, version: row.version };
}

function tagContentEqual(incoming, existingData) {
  const { version, id, ...incomingRest } = incoming || {};
  const { version: ev, id: eid, ...existingRest } = existingData || {};
  return JSON.stringify(incomingRest) === JSON.stringify(existingRest);
}

export function getTags(accountId) {
  const db = openDb();
  const rows = db.prepare('SELECT tag_id, data, version FROM account_tags WHERE account_id = ? AND deleted = 0').all(accountId);
  return { ok: true, tags: rows.map(serializeTagRow) };
}

export function syncTags(accountId, incomingTags, incomingDeletedIds) {
  if (!Array.isArray(incomingTags)) return { ok: false, status: 400, reason: 'invalid-tags' };
  const deletedItems = Array.isArray(incomingDeletedIds) ? incomingDeletedIds : [];
  const db = openDb();
  const now = nowIso();
  const conflicts = [];
  db.exec('BEGIN');
  try {
    const getStmt = db.prepare('SELECT * FROM account_tags WHERE account_id = ? AND tag_id = ?');
    const insertStmt = db.prepare('INSERT INTO account_tags (account_id, tag_id, data, deleted, updated_at, version) VALUES (?, ?, ?, 0, ?, 1)');
    const updateStmt = db.prepare('UPDATE account_tags SET data = ?, deleted = 0, updated_at = ?, version = ? WHERE account_id = ? AND tag_id = ?');
    for (const t of incomingTags) {
      if (!t || !t.id) continue;
      const tagId = String(t.id);
      const existing = getStmt.get(accountId, tagId);
      const baseVersion = Number(t.version) || 0;
      if (!existing) {
        insertStmt.run(accountId, tagId, JSON.stringify(t), now);
        continue;
      }
      if (existing.deleted) {
        conflicts.push({ tagId, reason: 'deleted-elsewhere' });
        continue;
      }
      const existingData = serializeTagRow(existing);
      if (tagContentEqual(t, existingData)) continue; // 실질적으로 안 바뀐 재전송 — 버전을 안 올린다.
      if (baseVersion === existing.version) {
        updateStmt.run(JSON.stringify(t), now, existing.version + 1, accountId, tagId);
      } else {
        conflicts.push({ tagId, reason: 'stale-base-version', serverVersion: existing.version, serverTag: existingData });
      }
    }
    for (const item of deletedItems) {
      if (!item) continue;
      const tagId = String(typeof item === 'object' ? item.id : item);
      if (!tagId || tagId === 'undefined') continue;
      const baseVersion = Number(typeof item === 'object' ? item.baseVersion : NaN) || 0;
      const existing = getStmt.get(accountId, tagId);
      if (!existing) {
        db.prepare('INSERT INTO account_tags (account_id, tag_id, data, deleted, updated_at, version) VALUES (?, ?, ?, 1, ?, 1)').run(accountId, tagId, '{}', now);
        continue;
      }
      if (existing.deleted) continue;
      if (baseVersion === existing.version) {
        db.prepare('UPDATE account_tags SET deleted = 1, updated_at = ?, version = ? WHERE account_id = ? AND tag_id = ?').run(now, existing.version + 1, accountId, tagId);
      } else {
        conflicts.push({ tagId, reason: 'stale-base-version-delete', serverVersion: existing.version, serverTag: serializeTagRow(existing) });
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return { ok: false, status: 500, reason: 'transaction-failed' };
  }
  const serverRows = db.prepare('SELECT tag_id, data, version FROM account_tags WHERE account_id = ? AND deleted = 0').all(accountId);
  return { ok: true, status: 200, conflicts, tags: serverRows.map(serializeTagRow) };
}
