'use strict';
/**
 * 실제 결제(토스페이먼츠) 라우트 — 주문 생성 → 결제위젯 → 승인 확인 →
 * 취소까지. 계정 식별은 항상 세션 토큰에서만 뽑는다(요청 본문의 계정
 * 값을 신뢰하지 않는다는 서버 전체 원칙과 동일).
 */
import { config } from '../config.mjs';
import { createOrder, confirmPayment, cancelPayment } from '../adapters/payment-toss.mjs';

export function paymentConfigRoute() {
  // 결제위젯 클라이언트 키는 공개 값이라(비밀키가 아니다) 화면에 그대로
  // 내려줘도 안전하다 — 클라이언트 코드에 하드코딩하지 않고 서버가
  // 내려주면 나중에 키를 바꿀 때 배포 코드를 다시 안 만들어도 된다.
  if (config.services.payment !== 'real') return { ok: false, status: 503, reason: 'payment-service-unavailable' };
  return { ok: true, status: 200, clientKey: config.toss.clientKey, amount: config.price.amountKrw, orderName: `travel hub ${config.price.periodDays}일 이용권` };
}

export function createOrderRoute(accountId) {
  if (config.services.payment !== 'real') return { ok: false, status: 503, reason: 'payment-service-unavailable' };
  const r = createOrder(accountId);
  return { ...r, status: 200 };
}

export async function confirmOrderRoute(accountId, body) {
  const { orderId, paymentKey, amount } = body || {};
  if (!orderId || !paymentKey || amount === undefined) return { ok: false, status: 400, reason: 'missing-fields' };
  return confirmPayment({ accountId, orderId, paymentKey, amount });
}

export async function cancelOrderRoute(body) {
  const { paymentKey, cancelReason, cancelAmount } = body || {};
  if (!paymentKey) return { ok: false, status: 400, reason: 'missing-payment-key' };
  return cancelPayment({ paymentKey, cancelReason, cancelAmount });
}
