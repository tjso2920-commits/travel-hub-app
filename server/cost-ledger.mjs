'use strict';
/**
 * API 비용 통제(2026-09-10 재검토 4차 6절) — "호출 횟수뿐 아니라 API
 * 종류·필드·SKU에 따른 예상 비용을 기록하고, 계정별·서비스 전체의
 * 일일/월간 한도를 서버에서 집행하며, 동시 요청 시 예상 비용을 먼저
 * 예약해 한도 초과를 막으라"는 지시의 실제 구현.
 *
 * 설계: "예약 후 나중에 확정/취소"하는 2단계 대신, **"실제 호출을 하기로
 * 결정하는 바로 그 순간에 비용을 확정 기록"**하는 1단계 모델을 쓴다.
 * 우리는 외부 공급자가 실제로 얼마를 청구했는지 알 방법이 없다 — 우리가
 * 아는 유일한 사실은 "우리가 그 요청(들)을 보내기로 했다"는 것뿐이다.
 * 그래서 예산 확인을 통과했을 때만 그 즉시 예상 비용을 원장에 기록한다
 * (성공/실패/타임아웃과 무관 — "타임아웃도 과금됐을 수 있으니 0원
 * 처리하지 말라"는 지시를 이 설계로 만족한다).
 *
 * **2026-09-10 재검토(5차) — ChatGPT가 재현한 버그를 고침**: 여러 번의
 * 외부 호출이 필요한 작업(예: Google Routes 경유지 상한 때문에 나뉘는
 * 여러 세그먼트)에서 이전 버전은 세그먼트마다 `chargeCost`를 따로
 * 호출했다 — 앞쪽 세그먼트는 예산을 통과해 기록되고, 뒤쪽 세그먼트에서
 * 예산이 모자라 전체 작업이 취소돼도 앞쪽에서 이미 기록된 비용은
 * 남았다(실제 호출은 결국 한 번도 안 나갔는데 원장에는 비용이 남는
 * 모순). 이제 여러 건을 한 번에 확인·기록하는 `chargeCostBatch`를
 * 추가했다 — **하나의 DB 트랜잭션**으로 전체 계획의 비용을 먼저 다
 * 확인하고, 전부 통과할 때만 전부 기록한다(all-or-nothing). 하나라도
 * 예산을 넘으면 그 무엇도 기록되지 않는다.
 *
 * **동시 요청·여러 프로세스 안전성**: `BEGIN IMMEDIATE`로 트랜잭션을
 * 열어 SQLite 파일 수준의 쓰기 잠금을 즉시 확보한다 — 같은 DB 파일을
 * 쓰는 다른 프로세스가 있어도(수평 확장 구성) 그 프로세스의 확인·기록
 * 사이에 우리가 끼어들 수 없다(반대도 마찬가지). 단, 이건 "같은 SQLite
 * 파일에 쓰기 잠금이 걸린다"는 보장이지 — 여러 DB 파일로 완전히 분리된
 * 다중 인스턴스 구성(각자 다른 SQLite 파일)에서는 예산이 인스턴스별로
 * 따로 집계된다. **지원하는 운영 구성은 "하나의 SQLite 파일을 공유하는
 * 프로세스(들)"뿐이다** — 완전히 분리된 DB로 수평 확장하려면 이 비용
 * 원장을 별도의 공유 저장소(예: 별도 RDBMS)로 옮겨야 한다(지금 범위
 * 밖).
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

/* 2026-09-10 재검토(6차) — 계정의 "이용권 기간"(무료체험 평생 1회 또는
   유료 이용권 주문 하나) 안에서 누적된 실제 원가. 달력 일/월과 무관하게
   그 period_id로 남은 기록만 더한다 — 30일 이용권이 달력월을 넘어가도
   이 합계는 안 흔들린다(같은 period_id로 계속 누적될 뿐). */
