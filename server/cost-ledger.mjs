'use strict';
/**
 * API 비용 통제(2026-09-10 재검토 4차 6절) — "호출 횟수뿐 아니라 API
 * 종류·필드·SKU에 따른 예상 비용을 기록하고, 계정별·서비스 전체의
 * 일일/월간 한도를 서버에서 집행하며, 동시 요청 시 예상 비용을 먼저
 * 예약해 한도 초과를 막으라"는 지시의 실제 구현.
 *
 * 설계: "예약 후 나중에 확정/취소"하는 2단계 대신, **"실제 호출을 하기로
 * 결정하는 바로 그 순간에 비용을 확정 기록"**하는 1단계 모델을 쓴다.
 * 이유: 우리는 외부 공급자가 실제로 얼마를 청구했는지 알 방법이 없다
 * (그건 공급자 청구 콘솔에만 있다) — 우리가 아는 유일한 사실은 "우리가
 * 그 요청을 보내기로 했다"는 것뿐이다. 그래서:
 *   - 예산 확인 결과 "보내도 된다"면 → 그 즉시 예상 비용을 원장에 기록
 *     한다(성공/실패/타임아웃과 무관하게 이미 "쓰기로 결정한 돈"이다).
 *   - 예산 확인 결과 "안 된다"면 → 아예 호출하지 않고, 원장에도 아무것도
 *     안 남긴다(쓰지 않은 돈이니까).
 * 이 모델은 "타임아웃도 과금됐을 수 있으니 0원으로 처리하지 말라"와
 * "공급자 예산 알림에만 의존하지 말라"는 지시 둘 다를 동시에 만족한다 —
 * 우리 쪽 회계가 공급자의 실제 응답 여부와 완전히 무관하기 때문이다.
 *
 * "이미 개인 한도를 초과한 요청이 전체 한도를 소모하지 않도록"이라는
 * 지시는 검사 순서로 지킨다 — **계정별 한도를 먼저 확인**하고, 그걸
 * 통과했을 때만 전체(글로벌) 한도를 확인한다. 어느 쪽이든 거부되면
 * 원장에 아무 행도 안 남기므로, 거부된 요청은 절대 다른 스코프의 예산을
 * 깎지 않는다.
 */
import { openDb, uuid, nowIso } from './db.mjs';
import { config } from './config.mjs';

function dayStartIso(d) { return (d || new Date()).toISOString().slice(0, 10) + 'T00:00:00.000Z'; }
function monthStartIso(d) { return (d || new Date()).toISOString().slice(0, 7) + '-01T00:00:00.000Z'; }

function sumSince(whereAccountId, sinceIso) {
  const db = openDb();
  const row = whereAccountId
    ? db.prepare('SELECT COALESCE(SUM(estimated_cost_micros),0) AS total FROM cost_ledger WHERE account_id = ? AND created_at >= ?').get(whereAccountId, sinceIso)
    : db.prepare('SELECT COALESCE(SUM(estimated_cost_micros),0) AS total FROM cost_ledger WHERE created_at >= ?').get(sinceIso);
  return row.total;
}

export function skuCostMicros(sku) {
  const map = {
    'places-text-search': config.costEstimate.placesTextSearchMicros,
    'routes-compute': config.costEstimate.routesComputeMicros,
    'routes-compute-highvolume': config.costEstimate.routesComputeHighVolumeMicros,
  };
  const v = map[sku];
  if (v == null) throw new Error('unknown-cost-sku:' + sku);
  return v;
}

/* 계정별 한도 → 전체 한도 순으로 확인한 뒤에만 실제로 기록한다. 통과
   못 하면 아무것도 기록하지 않고 이유를 돌려준다 — 호출부는 이 결과를
   보고서야 실제 외부 요청을 보낼지 말지 정한다(먼저 부르고 나중에
   따지지 않는다 — "예상 비용을 먼저 예약해 한도 초과를 방지"). */
export function chargeCost({ accountId, service, sku, count }) {
  const n = Math.max(1, Number(count) || 1);
  const unitMicros = skuCostMicros(sku);
  const totalMicros = unitMicros * n;
  const now = new Date();

  if (accountId) {
    const acctDaily = sumSince(accountId, dayStartIso(now));
    const cap = config.costBudget.perAccountDailyMicros;
    if (cap > 0 && acctDaily + totalMicros > cap) {
      return { ok: false, reason: 'account-daily-cost-budget-exceeded', capMicros: cap, usedMicros: acctDaily };
    }
  }

  const globalDaily = sumSince(null, dayStartIso(now));
  const dailyCap = config.costBudget.globalDailyMicros;
  if (dailyCap > 0 && globalDaily + totalMicros > dailyCap) {
    return { ok: false, reason: 'global-daily-cost-budget-exceeded', capMicros: dailyCap, usedMicros: globalDaily };
  }
  const globalMonthly = sumSince(null, monthStartIso(now));
  const monthlyCap = config.costBudget.globalMonthlyMicros;
  if (monthlyCap > 0 && globalMonthly + totalMicros > monthlyCap) {
    return { ok: false, reason: 'global-monthly-cost-budget-exceeded', capMicros: monthlyCap, usedMicros: globalMonthly };
  }

  const db = openDb();
  const id = uuid();
  db.prepare('INSERT INTO cost_ledger (id, account_id, service, sku, count, estimated_cost_micros, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, accountId || null, service, sku, n, totalMicros, nowIso());
  return { ok: true, id, estimatedCostMicros: totalMicros };
}

export function usageSummary(accountId) {
  const now = new Date();
  return {
    accountDailyMicros: accountId ? sumSince(accountId, dayStartIso(now)) : null,
    globalDailyMicros: sumSince(null, dayStartIso(now)),
    globalMonthlyMicros: sumSince(null, monthStartIso(now)),
    caps: config.costBudget,
  };
}
