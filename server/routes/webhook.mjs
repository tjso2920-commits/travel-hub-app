'use strict';
/**
 * 결제 웹훅 수신 — PG가 서명한 요청만 처리한다. 서명이 틀리면 그 자리에서
 * 거부한다(요청 본문만 보고 계정 상태를 바꾸지 않는다 — 서명 검증
 * 통과가 유일한 신뢰 근거다).
 *
 * 멱등성(idempotency): 같은 이벤트가 네트워크 재시도로 두 번 들어와도
 * payment_events.id가 PRIMARY KEY라 두 번째는 자동으로 막힌다(trial.mjs
 * 와 같은 패턴 — DB 제약으로 중복 처리를 막는다).
 */
import { openDb, nowIso } from '../db.mjs';
import { verifyWebhookSignature, normalizeWebhookEvent } from '../adapters/payment.mjs';
import { grantEntitlement, revokeEntitlement } from './entitlement.mjs';

export function handleWebhook(rawBody, signatureHeader) {
  if (!verifyWebhookSignature(rawBody, signatureHeader)) {
    return { ok: false, status: 401, reason: 'invalid-signature' };
  }
  let body;
  try { body = JSON.parse(rawBody); } catch (e) { return { ok: false, status: 400, reason: 'invalid-json' }; }
  const event = normalizeWebhookEvent(body);
  if (!event.id || !event.accountId) return { ok: false, status: 400, reason: 'missing-fields' };

  const db = openDb();
  try {
    db.prepare('INSERT INTO payment_events (id, account_id, type, raw, received_at) VALUES (?, ?, ?, ?, ?)')
      .run(event.id, event.accountId, event.type, rawBody, nowIso());
  } catch (e) {
    return { ok: true, status: 200, reason: 'duplicate-event-ignored' }; // 이미 처리한 이벤트 — 성공으로 응답(PG가 재시도를 멈추게).
  }

  if (event.type === 'success') grantEntitlement(event.accountId);
  else if (event.type === 'cancel' || event.type === 'expire') revokeEntitlement(event.accountId);

  return { ok: true, status: 200 };
}
