'use strict';
/**
 * 최소 인증 — 이메일 + 매직 코드(비밀번호 없음).
 *
 * "기존 회원 재가입 요구 금지" — 이미 있는 이메일로 다시 로그인 코드를
 * 요청하면 새 계정을 만들지 않고 기존 계정으로 로그인만 시킨다.
 *
 * 2026-09-10 재검토(3차) — "이메일/IP 기준 제한을 적용하고 발송 실패
 * 시 사용할 수 없는 코드가 남지 않게 처리하라":
 * - 같은 이메일로는 `loginCodeCooldownSeconds` 안에 다시 요청할 수
 *   없다(이메일 폭탄·Resend 비용 남용 방지).
 * - 이메일 발송이 실제로 실패하면 방금 만든 코드 행을 그 자리에서
 *   지운다 — 사용자에게 전달되지도 않은 코드가 "아직 유효한 채로"
 *   DB에 남아 있으면 그건 아무도 못 쓰는 죽은 값이 아니라, 혹시 다른
   *   경로로 그 값을 추측·유출당했을 때 여전히 쓸 수 있는 위험한 값이다.
 * - 코드 검증은 연속 실패 횟수를 세어 `loginMaxVerifyAttempts` 넘으면
 *   `loginLockoutSeconds` 동안 그 이메일의 검증 자체를 잠근다(무한
 *   추측 방지 — 6자리 숫자 코드는 시도 횟수 제한이 없으면 사실상
 *   브루트포스가 가능하다).
 */
import crypto from 'node:crypto';
import { openDb, uuid, nowIso } from './db.mjs';
import { config } from './config.mjs';
import { sendEmail } from './adapters/email.mjs';
import { checkAndIncrement, hourWindow } from './rate-limit.mjs';
import { isRecruitmentPaused } from './app-flags.mjs';
import { checkInviteCodeForNewAccount, consumeInviteCodeForNewAccount } from './invite-codes.mjs';

function genCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

export async function requestLoginCode(email, ip) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized || !normalized.includes('@')) return { ok: false, reason: 'invalid-email' };

  const db = openDb();
  // 쿨다운 — 초 단위라 시간창은 분 단위(hourWindow)로는 너무 굵다. 최근
  // 요청 시각을 직접 비교하는 게 더 정확하다(짧은 쿨다운에 시/일 단위
  // 고정창은 안 맞는다 — 예: 창 경계를 걸치면 두 번 연속 허용될 수
  // 있다). login_codes에 이미 시간이 기록되니 별도 표 없이 그걸 본다.
  const last = db.prepare('SELECT created_at FROM login_codes WHERE email = ? ORDER BY rowid DESC LIMIT 1').get(normalized);
  if (last) {
    const elapsedMs = Date.now() - new Date(last.created_at).getTime();
    if (elapsedMs < config.loginCodeCooldownSeconds * 1000) {
      return { ok: false, reason: 'cooldown', retryAfterSeconds: Math.ceil((config.loginCodeCooldownSeconds * 1000 - elapsedMs) / 1000) };
    }
  }
  // IP 기준 한도(같은 IP가 여러 이메일에 무차별로 코드를 뿌리는 남용 방지).
  if (ip) {
    const ipCheck = checkAndIncrement(`login-ip:${ip}`, hourWindow(), Math.max(20, config.loginMaxVerifyAttempts * 4));
    if (!ipCheck.allowed) return { ok: false, reason: 'ip-rate-limited' };
  }

  const code = genCode();
  const now = Date.now();
  const expiresAt = new Date(now + config.loginCodeTtlSeconds * 1000).toISOString();
  const insertedAt = nowIso();
  db.prepare('INSERT INTO login_codes (email, code, created_at, expires_at, consumed) VALUES (?, ?, ?, ?, 0)')
    .run(normalized, code, insertedAt, expiresAt);

  const sent = await sendEmail({ to: normalized, subject: '로그인 코드', body: `로그인 코드: ${code} (10분 안에 사용하세요)` });
  if (!sent.ok) {
    // 전달 안 된 코드를 살려 두지 않는다 — 방금 넣은 그 행만 정확히 지운다.
    db.prepare('DELETE FROM login_codes WHERE email = ? AND code = ? AND created_at = ?').run(normalized, code, insertedAt);
    return { ok: false, reason: 'email-send-failed', detail: sent.reason };
  }
  return { ok: true };
}

/* 2026-09-11 재검토(9차) 6-4절 — 초대 코드 게이트는
   config.requireInviteCodeForSignup이 꺼져 있으면(기본값) 이 함수는
   예전과 완전히 동일하게 동작한다(기존 열린 가입 흐름·회귀 테스트
   보존). 켜져 있을 때만, "이 이메일로 계정이 아직 없을 때"(진짜
   신규 가입일 때)만 초대 코드를 확인·소모한다 — 이미 있는 계정의
   재로그인은 초대 코드와 전혀 무관하다. */
