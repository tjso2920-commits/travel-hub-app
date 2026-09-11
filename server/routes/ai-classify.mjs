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
import crypto from 'node:crypto';
import { config } from '../config.mjs';
import { classifyBatch } from '../adapters/ai-classify.mjs';
import { chargeCost, describeCostFailure } from '../cost-ledger.mjs';
import { currentPeriod, aiClassifyBudgetHeadroomMicros } from '../entitlement-usage.mjs';
import { checkAndIncrement, dayWindow } from '../rate-limit.mjs';
import { openDb, nowIso } from '../db.mjs';

/* 입력 최소화(2026-09-11 재검토 11차 4절) — "이름·이미 확보한 유형 등
   최소 데이터만 사용". 개인 메모(note)는 이 시점부터 기본 AI 입력에서
   완전히 뺀다 — 별도의 명시적 동의 기반 "메모 전송" 기능은 실제로
   필요해지면 따로 만들 사안이지 이 배치의 필수 항목이 아니다.
   confirmedTypes는 이미 장소조회로 확정된 유형(문자열 배열)만 받는다
   — 그 밖의 필드(연락처·정밀 GPS·계정 식별자 등)는 여기서 걸러낸다. */
function sanitizeItem(x) {
  if (!x || !x.localId) return null;
  const confirmedTypes = Array.isArray(x.confirmedTypes)
    ? x.confirmedTypes.map((t) => String(t || '').slice(0, 50)).filter(Boolean).slice(0, 10)
    : [];
  return {
    localId: String(x.localId).slice(0, 100),
    name: String(x.name || '').slice(0, 200),
    address: String(x.address || '').slice(0, 200),
    confirmedTypes,
  };
}

/* 입력 해시 — 이름/주소/확인된 유형만으로 계산한다(메모는 입력에서
   빠졌으니 해시에도 안 들어간다). course-generation.mjs의 requestHash와
   같은 방식(정렬로 순서 흔들림 제거 + sha256). */
function inputHash(item) {
  const material = JSON.stringify({
    name: item.name, address: item.address,
    confirmedTypes: [...item.confirmedTypes].sort(),
  });
  return crypto.createHash('sha256').update(material).digest('hex');
}

/* 캐시 조회/저장 — (계정, 입력해시, 분류버전) 키. 분류 버전이 바뀌면
   기존 캐시는 자동으로 안 맞아 그냥 새로 분류된다(별도 삭제 불필요 —
   PRIMARY KEY에 버전이 포함돼 있어서 새 버전 행이 새로 쌓일 뿐이다). */
