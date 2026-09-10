'use strict';
/**
 * 토스페이먼츠 웹훅 수신 — payment-toss.mjs의 handleTossWebhookEvent를
 * 그대로 부른다. 페이로드 자체를 신뢰하지 않고 반드시 토스 조회 API로
 * 재확인한다는 설계는 그 파일 상단 주석 참고.
 */
import { handleTossWebhookEvent } from '../adapters/payment-toss.mjs';

export async function handleTossWebhook(rawBody) {
  let body;
  try { body = JSON.parse(rawBody); } catch (e) { return { ok: false, status: 400, reason: 'invalid-json' }; }
  return handleTossWebhookEvent(body);
}