function loginOrCreateAccount(db, email, inviteCode) {
  const existing = db.prepare('SELECT id FROM accounts WHERE email = ?').get(email);
  if (existing) return { ok: true, accountId: existing.id, isNew: false };
  if (config.requireInviteCodeForSignup) {
    if (isRecruitmentPaused()) return { ok: false, reason: 'recruitment-paused' };
    const check = checkInviteCodeForNewAccount(db, inviteCode);
    if (!check.ok) return { ok: false, reason: check.reason };
    const id = uuid();
    db.prepare('INSERT INTO accounts (id, email, created_at, plan) VALUES (?, ?, ?, ?)')
      .run(id, email, nowIso(), 'free');
    consumeInviteCodeForNewAccount(db, check.code, id);
    return { ok: true, accountId: id, isNew: true };
  }
  const id = uuid();
  db.prepare('INSERT INTO accounts (id, email, created_at, plan) VALUES (?, ?, ?, ?)')
    .run(id, email, nowIso(), 'free');
  return { ok: true, accountId: id, isNew: true };
}

function isLocked(db, email) {
  const row = db.prepare('SELECT locked_until FROM login_attempts WHERE email = ?').get(email);
  if (!row || !row.locked_until) return false;
  return new Date(row.locked_until).getTime() > Date.now();
}
function recordFailure(db, email) {
  const row = db.prepare('SELECT fail_count FROM login_attempts WHERE email = ?').get(email);
  const nextCount = (row ? row.fail_count : 0) + 1;
  const lockedUntil = nextCount >= config.loginMaxVerifyAttempts
    ? new Date(Date.now() + config.loginLockoutSeconds * 1000).toISOString()
    : null;
  db.prepare(`
    INSERT INTO login_attempts (email, fail_count, locked_until) VALUES (?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET fail_count = excluded.fail_count, locked_until = excluded.locked_until
  `).run(email, nextCount, lockedUntil);
}
function clearFailures(db, email) {
  db.prepare('DELETE FROM login_attempts WHERE email = ?').run(email);
}

export function verifyLoginCode(email, code, inviteCode) {
  const normalized = String(email || '').trim().toLowerCase();
  const db = openDb();
  if (isLocked(db, normalized)) return { ok: false, reason: 'locked' };

  const row = db.prepare(
    'SELECT rowid, expires_at, consumed FROM login_codes WHERE email = ? AND code = ? ORDER BY rowid DESC LIMIT 1',
  ).get(normalized, String(code || ''));
  if (!row) { recordFailure(db, normalized); return { ok: false, reason: 'invalid-code' }; }
  if (row.consumed) { recordFailure(db, normalized); return { ok: false, reason: 'code-already-used' }; }
  if (new Date(row.expires_at).getTime() < Date.now()) { recordFailure(db, normalized); return { ok: false, reason: 'code-expired' }; }

  // 2026-09-11 재검토(9차) 6-4절 — 초대 코드가 잘못됐다고 해서 방금 이메일로
  // 받은(다시 요청하려면 쿨다운을 또 기다려야 하는) 로그인 코드까지 태워
  // 없애면 안 된다. 그래서 로그인 코드를 "사용됨"으로 표시하기 전에
  // 먼저 확인한다 — 이건 코드 추측 실패가 아니므로 실패 횟수에도 안 넣는다.
  const existingAccount = db.prepare('SELECT id FROM accounts WHERE email = ?').get(normalized);
  if (!existingAccount && config.requireInviteCodeForSignup) {
    const check = checkInviteCodeForNewAccount(db, inviteCode);
    if (!check.ok) return { ok: false, reason: check.reason };
  }

  db.prepare('UPDATE login_codes SET consumed = 1 WHERE rowid = ?').run(row.rowid);
  clearFailures(db, normalized);
  const accountResult = loginOrCreateAccount(db, normalized, inviteCode);
  if (!accountResult.ok) return { ok: false, reason: accountResult.reason };
  const accountId = accountResult.accountId;
  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + config.sessionTtlSeconds * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, accountId, nowIso(), expiresAt);
  return { ok: true, token, accountId, isNew: accountResult.isNew };
}

export function accountForToken(token) {
  if (!token) return null;
  const db = openDb();
  const row = db.prepare('SELECT account_id, expires_at FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row.account_id;
}

export function logout(token) {
  if (!token) return { ok: false, reason: 'missing-token' };
  const db = openDb();
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  return { ok: true };
}
