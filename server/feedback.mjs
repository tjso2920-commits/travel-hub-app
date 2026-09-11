'use strict';
/**
 * 2026-09-11 재검토(9차) 6-4절 — "불편함 보내기" + 코스 생성 직후 짧은
 * 설문. 둘 다 같은 feedback 표를 쓰지만 설문은 type='survey_usage'로
 * 구분하고, 일반 제출 API로는 그 값을 고를 수 없게 화이트리스트에서
 * 뺐다(사용자가 직접 유형을 고르는 드롭다운에 노출되면 안 되는
 * 내부용 구분이기 때문).
 *
 * diagnostic은 딱 4개 키(appBuild/screen/errorCode/deviceType)만
 * 허용한다 — "전체 저장목록·정밀 GPS·결제정보는 기본으로 절대 수집
 * 하지 않는다"는 지시를 코드 구조로 보장하기 위해 화이트리스트 이외의
 * 어떤 키도 저장하지 않는다(클라이언트가 실수로든 고의로든 더 많이
 * 보내도 서버가 걸러낸다).
 */
import { openDb, uuid, nowIso } from './db.mjs';
import { config } from './config.mjs';
import { checkAndIncrement, dayWindow } from './rate-limit.mjs';

export const ALLOWED_FEEDBACK_TYPES = new Set(['import', 'location-route', 'usage', 'payment', 'other']);
const ALLOWED_STATUSES = ['received', 'in_progress', 'resolved'];
const DIAGNOSTIC_ALLOWED_KEYS = ['appBuild', 'screen', 'errorCode', 'deviceType'];

function sanitizeDiagnostic(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of DIAGNOSTIC_ALLOWED_KEYS) {
    if (raw[k] === undefined || raw[k] === null) continue;
    out[k] = String(raw[k]).slice(0, 80);
  }
  return out;
}

function safeParseJson(s, fallback) {
  try { return JSON.parse(s); } catch (e) { return fallback; }
}

export function submitFeedback({ accountId, type, description, contact, diagnostic }, ip) {
  const t = String(type || '').trim();
  if (!ALLOWED_FEEDBACK_TYPES.has(t)) return { ok: false, status: 400, reason: 'invalid-type' };
  const desc = String(description || '').trim();
  if (!desc) return { ok: false, status: 400, reason: 'empty-description' };
  if (desc.length > config.feedback.maxDescriptionLength) return { ok: false, status: 400, reason: 'description-too-long' };

  const day = dayWindow();
  if (accountId) {
    const check = checkAndIncrement(`feedback:account:${accountId}`, day, config.feedback.perAccountDailyLimit);
    if (!check.allowed) return { ok: false, status: 429, reason: 'account-daily-limit-reached' };
  } else if (ip) {
    const check = checkAndIncrement(`feedback:ip:${ip}`, day, config.feedback.perIpDailyLimit);
    if (!check.allowed) return { ok: false, status: 429, reason: 'ip-daily-limit-reached' };
  }

  const db = openDb();
  const id = uuid();
  const now = nowIso();
  db.prepare(`
    INSERT INTO feedback (id, account_id, type, description, contact, diagnostic, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'received', ?, ?)
  `).run(id, accountId || null, t, desc, contact ? String(contact).trim().slice(0, 200) : null, JSON.stringify(sanitizeDiagnostic(diagnostic)), now, now);
  return { ok: true, status: 200, id };
}

/* 코스 생성 직후 뜨는 짧은(닫을 수 있는, 코스 사용을 막지 않는) 설문.
   로그인은 필수(계정 단위 응답이라야 admin 화면에서 중복·스팸을
   구분할 수 있다) — 계정 없는 익명 제출은 허용하지 않는다. */
export function submitUsageSurvey({ accountId, tripId, actuallyTraveled, biggestBlocker }) {
  if (!accountId) return { ok: false, status: 401, reason: 'unauthorized' };
  const blocker = String(biggestBlocker || '').trim().slice(0, config.feedback.maxDescriptionLength);
  const db = openDb();
  const id = uuid();
  const now = nowIso();
  db.prepare(`
    INSERT INTO feedback (id, account_id, type, description, contact, diagnostic, status, created_at, updated_at)
    VALUES (?, ?, 'survey_usage', ?, NULL, ?, 'received', ?, ?)
  `).run(id, accountId, blocker || '(응답 없음)', JSON.stringify({ tripId: tripId ? String(tripId).slice(0, 100) : null, actuallyTraveled: actuallyTraveled ? '1' : '0' }), now, now);
  return { ok: true, status: 200, id };
}

export function adminListFeedback({ status, type } = {}) {
  const db = openDb();
  let sql = 'SELECT * FROM feedback WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (type) { sql += ' AND type = ?'; params.push(type); }
  sql += ' ORDER BY created_at DESC LIMIT 500';
  const rows = db.prepare(sql).all(...params);
  // 같은 유형 항목을 화면에서 묶어 보기 쉽게, 최근순 정렬은 유지한 채
  // type별 개수도 같이 돌려준다(관리자 화면이 "같은 유형끼리 묶어서
  // 보여줘야 한다"는 지시).
  const typeCounts = {};
  rows.forEach((r) => { typeCounts[r.type] = (typeCounts[r.type] || 0) + 1; });
  return {
    ok: true,
    status: 200,
    typeCounts,
    items: rows.map((r) => ({ ...r, diagnostic: safeParseJson(r.diagnostic, {}) })),
  };
}

export function adminUpdateFeedbackStatus(id, status) {
  if (!ALLOWED_STATUSES.includes(status)) return { ok: false, status: 400, reason: 'invalid-status' };
  const db = openDb();
  const info = db.prepare('UPDATE feedback SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), id);
  if (!info.changes) return { ok: false, status: 404, reason: 'not-found' };
  return { ok: true, status: 200 };
}
