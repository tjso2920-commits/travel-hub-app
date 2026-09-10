'use strict';
/**
 * 토스페이먼츠 결제위젯 연동 — 실제 결제 어댑터.
 *
 * **중요한 한계 고지**: 이 세션은 네트워크 정책상
 * `docs.tosspayments.com`에 직접 접속하지 못했다(WebFetch가
 * EGRESS_BLOCKED로 거부됨). 아래 엔드포인트·필드명·인증 방식은 학습된
 * 지식을 기준으로 작성한 것이지, 이 세션에서 공식 문서를 다시 대조해
 * 확인한 것이 아니다 — **실제 시크릿 키를 넣기 전에 반드시 사람이
 * docs.tosspayments.com에서 현재 문서와 한 줄씩 대조해야 한다.**
 * 특히 웹훅 페이로드의 정확한 필드명·서명 방식은 실제 토스 개발자
 * 콘솔에서 테스트 웹훅을 한 번 받아보기 전까지 확신할 수 없다 — 그래서
 * 이 구현은 웹훅 페이로드 자체를 신뢰하지 않고, 웹훅이 오면 반드시
 * 토스의 조회 API를 다시 불러 실제 상태를 확인한 뒤에만 이용권을
 * 반영한다(서명 검증에만 의존하는 것보다 보수적인 설계 — "현재 자체
 * HMAC 웹훅 틀이 토스 규격과 같다고 가정하지 말라"는 지시를 정확히
 * 지키는 방법이라고 판단했다).
 *
 * 학습 지식 기준 요약(재확인 필요):
 * - 결제 승인: POST {apiBase}/v1/payments/confirm, Basic 인증(시크릿
 *   키를 사용자명으로, 비밀번호는 빈 문자열 — `Basic base64(secretKey+':')`),
 *   본문 {paymentKey, orderId, amount}. 성공 시 결제 객체(status가
 *   'DONE'이면 승인 완료) 반환.
 * - 결제 조회: GET {apiBase}/v1/payments/{paymentKey}.
 * - 결제 취소: POST {apiBase}/v1/payments/{paymentKey}/cancel, 본문
 *   {cancelReason, cancelAmount?}.
 * - 이미 처리된 결제를 다시 confirm하면 오류 코드가 온다(정확한 코드
 *   문자열은 재확인 필요 — 여기서는 HTTP 상태와 함께 원문을 그대로
 *   기록해 나중에 실제 응답을 보고 분기를 정확히 맞출 수 있게 했다).
 */
import { openDb, uuid, nowIso } from '../db.mjs';
import { config } from '../config.mjs';
import { grantEntitlement, revokeEntitlement } from '../routes/entitlement.mjs';
import { markVerified } from '../status.mjs';

function authHeader() {
  return 'Basic ' + Buffer.from(`${config.toss.secretKey}:`).toString('base64');
}

export function orderName() {
  return `travel hub ${config.price.periodDays}일 이용권`;
}

/* 주문을 서버가 먼저 만들어 둔다 — 금액·orderId를 서버가 authoritative
   하게 쥐고 있어야, 나중에 confirm 단계에서 "클라이언트가 부른 금액"이
   아니라 "서버가 애초에 정한 금액"과 실제 승인 금액을 대조할 수 있다
   (클라이언트가 요청 본문의 amount를 조작해도 서버가 안 믿는다). */
