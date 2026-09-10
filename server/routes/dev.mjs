'use strict';
/**
 * 개발/테스트 전용 라우트 — config.testMode가 아니면 전부 즉시 거부한다.
 *
 * 실제 결제창(PG) 연동 전에도 "로그인 → 이용권 확인 → 결제 → 코스로
 * 복귀"라는 짧은 구매 흐름 전체를 실제로 눌러보고 테스트할 수 있어야
 * 한다. 그렇다고 클라이언트가 "결제했다"고 스스로 신고하게 만들면
 * 실제 웹훅 검증 코드 경로를 안 타게 되어 정작 확인해야 할 걸 못
 * 확인한다 — 그래서 이 엔드포인트는 클라이언트가 결제를 "선언"하는
 * 게 아니라, 서버가 스스로 서명한 가짜 웹훅을 만들어 실제
 * handleWebhook()에 흘려보낸다(서명 검증·멱등성·이용권 반영까지
 * 전부 진짜 코드 경로를 그대로 탄다 — 페이로드 출처만 다르다).
 */
import { config } from '../config.mjs';
import { uuid } from '../db.mjs';
import { signPayload } from '../adapters/payment.mjs';
import { handleWebhook } from './webhook.mjs';

export function simulatePayment(accountId, outcome) {
  if (!config.testMode) return { ok: false, status: 403, reason: 'test-mode-only' };
  if (!accountId) return { ok: false, status: 400, reason: 'missing-account' };
  const type = outcome === 'cancel' ? 'cancel' : 'success';
  const payload = JSON.stringify({ event_id: 'sim_' + uuid(), account_id: accountId, type });
  const signature = signPayload(payload, config.webhookSecret);
  const result = handleWebhook(payload, signature);
  return { ok: result.ok, status: result.status, simulated: true, type };
}
