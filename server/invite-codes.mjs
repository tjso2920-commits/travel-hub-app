'use strict';
/**
 * 2026-09-11 재검토(9차) 6-4절 — 소규모 베타 초대 코드.
 *
 * 실제로 이 게이트가 신규 가입을 막을지는 config.requireInviteCodeForSignup
 * (기본 false)가 결정한다 — "가격이 미정인 지금은 실제 모집을 켜지
 * 않는다"는 지시대로, 이 파일의 함수들은 준비돼 있지만 auth.mjs가 그
 * 스위치를 확인한 뒤에만 실제로 부른다.
 *
 * 계정당 한 번만 소모되는 이유(구조적 보장): consumeInviteCodeForNewAccount는
 * auth.mjs의 loginOrCreateAccount가 "이 이메일로 계정이 아직 없을 때"
 * 딱 한 번만 부른다. 이메일이 이미 있으면 이 파일을 아예 안 거치므로,
 * 한 계정(=한 이메일)이 여러 번 "신규 등록"으로 코드를 반복 소모하는
 * 시나리오 자체가 없다.
 */
import { nowIso } from './db.mjs';
import { config } from './config.mjs';
import { isRecruitmentPaused } from './app-flags.mjs';
import crypto from 'node:crypto';

function genCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase(); // 8자리(예: 3F9A1C0B).
}

export function totalDistinctRedeemers(db) {
  return db.prepare('SELECT COUNT(DISTINCT account_id) AS n FROM invite_code_redemptions').get().n;
}

/* 계정을 실제로 만들기 전에 부른다(읽기 전용 — 아무것도 안 바꾼다).
   account_id가 아직 없어 invite_code_redemptions에 FK로 넣을 수 없는
   시점이라, "쓸 수 있는지 확인"과 "실제로 소모"를 두 단계로 나눴다. */
export function checkInviteCodeForNewAccount(db, rawCode) {
  if (isRecruitmentPaused()) return { ok: false, reason: 'recruitment-paused' };
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return { ok: false, reason: 'invite-code-required' };
  const row = db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(code);
  if (!row || !row.active) return { ok: false, reason: 'invite-code-invalid' };
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return { ok: false, reason: 'invite-code-expired' };
  if (row.used_count >= row.max_uses) return { ok: false, reason: 'invite-code-exhausted' };
  if (totalDistinctRedeemers(db) >= config.invite.recruitmentTotalCap) return { ok: false, reason: 'recruitment-cap-reached' };
  return { ok: true, code };
}

/* checkInviteCodeForNewAccount로 이미 통과를 확인한 뒤, 계정이 실제로
   만들어진 다음(accountId 확보 후)에 부른다. 방금 확인한 조건을
   그대로 다시 반영한다(단일 이벤트 루프 안에서 순서가 보장되므로
   재확인은 방어적 차원). */
export function consumeInviteCodeForNewAccount(db, code, accountId) {
  db.prepare('UPDATE invite_codes SET used_count = used_count + 1 WHERE code = ?').run(code);
  db.prepare('INSERT INTO invite_code_redemptions (code, account_id, redeemed_at) VALUES (?, ?, ?)').run(code, accountId, nowIso());
}

export function adminCreateInviteCode(db, { maxUses, ttlDays } = {}) {
  const code = genCode();
  const uses = Number(maxUses) > 0 ? Math.floor(Number(maxUses)) : config.invite.defaultMaxUses;
  const days = Number(ttlDays) > 0 ? Number(ttlDays) : config.invite.defaultTtlDays;
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO invite_codes (code, max_uses, used_count, expires_at, active, created_at) VALUES (?, ?, 0, ?, 1, ?)')
    .run(code, uses, expiresAt, nowIso());
  return { ok: true, status: 200, code, maxUses: uses, expiresAt };
}

export function adminListInviteCodes(db) {
  const rows = db.prepare('SELECT code, max_uses, used_count, expires_at, active, created_at FROM invite_codes ORDER BY created_at DESC').all();
  return { ok: true, status: 200, items: rows, totalDistinctRedeemers: totalDistinctRedeemers(db), recruitmentTotalCap: config.invite.recruitmentTotalCap };
}

export function adminDeactivateInviteCode(db, code) {
  const c = String(code || '').trim().toUpperCase();
  const info = db.prepare('UPDATE invite_codes SET active = 0 WHERE code = ?').run(c);
  if (!info.changes) return { ok: false, status: 404, reason: 'not-found' };
  return { ok: true, status: 200 };
}