export function createOrder(accountId) {
  const db = openDb();
  const orderId = 'order_' + uuid();
  const amount = config.price.amountKrw;
  const now = nowIso();
  db.prepare('INSERT INTO orders (order_id, account_id, amount, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(orderId, accountId, amount, 'pending', now, now);
  return { ok: true, orderId, amount, orderName: orderName() };
}

function getOrder(orderId) {
  const db = openDb();
  return db.prepare('SELECT * FROM orders WHERE order_id = ?').get(orderId);
}

async function tossFetch(pathname, init) {
  const res = await fetch(`${config.toss.apiBase}${pathname}`, {
    ...init,
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json', ...(init && init.headers) },
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* 본문 없음 */ }
  return { ok: res.ok, status: res.status, json };
}

export async function queryPayment(paymentKey) {
  if (config.services.payment !== 'real') return { ok: false, reason: 'payment-service-not-real' };
  try {
    return await tossFetch(`/v1/payments/${encodeURIComponent(paymentKey)}`, { method: 'GET' });
  } catch (e) {
    return { ok: false, reason: 'network-error', detail: String(e && e.message) };
  }
}

/* 승인 — accountId는 반드시 세션 토큰에서 뽑은 값을 넘겨야 한다(요청
   본문의 값을 신뢰하지 않는다는 이 서버 전체의 원칙과 동일). 주문의
   소유자가 그 계정이 맞는지, 금액이 서버가 애초에 정한 값과 같은지
   전부 여기서 확인한 뒤에만 실제 토스 API를 부른다. */
export async function confirmPayment({ accountId, orderId, paymentKey, amount }) {
  if (config.services.payment !== 'real') return { ok: false, status: 503, reason: 'payment-service-unavailable' };
  const order = getOrder(orderId);
  if (!order) return { ok: false, status: 404, reason: 'order-not-found' };
  if (order.account_id !== accountId) return { ok: false, status: 403, reason: 'order-account-mismatch' };
  if (Number(amount) !== order.amount) return { ok: false, status: 400, reason: 'amount-mismatch' };
  if (order.status === 'paid') return { ok: true, status: 200, alreadyProcessed: true };

  let res;
  try {
    res = await tossFetch('/v1/payments/confirm', {
      method: 'POST',
      body: JSON.stringify({ paymentKey, orderId, amount: order.amount }),
    });
  } catch (e) {
    return { ok: false, status: 502, reason: 'network-error', detail: String(e && e.message) };
  }

  const db = openDb();
  if (!res.ok) {
    db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE order_id = ?').run('failed', nowIso(), orderId);
    return { ok: false, status: res.status, reason: 'toss-confirm-failed', detail: res.json };
  }
  const status = res.json && res.json.status;
  if (status !== 'DONE') {
    db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE order_id = ?').run('failed', nowIso(), orderId);
    return { ok: false, status: 502, reason: 'unexpected-payment-status', detail: status };
  }
  db.prepare('UPDATE orders SET status = ?, payment_key = ?, updated_at = ? WHERE order_id = ?')
    .run('paid', paymentKey, nowIso(), orderId);
  grantEntitlement(accountId);
  markVerified('payment');
  return { ok: true, status: 200 };
}

export async function cancelPayment({ paymentKey, cancelReason, cancelAmount }) {
  if (config.services.payment !== 'real') return { ok: false, status: 503, reason: 'payment-service-unavailable' };
  const db = openDb();
  const order = db.prepare('SELECT * FROM orders WHERE payment_key = ?').get(paymentKey);
  if (!order) return { ok: false, status: 404, reason: 'order-not-found' };

  let res;
  try {
    res = await tossFetch(`/v1/payments/${encodeURIComponent(paymentKey)}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ cancelReason: cancelReason || '사용자 요청', ...(cancelAmount ? { cancelAmount } : {}) }),
    });
  } catch (e) {
    return { ok: false, status: 502, reason: 'network-error', detail: String(e && e.message) };
  }
  if (!res.ok) return { ok: false, status: res.status, reason: 'toss-cancel-failed', detail: res.json };

  db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE order_id = ?').run('cancelled', nowIso(), order.order_id);
  revokeEntitlement(order.account_id);
  return { ok: true, status: 200 };
}

/* 웹훅 — 페이로드 자체(서명이든 필드값이든)를 신뢰하지 않는다. 페이로드
   에서 paymentKey로 추정되는 값을 뽑아 반드시 조회 API로 실제 상태를
   다시 확인한 뒤에만 반영한다. 실제 토스 웹훅 페이로드 모양을 이
   세션에서 확인 못 했으므로 흔히 쓰이는 후보 필드 경로 몇 가지를
   방어적으로 시도한다 — 실제 페이로드를 받아 보면 이 목록을 정확히
   좁혀야 한다. */
export async function handleTossWebhookEvent(body) {
  const paymentKey = body.paymentKey || (body.data && body.data.paymentKey) || null;
  if (!paymentKey) return { ok: false, status: 400, reason: 'missing-payment-key' };

  const result = await queryPayment(paymentKey);
  if (!result.ok || !result.json) return { ok: false, status: 502, reason: 'toss-query-failed' };
  const payment = result.json;
  const orderId = payment.orderId;
  const db = openDb();
  const order = orderId ? db.prepare('SELECT * FROM orders WHERE order_id = ?').get(orderId) : null;
  if (!order) return { ok: false, status: 404, reason: 'order-not-found' };

  if (payment.status === 'DONE' && order.status !== 'paid') {
    db.prepare('UPDATE orders SET status = ?, payment_key = ?, updated_at = ? WHERE order_id = ?')
      .run('paid', paymentKey, nowIso(), orderId);
    grantEntitlement(order.account_id);
  } else if ((payment.status === 'CANCELED' || payment.status === 'PARTIAL_CANCELED') && order.status === 'paid') {
    db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE order_id = ?').run('cancelled', nowIso(), orderId);
    revokeEntitlement(order.account_id);
  }
  return { ok: true, status: 200 };
}