export function periodCostMicros(accountId, periodId) {
  if (!accountId || !periodId) return 0;
  const db = openDb();
  const row = db.prepare('SELECT COALESCE(SUM(estimated_cost_micros),0) AS total FROM cost_ledger WHERE account_id = ? AND period_id = ?').get(accountId, periodId);
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

/* 여러 건(charges: [{sku, count}])의 비용을 하나의 트랜잭션으로 확인·
   기록한다. 계정별 일일→계정별 월간→전체 일일→전체 월간 순으로 확인한다
   (계정 한도가 먼저 걸리면 전체 한도 쪽 숫자는 아예 안 건드린다 — "이미
   개인 한도를 초과한 요청이 전체 한도를 소모하지 않도록"). 하나라도
   막히면 즉시 ROLLBACK하고 그 무엇도 기록하지 않는다 — 앞선 항목이
   먼저 "통과"했다고 미리 기록해 두지 않는다(부분 기록 버그 재현 방지). */
/* 2026-09-10 재검토(6차) — periodId/periodCapMicros가 있으면(호출부인
   entitlement-usage.mjs가 이 계정의 지금 이용권 기간과 그 기간의 내부
   원가 안전상한을 판단해 넘긴다) 계정/전체 한도에 더해 "이 이용권
   기간 하나가 누적으로 쓴 원가"도 같은 트랜잭션 안에서 확인한다 —
   무료체험은 평생 누적 700원, 유료는 이용권(주문) 하나당 누적
   3,500원(제안값, 확정 아님 — config.costSafetyCap). 이건 계정별
   일일/월간 한도와는 다른 층위의 안전판이다(계정 한도는 "이 계정이
   하루/한 달에 얼마나 쓰는지", 이 상한은 "이 계정에게 약속한 사용량
   전체가 원가 몇 원 안에 들어오는지").

   2026-09-10 재검토(7차) 3절 — "하루 비용 제한과 판매 약속의 충돌
   해결." 예전엔 계정별 일일 한도(perAccountDailyMicros, 기본 500원)가
   무료/유료 구분 없이 똑같이 적용됐다. 위치확인 단가(약 44.8원/건)
   기준 500원은 11건 만에 소진돼, 유료 이용권이 약속한 "하루 안에
   50곳+코스 생성"을 몰아 쓰는 것 자체가 애초에 불가능했다 — 이건
   의도한 정책이 아니라 무료체험 크기(10곳+코스1회≈500원 이내)에 맞춰
   정한 값을 유료에도 그대로 재사용한 버그였다.

   고친 방식: periodCapMicros가 주어지면(이 계정의 지금 이용권 기간
   전체에 허용된 누적 원가 — 무료 700원 또는 유료 3,500원), 계정별
   일일/월간 한도를 "설정된 기본값과 이 periodCapMicros 중 더 큰 쪽"
   으로 끌어올린다. 즉 이 계정이 자기 이용권 전체 몫을 단 하루 안에
   몰아 써도 일일/월간 한도가 그것보다 먼저 걸리는 일이 없다 — 실제
   상한은 여전히 periodCapMicros(이용권 기간 전체 누적, 절대 안
   초기화됨)가 진짜 천장 역할을 하므로 "하루에 다 몰아 써도 되지만
   이용권이 약속한 만큼만"이라는 원칙은 그대로 지켜진다. 짧은 시간창
   남용 방지(초당/분당 폭주)는 이 비용 한도가 아니라 rate-limit.mjs의
   횟수 기반 창(예: placeLookupRequeryDailyLimit·
   generationRateLimitPerHour)이 별도로 맡는다 — "하루 사용 총액"과
   "짧은 창 남용 방지"를 같은 숫자로 섞지 않는다. */
export function chargeCostBatch({ accountId, service, charges, periodId, periodCapMicros }) {
  const list = Array.isArray(charges) ? charges : [];
  if (!list.length) return { ok: true, estimatedCostMicros: 0, ids: [] };

  const db = openDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const now = new Date();
    let totalMicros = 0;
    const rows = list.map(({ sku, count }) => {
      const n = Math.max(1, Number(count) || 1);
      const micros = skuCostMicros(sku) * n;
      totalMicros += micros;
      return { sku, n, micros };
    });

    const fail = (reason, capMicros, usedMicros) => {
      db.exec('ROLLBACK');
      return { ok: false, reason, capMicros, usedMicros };
    };

    if (accountId) {
      // periodCapMicros(이 계정의 이용권 기간 전체 누적 한도)가 있으면
      // 계정별 일일/월간 한도를 그 값 이상으로 끌어올린다 — 그래야
      // "이용권 전체 몫을 하루 안에 몰아 쓸 수 있어야 한다"는 약속과
      // 이 한도가 충돌하지 않는다(위 7차 3절 설명 참고).
      const effectiveCap = (baseCap) => (periodCapMicros > 0 ? Math.max(baseCap, periodCapMicros) : baseCap);
      const acctDaily = sumSince(accountId, dayStartIso(now));
      const dailyCap = effectiveCap(config.costBudget.perAccountDailyMicros);
      if (dailyCap > 0 && acctDaily + totalMicros > dailyCap) {
        return fail('account-daily-cost-budget-exceeded', dailyCap, acctDaily);
      }
      const acctMonthly = sumSince(accountId, monthStartIso(now));
      const monthlyCap = effectiveCap(config.costBudget.perAccountMonthlyMicros);
      if (monthlyCap > 0 && acctMonthly + totalMicros > monthlyCap) {
        return fail('account-monthly-cost-budget-exceeded', monthlyCap, acctMonthly);
      }
    }
    const globalDaily = sumSince(null, dayStartIso(now));
    const globalDailyCap = config.costBudget.globalDailyMicros;
    if (globalDailyCap > 0 && globalDaily + totalMicros > globalDailyCap) {
      return fail('global-daily-cost-budget-exceeded', globalDailyCap, globalDaily);
    }
    const globalMonthly = sumSince(null, monthStartIso(now));
    const globalMonthlyCap = config.costBudget.globalMonthlyMicros;
    if (globalMonthlyCap > 0 && globalMonthly + totalMicros > globalMonthlyCap) {
      return fail('global-monthly-cost-budget-exceeded', globalMonthlyCap, globalMonthly);
    }
    if (accountId && periodId && periodCapMicros > 0) {
      const periodUsed = db.prepare('SELECT COALESCE(SUM(estimated_cost_micros),0) AS total FROM cost_ledger WHERE account_id = ? AND period_id = ?').get(accountId, periodId).total;
      if (periodUsed + totalMicros > periodCapMicros) {
        return fail('entitlement-period-cost-safety-cap-exceeded', periodCapMicros, periodUsed);
      }
    }

    const ids = [];
    const insert = db.prepare('INSERT INTO cost_ledger (id, account_id, service, sku, count, estimated_cost_micros, created_at, period_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const createdAt = nowIso();
    for (const r of rows) {
      const id = uuid();
      insert.run(id, accountId || null, service, r.sku, r.n, r.micros, createdAt, periodId || null);
      ids.push(id);
    }
    db.exec('COMMIT');
    return { ok: true, estimatedCostMicros: totalMicros, ids };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) { /* 이미 롤백됐거나 트랜잭션이 없음 */ }
    throw e;
  }
}

