'use strict';
/**
 * 2026-09-11 재검토(9차) 6-4절 — 운영자가 코드를 새로 배포하지 않고도
 * 즉시 켜고 끌 수 있는 소수의 전역 스위치. 지금은 recruitment_paused
 * 하나뿐이다("결제·데이터손실급 심각 이슈가 있으면 신규 모집/판매를
 * 일시중지할 수 있어야 한다"는 지시 반영).
 */
import { openDb, nowIso } from './db.mjs';

export function getFlag(key, fallback) {
  const db = openDb();
  const row = db.prepare('SELECT value FROM app_flags WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setFlag(key, value) {
  const db = openDb();
  db.prepare(`
    INSERT INTO app_flags (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, String(value), nowIso());
}

export function isRecruitmentPaused() {
  return getFlag('recruitment_paused', '0') === '1';
}

export function setRecruitmentPaused(paused) {
  setFlag('recruitment_paused', paused ? '1' : '0');
  return isRecruitmentPaused();
}
