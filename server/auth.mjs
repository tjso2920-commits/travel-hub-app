'use strict';
/**
 * 최소 인증 — 이메일 + 매직 코드(비밀번호 없음).
 *
 * 05_IMPORT_ONBOARDING_SPEC.md 방향("샘플 체험 → 가져오기 → 필요할 때만
 * 로그인")에 맞춰, 계정을 만드는 절차 자체를 최대한 가볍게 뒀다 —
 * 비밀번호를 만들고 기억하게 하지 않는다. 이메일로 6자리 코드를 보내고
 * (테스트 모드에서는 어댑터가 실제 발송 대신 기록만 한다), 그 코드를
 * 입력하면 세션 토큰을 내준다.
 *
 * "기존 회원 재가입 요구 금지"(코드 검토 ⑨) — 이미 있는 이메일로 다시
 * 로그인 코드를 요청하면 새 계정을 만들지 않고 기존 계정으로 로그인만
 * 시킨다(loginOrCreateAccount 참고).
 */
import crypto from 'node:crypto';
import { openDb, uuid, nowIso } from './db.mjs';
import { config } from './config.mjs';
import { sendEmail } from './adapters/email.mjs';

function genCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

export async function requestLoginCode(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized || !normalized.includes('@')) return { ok: false, reason: 'invalid-email' };
  const db = openDb();
  const code = genCode();
  const now = Date.now();
  const expiresAt = new Date(now + config.loginCodeTtlSeconds * 1000).toISOString();
  db.prepare('INSERT INTO login_codes (email, code, created_at, expires_at, consumed) VALUES (?, ?, ?, ?, 0)')
    .run(normalized, code, nowIso(), expiresAt);
  const sent = await sendEmail({ to: normalized, subject: '로그인 코드', body: `로그인 코드: ${code} (10분 안에 사용하세요)` });
  if (!sent.ok) return { ok: false, reason: 'email-send-failed' };
  return { ok: true };
}

/* 기존 회원이면 그 계정으로, 아니면 새로 만든다 — "재가입"이라는 별도
   절차 자체가 없다(이메일이 곧 계정 식별자다). */
function loginOrCreateAccount(db, email) {
  const existing = db.prepare('SELECT id FROM accounts WHERE email = ?').get(email);
  if (existing) return existing.id;
  const id = uuid();
  db.prepare('INSERT INTO accounts (id, email, created_at, plan) VALUES (?, ?, ?, ?)')
    .run(id, email, nowIso(), 'free');
  return id;
}

export function verifyLoginCode(email, code) {
  const normalized = String(email || '').trim().toLowerCase();
  const db = openDb();
  const row = db.prepare(
    'SELECT rowid, expires_at, consumed FROM login_codes WHERE email = ? AND code = ? ORDER BY rowid DESC LIMIT 1',
  ).get(normalized, String(code || ''));
  if (!row) return { ok: false, reason: 'invalid-code' };
  if (row.consumed) return { ok: false, reason: 'code-already-used' };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, reason: 'code-expired' };
  db.prepare('UPDATE login_codes SET consumed = 1 WHERE rowid = ?').run(row.rowid);
  const accountId = loginOrCreateAccount(db, normalized);
  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + config.sessionTtlSeconds * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, accountId, nowIso(), expiresAt);
  return { ok: true, token, accountId };
}

export function accountForToken(token) {
  if (!token) return null;
  const db = openDb();
  const row = db.prepare('SELECT account_id, expires_at FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row.account_id;
}