/* 단일 건 편의 함수 — 내부적으로 chargeCostBatch를 그대로 쓴다(별도
   로직 중복 없음). */
export function chargeCost({ accountId, service, sku, count, periodId, periodCapMicros }) {
  return chargeCostBatch({ accountId, service, charges: [{ sku, count }], periodId, periodCapMicros });
}

/* 2026-09-10 재검토(7차) 3절 — "이용권에 남은 사용량이 있는데 내부
   한도 때문에 막히면, 부정확한/뭉뚱그려진 오류 대신 정확한 사유와
   안내를 줄 것." chargeCostBatch가 실패하는 이유는 성격이 서로
   다르다:
   - 'entitlement-period-cost-safety-cap-exceeded': 이 계정 **자신의**
     이용권 기간 전체에 허용된 누적 원가를 실제로 다 썼다는 뜻이다 —
     드물지만 정당한 "네 몫을 다 썼다"는 안내를 줘야 한다.
     entitlement-place-lookup-limit-reached 같은 횟수 기반 한도와는
     별개의 축(원가 기준)이지만, 소비자에게는 결국 "이번 이용권으로
     더는 못 한다"는 같은 성격의 안내가 맞다.
   - 그 외(account/global daily·monthly)는 이 계정 개인의 몫과 무관한
     서비스 전체 운영상 한도다 — "지금은 서비스 전체가 바빠 일시적으로
     제한된다, 나중에 다시 시도하라"는 게 정확한 안내다.
   호출부(places.mjs 등)는 이 함수로 charge.reason을 사람에게 보여줄
   수 있는 두 갈래 중 하나로 정규화한 뒤 클라이언트에 그대로 실어
   보낸다(전부 'cost-budget-exceeded'로 뭉개지 않는다). */
export function describeCostFailure(reason) {
  if (reason === 'entitlement-period-cost-safety-cap-exceeded') {
    return { reason: 'entitlement-cost-cap-reached', transient: false };
  }
  return { reason: 'cost-budget-exceeded', transient: true };
}

export function usageSummary(accountId) {
  const now = new Date();
  return {
    accountDailyMicros: accountId ? sumSince(accountId, dayStartIso(now)) : null,
    accountMonthlyMicros: accountId ? sumSince(accountId, monthStartIso(now)) : null,
    globalDailyMicros: sumSince(null, dayStartIso(now)),
    globalMonthlyMicros: sumSince(null, monthStartIso(now)),
    caps: config.costBudget,
  };
}