function getCachedResult(db, accountId, hash, version) {
  const row = db.prepare('SELECT result FROM ai_classify_cache WHERE account_id = ? AND input_hash = ? AND classification_version = ?').get(accountId, hash, version);
  if (!row) return null;
  try { return JSON.parse(row.result); } catch { return null; }
}
function storeCachedResult(db, accountId, hash, version, result) {
  db.prepare('INSERT OR REPLACE INTO ai_classify_cache (account_id, input_hash, classification_version, result, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(accountId, hash, version, JSON.stringify(result), nowIso());
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
  const version = config.aiClassify.classificationVersion;

  // 캐시 분리(11차 4절) — 입력 해시+분류버전+계정 기준으로 이미 분류된
  // 항목은 AI를 다시 부르지 않고 저장된 결과를 그대로 돌려준다(재가져
  // 오기/재접속/다른 기기에서 같은 항목을 또 보내도 비용·호출이 다시
  // 들지 않는다). 한도·예산 검사는 실제로 새로 분류해야 하는 항목
  // 수만 기준으로 한다 — 캐시 적중은 "실제 AI 호출"이 아니므로 하루
  // 배치 한도·예산을 갉아먹으면 안 된다.
  const db = openDb();
  const cachedResults = [];
  const needsClassification = [];
  const hashByLocalId = new Map();
  for (const item of batch) {
    const hash = inputHash(item);
    hashByLocalId.set(item.localId, hash);
    const cached = getCachedResult(db, accountId, hash, version);
    if (cached) cachedResults.push(cached);
    else needsClassification.push(item);
  }

  if (!needsClassification.length) {
    return {
      ok: true, status: 200,
      results: cachedResults,
      processedCount: 0,
      cachedCount: cachedResults.length,
      skippedForBudget: 0,
      truncatedForBatchSize: truncated,
    };
  }

  const dailyKey = `ai-classify:${accountId}`;
  const daily = checkAndIncrement(dailyKey, dayWindow(), config.aiClassify.perAccountDailyBatchLimit, 1);
  if (!daily.allowed) {
    return { ok: false, status: 429, reason: 'ai-classify-daily-batch-limit-reached' };
  }
  // 전체(서비스 전역) 한도 — 계정 한도를 이미 통과한 요청만 확인한다
  // (places.mjs checkLimits와 같은 순서: 계정에서 먼저 걸리면 전체
  // 한도 카운터 자체를 건드리지 않는다).
  const global = checkAndIncrement('ai-classify:global', dayWindow(), config.aiClassify.globalDailyBatchLimit, 1);
  if (!global.allowed) {
    return { ok: false, status: 503, reason: 'ai-classify-service-daily-cap-reached' };
  }

  const period = currentPeriod(accountId);
  const headroom = aiClassifyBudgetHeadroomMicros(accountId, period);
  if (headroom.headroomMicros <= 0) {
    // 예산 전부가 남은 핵심 제공량(위치확인·코스생성) 몫으로 이미
    // 예약돼 있다 — AI는 그 몫을 절대 갉아먹지 않는다.
    return { ok: false, status: 200, reason: 'ai-classify-no-budget-headroom', detail: headroom, cachedResults: cachedResults.length ? cachedResults : undefined };
  }
  const unitMicros = config.aiClassify.placeholderPerItemMicros;
  const maxAffordable = Math.max(0, Math.floor(headroom.headroomMicros / unitMicros));
  if (maxAffordable === 0) {
    return { ok: false, status: 200, reason: 'ai-classify-no-budget-headroom', detail: headroom, cachedResults: cachedResults.length ? cachedResults : undefined };
  }
  const affordableBatch = needsClassification.slice(0, maxAffordable);

  // 2026-09-11 재검토(11차) — 헤드룸을 "읽기"와 실제 charge를 "쓰기"로
  // 나눠서 하던 이전 방식은, 동시에 들어온 두 AI 분류 요청이 같은
  // (스테일해질 수 있는) 헤드룸을 각자 보고 판단해 버리면 원자적
  // 트랜잭션(chargeCostBatch의 BEGIN IMMEDIATE)이 지키는 건 "원래
  // 전체 상한"뿐이라 AI 몫으로 예약된 핵심 제공량 헤드룸까지는 못
  // 지키는 문제가 있었다. periodCapMicros 자체를 "헤드룸이 반영된
  // 상한"(전체 상한 - 핵심 제공량 예약분)으로 줄여서 넘기면,
  // chargeCostBatch가 이미 갖고 있는 그 원자적 트랜잭션이 곧바로 AI
  // 헤드룸 경계까지 지켜준다(새 잠금 로직을 따로 만들 필요가 없다).
  // reservedForCoreMicros 자체가 동시 요청 중에 살짝 stale해질 수는
  // 있지만, 남은 사용량은 기간 내에서 늘지 않고 줄기만 하므로 그
  // 방향의 오차는 "더 보수적으로 예약함"쪽이라 안전하다.
  const headroomAdjustedCapMicros = Math.max(0, headroom.capMicros - headroom.reservedForCoreMicros);
  const charge = chargeCost({ accountId, service: 'ai-classify', sku: 'ai-classify-batch', count: affordableBatch.length, periodId: period.periodId, periodCapMicros: headroomAdjustedCapMicros });
  if (!charge.ok) {
    const described = describeCostFailure(charge.reason);
    return { ok: false, status: 200, reason: described.reason, detail: charge.reason, cachedResults: cachedResults.length ? cachedResults : undefined };
  }

  const result = await classifyBatch(affordableBatch);
  if (!result.ok) {
    return { ok: false, status: 200, reason: result.reason, cachedResults: cachedResults.length ? cachedResults : undefined };
  }
  for (const r of result.results) {
    const hash = hashByLocalId.get(r.localId);
    if (hash) storeCachedResult(db, accountId, hash, version, r);
  }
  return {
    ok: true, status: 200,
    results: [...cachedResults, ...result.results],
    processedCount: affordableBatch.length,
    cachedCount: cachedResults.length,
    skippedForBudget: needsClassification.length - affordableBatch.length,
    truncatedForBatchSize: truncated,
  };
}
