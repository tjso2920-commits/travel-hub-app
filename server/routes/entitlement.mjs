'use strict';
/**
 * 유료 이용권 확인 — 클라이언트는 표시만 하고, 실제 판정은 항상 서버가
 * 한다(코드 검토 ⑧). "결제했다"는 클라이언트 자기 신고를 신뢰하지
 * 않는다 — plan/plan_expires_at은 오직 결제 웹훅(webhook.mjs)이 실제
 * PG 승인을 확인한 뒤에만 바뀐다.
 */
import { openDb } from '../db.mjs';
import { config } from '../config.mjs';

export function checkEntitlement(accountId) {
  const db = openDb();
  const row = db.prepare('SELECT plan, plan_expires_at FROM accounts WHERE id = ?').get(accountId);
  if (!row) return { ok: false, reason: 'account-not-found' };
  const active = row.plan === 'paid' && (!row.plan_expires_at || new Date(row.plan_expires_at).getTime() > Date.now());
  return {
    ok: true,
    plan: active ? 'paid' : 'free',
    expiresAt: row.plan_expires_at,
    price: config.price, // 가격은 항상 서버 설정값을 그대로 보여준다 — 클라이언트에 숫자를 박지 않는다.
  };
}

export function grantEntitlement(accountId, days) {
  const db = openDb();
  const expiresAt = new Date(Date.now() + (days || config.price.periodDays) * 86400000).toISOString();
  db.prepare('UPDATE accounts SET plan = ?, plan_expires_at = ? WHERE id = ?').run('paid', expiresAt, accountId);
  return { ok: true, expiresAt };
}

export function revokeEntitlement(accountId) {
  const db = openDb();
  db.prepare('UPDATE accounts SET plan = ?, plan_expires_at = NULL WHERE id = ?').run('free', accountId);
  return { ok: true };
}
