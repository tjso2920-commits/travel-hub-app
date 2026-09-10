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

  // 2026-09-10: 확정 상품(9,900원/30일, 자동결제 없음) 기준 — 승인은
  // 이용권을 준다. 취소·환불·만료는 전부 이용권을 회수한다는 결과는
  // 같지만, payment_events에 실제 타입이 그대로 남아 나중에 취소/환불/
  // 만료 비율을 구분해 볼 수 있다(권한 처리 로직 자체는 하나로 통일해
  // 셋을 다르게 처리해야 할 이유가 아직 없다 — 다르게 처리해야 할
  // 요구사항이 생기면 여기 분기만 늘리면 된다).
  if (event.type === 'success') grantEntitlement(event.accountId);
  else if (event.type === 'cancel' || event.type === 'refund' || event.type === 'expire') revokeEntitlement(event.accountId);

  return { ok: true, status: 200 };
}
