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
  // 2026-09-10 재검토(5차) — 예전엔 실패 응답(예: 409 already-has-active-
  // entitlement, 503 service-unavailable-for-new-sales)에도 무조건
  // status:200을 덮어써서, 실패했는데도 클라이언트에는 200으로 갔다.
  // createOrder는 실패 시 이미 자기 status를 들고 있으니 그대로 쓴다 —
  // 성공(status 없음)일 때만 200을 채운다.
  if (!r.ok) return r;
  return { ...r, status: 200 };
}

export async function confirmOrderRoute(accountId, body) {
  const { orderId, paymentKey, amount, currency } = body || {};
  if (!orderId || !paymentKey || amount === undefined) return { ok: false, status: 400, reason: 'missing-fields' };
  return confirmPayment({ accountId, orderId, paymentKey, amount, currency });
}

// 2026-09-10 재검토(4차): accountId를 반드시 세션에서 받아 넘긴다 — 예전엔
// 로그인 여부만 확인하고 이 값을 안 넘겨서 다른 계정의 주문도 취소할 수
// 있었다(cancelPayment가 이제 이 값으로 주문 소유자를 대조한다).
export async function cancelOrderRoute(accountId, body) {
  const { paymentKey, cancelReason, cancelAmount } = body || {};
  if (!paymentKey) return { ok: false, status: 400, reason: 'missing-payment-key' };
  return cancelPayment({ accountId, paymentKey, cancelReason, cancelAmount });
}
