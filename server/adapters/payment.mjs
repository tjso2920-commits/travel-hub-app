'use strict';
/**
 * 결제 웹훅 서명 검증 — "클라이언트가 결제했다고 스스로 신고하는 방식은
 * 조작 가능해서 안 된다"(코드 검토 ⑧). 결제 성공 자체는 결제대행사(PG)의
 * 웹훅을 서버가 직접 받아서만 인정한다.
 *
 * 실제 PG(토스페이먼츠·아임포트 등)마다 서명 방식이 조금씩 다르지만,
 * 공통 패턴은 "PG가 비밀키로 서명한 HMAC을 헤더에 실어 보내고, 우리
 * 서버가 같은 비밀키로 같은 계산을 해서 값이 일치하는지 본다"는 것이다.
 * 이 어댑터는 그 공통 패턴을 실제로 구현해 뒀다 — 실제 PG로 전환할 때는
 * 그 PG의 정확한 서명 헤더 이름·해시 방식만 맞추면 된다.
 *
 * 타이밍 공격 방지: crypto.timingSafeEqual로 비교한다(단순 === 비교는
 * 서명 비교에 쓰면 안 된다 — 문자열이 몇 번째 글자에서 틀렸는지가
 * 비교에 걸리는 시간 차이로 새어 나갈 수 있다).
 */
import crypto from 'node:crypto';
import { config } from '../config.mjs';

export function signPayload(payload, secret) {
  return crypto.createHmac('sha256', secret || config.webhookSecret).update(payload).digest('hex');
}

export function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!signatureHeader) return false;
  const expected = signPayload(rawBody, config.webhookSecret);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(String(signatureHeader), 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* 웹훅 본문을 정규화한다 — 실제 PG마다 필드명이 다르므로, 실제 PG로
   전환할 때 이 함수 안의 필드 매핑만 바꾸면 나머지(서명 검증·DB 반영)는
   그대로 재사용된다. 테스트 모드에서는 우리가 정한 최소 스키마를 그대로 쓴다. */
export function normalizeWebhookEvent(body) {
  return {
    id: String(body.event_id || body.id || ''),
    accountId: String(body.account_id || body.merchant_uid || ''),
    // 'success' | 'cancel' | 'refund' | 'expire' — 2026-09-10: 확정 상품은
    // 자동결제 없는 1회성 이용권이라 "구독 취소"는 없다. 그래도 실제 PG마다
    // 용어가 달라(결제 자체가 실패/취소된 경우 vs 이미 승인된 결제를 나중에
    // 환불한 경우) cancel/refund를 별개 타입으로 구분해 둔다 — 둘 다 이용권을
    // 회수한다는 결과는 같지만, payment_events.type에 실제 어느 쪽이었는지는
    // 남아야 나중에 "취소가 많은지 환불이 많은지"를 구분해 볼 수 있다.
    type: String(body.type || body.status || ''),
  };
}
