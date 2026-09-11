'use strict';
/**
 * AI 보조 분류 배치 라우트(2026-09-11 재검토 10차 5·6절).
 *
 * 원칙(요구사항 그대로):
 * - 규칙(클라이언트의 daInfer/daInferTags)으로 해결되는 항목은 애초에
 *   이 라우트까지 오지 않는다 — 클라이언트가 "미분류로 남은 항목만"
 *   골라서 보낸다(이 라우트는 그걸 신뢰하고 별도 재확인은 안 한다 —
 *   재확인하려면 또 다른 유료 조회가 필요해질 수 있어서다).
 * - 핵심 제공량(위치확인·코스생성) 예산을 먼저 확보한 뒤 AI 여유를
 *   계산한다(entitlement-usage.mjs의 aiClassifyBudgetHeadroomMicros).
 * - 계정당 하루 배치 횟수 상한 + 배치당 최대 항목 수 상한.
 * - AI가 비활성/예산 부족/공급자 오류여도 라우트 자체는 정직한 사유로
 *   응답할 뿐 서버 오류를 던지지 않는다 — 클라이언트는 이 실패를 보고
 *   규칙 기반 결과와 수동 편집으로 계속 쓸 수 있어야 한다.
 */
import { config } from '../config.mjs';
import { classifyBatch } from '../adapters/ai-classify.mjs';
import { chargeCost, describeCostFailure } from '../cost-ledger.mjs';
import { currentPeriod, aiClassifyBudgetHeadroomMicros } from '../entitlement-usage.mjs';
import { checkAndIncrement, dayWindow } from '../rate-limit.mjs';

/* 입력 최소화 — name/note/address 외의 필드(연락처·정밀 GPS·계정
   식별자 등)는 여기서 아예 걸러낸다. 클라이언트가 실수로 더 많은
   필드를 보내도 어댑터에는 절대 전달되지 않는다. */
function sanitizeItem(x) {
  if (!x || !x.localId) return null;
  return {
    localId: String(x.localId).slice(0, 100),
    name: String(x.name || '').slice(0, 200),
    note: String(x.note || '').slice(0, 300),
    address: String(x.address || '').slice(0, 200),
  };
}

export async function classifyBatchRoute(accountId, items) {
  if (!accountId) return { ok: false, status: 401, reason: 'unauthorized' };
  const list = Array.isArray(items) ? items.map(sanitizeItem).filter(Boolean) : [];
  if (!list.length) return { ok: false, status: 400, reason: 'missing-items' };

  if (config.services.aiClassify === 'disabled') {
    // 2026-09-11 재검토(10차) — "AI 키가 없으면 실제 AI 분류는 미완료로
    // 명시하라"는 지시. 이 사유를 조용히 삼키지 않고 그대로 알려서,
    // 클라이언트가 "AI 결과 없음 = 규칙/수동 편집으로 계속"임을 정확히
    // 알 수 있게 한다.
    return { ok: false, status: 200, reason: 'ai-classify-disabled' };
  }

  const truncated = list.length > config.aiClassify.maxItemsPerBatch;
  const batch = list.slice(0, config.aiClassify.maxItemsPerBatch);

  const dailyKey = `ai-classify:${accountId}`;
  const daily = checkAndIncrement(dailyKey, dayWindow(), config.aiClassify.perAccountDailyBatchLimit, 1);
  if (!daily.allowed) {
    return { ok: false, status: 429, reason: 'ai-classify-daily-batch-limit-reached' };
  }

  const period = currentPeriod(accountId);
  const headroom = aiClassifyBudgetHeadroomMicros(accountId, period);
  if (headroom.headroomMicros <= 0) {
    // 예산 전부가 남은 핵심 제공량(위치확인·코스생성) 몫으로 이미
    // 예약돼 있다 — AI는 그 몫을 절대 갉아먹지 않는다.
    return { ok: false, status: 200, reason: 'ai-classify-no-budget-headroom', detail: headroom };
  }
  const unitMicros = config.aiClassify.placeholderPerItemMicros;
  const maxAffordable = Math.max(0, Math.floor(headroom.headroomMicros / unitMicros));
  if (maxAffordable === 0) {
    return { ok: false, status: 200, reason: 'ai-classify-no-budget-headroom', detail: headroom };
  }
  const affordableBatch = batch.slice(0, maxAffordable);

  const charge = chargeCost({ accountId, service: 'ai-classify', sku: 'ai-classify-batch', count: affordableBatch.length, periodId: period.periodId, periodCapMicros: period.costCapMicros });
  if (!charge.ok) {
    const described = describeCostFailure(charge.reason);
    return { ok: false, status: 200, reason: described.reason, detail: charge.reason };
  }

  const result = await classifyBatch(affordableBatch);
  if (!result.ok) {
    return { ok: false, status: 200, reason: result.reason };
  }
  return {
    ok: true, status: 200,
    results: result.results,
    processedCount: affordableBatch.length,
    skippedForBudget: batch.length - affordableBatch.length,
    truncatedForBatchSize: truncated,
  };
}
