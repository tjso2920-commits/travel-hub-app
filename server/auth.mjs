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
import { verifyGoogleIdToken } from './adapters/google-auth.mjs';

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
// 2026-09-11 재검토(13차) 2절 — Google 로그인도 이 함수를 그대로
// 재사용한다(export). "같은 이메일이면 같은 계정"이라는 판단·초대코드
// 게이트 정책이 이메일 코드 로그인과 완전히 동일해야, 로그인 방식을
// 바꿔도 무료체험·이용권 같은 계정별 상태가 그대로 이어진다(계정
// 식별자가 그대로이므로 별도 "이전" 로직 자체가 필요 없다).
export function loginOrCreateAccount(db, email, inviteCode) {
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

// 2026-09-11 재검토(14차) 2절 — verifyLoginCode(이메일 코드 검증)와
// googleSignIn(Google 계정 연결 소유확인)이 "유효한 로그인 코드 하나
// 소모"라는 같은 동작을 필요로 해서 공통 부분만 뽑았다. 코드를
// "쓴 것으로 표시"하는 시점은 호출부마다 다르므로(verifyLoginCode는
// 초대코드 확인 뒤에 소모해야 함) 조회/소모를 분리한다.
function findValidLoginCodeRow(db, email, code) {
  if (isLocked(db, email)) return { ok: false, reason: 'locked' };
  const row = db.prepare(
    'SELECT rowid, expires_at, consumed FROM login_codes WHERE email = ? AND code = ? ORDER BY rowid DESC LIMIT 1',
  ).get(email, String(code || ''));
  if (!row) { recordFailure(db, email); return { ok: false, reason: 'invalid-code' }; }
  if (row.consumed) { recordFailure(db, email); return { ok: false, reason: 'code-already-used' }; }
  if (new Date(row.expires_at).getTime() < Date.now()) { recordFailure(db, email); return { ok: false, reason: 'code-expired' }; }
  return { ok: true, rowid: row.rowid };
}
function consumeLoginCodeRow(db, email, rowid) {
  db.prepare('UPDATE login_codes SET consumed = 1 WHERE rowid = ?').run(rowid);
  clearFailures(db, email);
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

function createSession(db, accountId) {
  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + config.sessionTtlSeconds * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, accountId, nowIso(), expiresAt);
  return token;
}

export function verifyLoginCode(email, code, inviteCode) {
  const normalized = String(email || '').trim().toLowerCase();
  const db = openDb();
  const found = findValidLoginCodeRow(db, normalized, code);
  if (!found.ok) return found;

  // 2026-09-11 재검토(9차) 6-4절 — 초대 코드가 잘못됐다고 해서 방금 이메일로
  // 받은(다시 요청하려면 쿨다운을 또 기다려야 하는) 로그인 코드까지 태워
  // 없애면 안 된다. 그래서 로그인 코드를 "사용됨"으로 표시하기 전에
  // 먼저 확인한다 — 이건 코드 추측 실패가 아니므로 실패 횟수에도 안 넣는다.
  const existingAccount = db.prepare('SELECT id FROM accounts WHERE email = ?').get(normalized);
  if (!existingAccount && config.requireInviteCodeForSignup) {
    const check = checkInviteCodeForNewAccount(db, inviteCode);
    if (!check.ok) return { ok: false, reason: check.reason };
  }

  consumeLoginCodeRow(db, normalized, found.rowid);
  const accountResult = loginOrCreateAccount(db, normalized, inviteCode);
  if (!accountResult.ok) return { ok: false, reason: accountResult.reason };
  const accountId = accountResult.accountId;
  const token = createSession(db, accountId);
  return { ok: true, token, accountId, isNew: accountResult.isNew };
}

function linkGoogleIdentity(db, verified, accountId) {
  const now = nowIso();
  db.prepare('INSERT INTO google_identities (sub, account_id, email, hd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(verified.sub, accountId, verified.email, verified.hd || null, now, now);
}

// 2026-09-11 재검토(14차) 2절 — ChatGPT 재현: owner@example.com 계정이
// 이미 있는 상태에서, 같은 이메일에 email_verified:true·hd 없음인
// "새로운"(한 번도 못 본 sub) Google 토큰을 보내면 예전 코드는 추가
// 확인 없이 그 계정에 그대로 로그인시켰다(계정 탈취 경로). Google
// 공식 가이드(https://developers.google.com/identity/gsi/web/guides/
// verify-google-id-token)도 이메일이 아니라 sub를 식별자로 쓰라고
// 못박는다 — Gmail·제대로 구성된 Workspace 도메인은 주소가 재사용되지
// 않지만, 외부에서 호스팅되는 이메일 주소는 그 보장이 없다(나중에
// 다른 사람이 그 메일함을 손에 넣고 새 Google 계정으로 "검증된"
// 토큰을 받을 수 있음). 두 조건을 안전하게 구분해서 신뢰도를 다르게
// 주는 대신, 더 단순하고 보수적으로 "어느 쪽이든 기존의 다른 계정에
// 새로 합칠 때는 항상 소유확인을 요구"한다 — hd는 그래도 계정 화면
// 표시·추후 감사용으로 같이 저장한다(위 linkGoogleIdentity).
function verifyOwnershipOfExistingAccount(db, accountId, email, opts) {
  if (opts.sessionToken) {
    const row = db.prepare('SELECT account_id, expires_at FROM sessions WHERE token = ?').get(opts.sessionToken);
    if (row && row.account_id === accountId && new Date(row.expires_at).getTime() >= Date.now()) {
      return { ok: true };
    }
    return { ok: false, reason: 'ownership-verification-required' };
  }
  if (opts.emailCode) {
    const found = findValidLoginCodeRow(db, email, opts.emailCode);
    if (!found.ok) return { ok: false, reason: 'ownership-verification-required' };
    consumeLoginCodeRow(db, email, found.rowid);
    return { ok: true };
  }
  return { ok: false, reason: 'ownership-verification-required' };
}

/* 2026-09-11 재검토(14차) 2절 — Google 로그인 재설계. 계정 연결의
   기본 키는 이제 이메일이 아니라 Google의 sub(google_identities 표,
   db.mjs 참고)다:
   1) 이미 연결된 sub → 그 계정으로 바로 로그인(반복 확인 불필요,
      이메일/hd만 최신화).
   2) 아직 연결 안 된 sub인데 그 이메일을 쓰는 계정이 아예 없음 →
      새 계정을 만들어 즉시 연결(합치는 게 아니라 새로 생기는 것이라
      안전).
   3) 아직 연결 안 된 sub인데 그 이메일로 이미 "다른" 계정이 있음 →
      그 계정에 무조건 합치지 않고 소유확인을 요구한다(opts.sessionToken
      또는 opts.emailCode). 확인 안 되면 로그인 자체를 거절한다.
   계정 id 자체는 로그인 방식이 바뀌어도 그대로이므로, 이용권·무료체험
   상태(계정 id 기준으로 저장됨)는 이 연결 과정에서 절대 리셋되지
   않는다. */
export async function googleSignIn(idToken, inviteCode, opts) {
  opts = opts || {};
  if (config.services.googleAuth !== 'real') return { ok: false, status: 503, reason: 'google-auth-unavailable' };
  const verified = await verifyGoogleIdToken(idToken, opts);
  if (!verified.ok) return { ok: false, status: 401, reason: verified.reason };
  const db = openDb();

  const linked = db.prepare('SELECT account_id FROM google_identities WHERE sub = ?').get(verified.sub);
  if (linked) {
    db.prepare('UPDATE google_identities SET email = ?, hd = ?, updated_at = ? WHERE sub = ?')
      .run(verified.email, verified.hd || null, nowIso(), verified.sub);
    const token = createSession(db, linked.account_id);
    return { ok: true, status: 200, token, accountId: linked.account_id, isNew: false, email: verified.email };
  }

  const existingAccount = db.prepare('SELECT id FROM accounts WHERE email = ?').get(verified.email);
  if (!existingAccount) {
    const accountResult = loginOrCreateAccount(db, verified.email, inviteCode);
    if (!accountResult.ok) return { ok: false, status: 400, reason: accountResult.reason };
    linkGoogleIdentity(db, verified, accountResult.accountId);
    const token = createSession(db, accountResult.accountId);
    return { ok: true, status: 200, token, accountId: accountResult.accountId, isNew: accountResult.isNew, email: verified.email };
  }

  const ownership = verifyOwnershipOfExistingAccount(db, existingAccount.id, verified.email, opts);
  if (!ownership.ok) return { ok: false, status: 409, reason: ownership.reason };

  linkGoogleIdentity(db, verified, existingAccount.id);
  const token = createSession(db, existingAccount.id);
  return { ok: true, status: 200, token, accountId: existingAccount.id, isNew: false, email: verified.email };
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
