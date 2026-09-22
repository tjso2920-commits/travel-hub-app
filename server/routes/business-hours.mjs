'use strict';
/**
 * POST /api/places/hours — 코스에 담긴 장소의 영업시간(2026-09-22, 18차
 * 3·4·5절).
 *
 * 지킨 원칙(지시 원문 순서대로):
 * - **위치가 확인된 장소만**: placeId는 이 계정이 서버에서 실제로 확인한
 *   장소(entitlement_place_confirmed / entitlement_place_local_link)일
 *   때만 조회한다. 클라이언트가 보낸 임의의 ID·다른 지점 ID로는 호출하지
 *   않는다(다른 지점 영업시간을 붙이는 사고 방지 + 남의 비용으로 아무
 *   장소나 조회하는 남용 방지).
 * - **버튼을 눌렀을 때만**: 이 라우트는 가져오기·로그인·스크롤·다시
 *   그리기 어디에서도 자동으로 불리지 않는다(클라이언트가 "영업시간
 *   확인" 버튼에서만 부른다 — scripts/test-business-hours-ui.mjs가 확인).
 * - **기존 약속 예산 보호**: 이용권 원가 상한에서 남은 위치확인·코스 생성
 *   몫을 먼저 뗀 여유(optionalFeatureHeadroomMicros) 안에서만, 그리고 그
 *   값을 원가 원장의 원자적 트랜잭션(chargeCostBatch의 periodCapMicros)에
 *   그대로 넘겨 동시 요청끼리도 예약분을 못 넘게 한다(AI 분류와 같은 방식).
 * - **비용 원장 분리**: service 'business-hours', sku
 *   'places-details-enterprise'. 호출하기로 한 순간 기록한다 — 실패·
 *   타임아웃도 청구됐을 수 있으므로 0원 처리하지 않는다.
 * - **요청 병합**: 같은 계정이 같은 장소를 동시에 두 번 요청하면 진행
 *   중인 호출 하나를 나눠 받는다(두 번 청구하지 않음).
 * - **자동 재시도 없음**: 실패는 실패로 돌려주고, 다시 시도는 사용자가
 *   버튼으로만 한다. 최근 실패 직후의 재요청은 'retry'로 따로 센다.
 * - **저장 없음**: 응답을 DB·동기화·로그에 남기지 않는다(adapters/
 *   business-hours.mjs 상단 — 영업시간은 약관상 장기 보관 예외가
 *   확인되지 않았다).
 */
import { openDb } from '../db.mjs';
import { config } from '../config.mjs';
import { chargeCost, describeCostFailure, skuCostMicros, recordApiOutcome } from '../cost-ledger.mjs';
import { currentPeriod, optionalFeatureHeadroomMicros } from '../entitlement-usage.mjs';
import { checkAndIncrement, peek, dayWindow } from '../rate-limit.mjs';
import { fetchBusinessHours } from '../adapters/business-hours.mjs';

const PLACE_ID_RE = /^[A-Za-z0-9_:\-]{1,256}$/;
const SKU = 'places-details-enterprise';
const RETRY_WINDOW_MS = 30 * 60 * 1000;

// 진행 중인 호출만 담는다(끝나면 즉시 지운다) — 결과를 쌓아 두는 캐시가 아니다.
const inFlight = new Map(); // `${accountId}|${placeId}` → Promise<outcome>
// 최근 실패 시각만(내용 없음) — 재시도 건수를 따로 세기 위한 것.
const recentFailures = new Map(); // `${accountId}|${placeId}` → ms

function verifiedPlaceIds(accountId, ids) {
  if (!ids.length) return new Set();
  const db = openDb();
  const marks = ids.map(() => '?').join(',');
  const a = db.prepare(`SELECT real_place_id AS id FROM entitlement_place_confirmed WHERE account_id = ? AND real_place_id IN (${marks})`).all(accountId, ...ids);
  const b = db.prepare(`SELECT real_place_id AS id FROM entitlement_place_local_link WHERE account_id = ? AND real_place_id IN (${marks})`).all(accountId, ...ids);
  return new Set([...a, ...b].map((r) => r.id));
}

function periodScope(accountId) { return `business-hours-period:${accountId}`; }

function toItem(placeId, outcome, fetchedAt) {
  if (outcome.ok) {
    return Object.assign({ fetchedAt, source: outcome.source }, outcome.result, { placeId });
  }
  return { placeId, status: 'failed', reason: outcome.reason || 'failed', fetchedAt };
}

export async function businessHoursRoute(accountId, body) {
  const mode = config.services.businessHours;
  if (mode !== 'real' && mode !== 'test') {
    return { ok: false, status: 200, reason: 'business-hours-disabled' };
  }
  const raw = body && Array.isArray(body.placeIds) ? body.placeIds : null;
  if (!raw || !raw.length) return { ok: false, status: 400, reason: 'placeIds-required' };
  if (raw.length > config.businessHours.maxPlacesPerCall) {
    return { ok: false, status: 400, reason: 'too-many-places', max: config.businessHours.maxPlacesPerCall };
  }
  if (!raw.every((x) => typeof x === 'string' && PLACE_ID_RE.test(x))) {
    return { ok: false, status: 400, reason: 'invalid-placeId' };
  }
  const ids = [...new Set(raw)];
  const verified = verifiedPlaceIds(accountId, ids);
  const items = new Map(); // placeId → 결과(응답 순서는 요청 순서)
  const waits = []; // [placeId, Promise]

  const candidates = [];
  for (const id of ids) {
    if (!verified.has(id)) { items.set(id, { placeId: id, status: 'unverified-place' }); continue; }
    const key = `${accountId}|${id}`;
    const running = inFlight.get(key);
    if (running) { waits.push([id, running]); continue; }
    candidates.push(id);
  }

  // ---- 여기서부터 await 전까지는 동기 코드다: 확인→원장 기록→카운터
  // 증가가 한 덩어리로 끝나야 같은 프로세스의 다른 요청이 사이에 못
  // 끼어든다(원가 원장 자체는 BEGIN IMMEDIATE로 프로세스 간에도 원자적).
  let toCall = candidates.slice();
  let blockedReason = null;
  const period = currentPeriod(accountId);
  if (toCall.length) {
    const periodCap = period.kind === 'paid' ? config.businessHours.paidPeriodPlaceCap : config.businessHours.freePeriodPlaceCap;
    const periodUsed = peek(periodScope(accountId), period.periodId);
    const dailyUsed = peek(`business-hours-daily:${accountId}`, dayWindow());
    const globalUsed = peek('business-hours-global', dayWindow());
    const allow = Math.max(0, Math.min(
      periodCap > 0 ? periodCap - periodUsed : Infinity,
      config.businessHours.perAccountDailyPlaceLimit > 0 ? config.businessHours.perAccountDailyPlaceLimit - dailyUsed : Infinity,
      config.businessHours.globalDailyPlaceCap > 0 ? config.businessHours.globalDailyPlaceCap - globalUsed : Infinity,
    ));
    if (allow < toCall.length) {
      blockedReason = (periodCap > 0 && periodCap - periodUsed < toCall.length) ? 'business-hours-period-cap-reached' : 'business-hours-daily-cap-reached';
      toCall = toCall.slice(0, allow);
    }
    if (toCall.length) {
      const unit = skuCostMicros(SKU);
      const headroom = optionalFeatureHeadroomMicros(accountId, period);
      const affordable = unit > 0 ? Math.floor(headroom.headroomMicros / unit) : toCall.length;
      if (affordable < toCall.length) {
        blockedReason = 'business-hours-budget-reserved-for-core';
        toCall = toCall.slice(0, Math.max(0, affordable));
      }
      if (toCall.length) {
        const cappedPeriodMicros = Math.max(0, headroom.capMicros - headroom.reservedForCoreMicros);
        const charge = chargeCost({ accountId, service: 'business-hours', sku: SKU, count: toCall.length, periodId: period.periodId, periodCapMicros: cappedPeriodMicros });
        if (!charge.ok) {
          blockedReason = describeCostFailure(charge.reason).reason === 'entitlement-cost-cap-reached'
            ? 'business-hours-budget-reserved-for-core'
            : 'cost-budget-exceeded';
          toCall = [];
        } else {
          checkAndIncrement(periodScope(accountId), period.periodId, 0, toCall.length);
          checkAndIncrement(`business-hours-daily:${accountId}`, dayWindow(), 0, toCall.length);
          checkAndIncrement('business-hours-global', dayWindow(), 0, toCall.length);
          recordApiOutcome('business-hours', 'request', toCall.length);
        }
      }
    }
  }
  for (const id of candidates) {
    if (!toCall.includes(id)) items.set(id, { placeId: id, status: 'not-requested', reason: blockedReason || 'business-hours-daily-cap-reached' });
  }
  const now = Date.now();
  if (recentFailures.size > 1000) {
    for (const [k, at] of recentFailures) if (now - at >= RETRY_WINDOW_MS) recentFailures.delete(k);
  }
  for (const id of toCall) {
    const key = `${accountId}|${id}`;
    const failedAt = recentFailures.get(key);
    if (failedAt && now - failedAt < RETRY_WINDOW_MS) recordApiOutcome('business-hours', 'retry', 1);
    const p = fetchBusinessHours(id)
      .catch(() => ({ ok: false, reason: 'network-error' }))
      .then((outcome) => {
        if (outcome.ok) { recentFailures.delete(key); recordApiOutcome('business-hours', 'ok', 1); }
        else { recentFailures.set(key, Date.now()); recordApiOutcome('business-hours', 'fail', 1); }
        return outcome;
      })
      .finally(() => { inFlight.delete(key); });
    inFlight.set(key, p);
    waits.push([id, p]);
  }
  // ---- 동기 구간 끝

  const settled = await Promise.all(waits.map(([, p]) => p));
  const fetchedAt = new Date().toISOString();
  waits.forEach(([id], i) => { items.set(id, toItem(id, settled[i], fetchedAt)); });
  return {
    ok: true,
    status: 200,
    results: ids.map((id) => items.get(id)),
    // 화면 안내용 — 결과는 이 응답 한 번에만 쓰고 저장하지 않는다.
    storage: 'not-stored',
  };
}

// 테스트 전용 — 진행 중 호출 표가 비었는지 확인하는 용도.
export function _inFlightSizeForTest() { return inFlight.size; }
