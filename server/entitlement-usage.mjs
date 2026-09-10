'use strict';
/**
 * 2026-09-10 재검토(6차) — "이용권 횟수(고객에게 약속한 사용량)와 실제
 * 비용 원장(cost-ledger.mjs)을 분리하라"는 지시의 실제 구현.
 *
 * 두 층을 분명히 나눈다:
 * - **cost-ledger.mjs(실제 비용 원장)**: 우리가 공급자에게 실제로
 *   호출을 보내기로 "결정한" 모든 순간을 기록한다 — 성공/실패/타임아웃
 *   과 무관하다. 이건 "회사가 실제로 얼마를 쓸 수 있는지"를 지킨다.
 * - **entitlement-usage.mjs(이 파일 — 고객 사용량)**: 고객에게 보여줄
 *   "몇 번 남았는지"를 지킨다. 오직 **성공한 결과**만 차감한다 — 실패·
 *   추정·재조회·중복은 전부 미차감. 이건 "고객이 약속받은 사용량을
 *   실제로 다 받는지"를 지킨다.
 *
 * 이용권 기간(period): 무료체험은 계정당 평생 한 번(`period_id='free'`),
 * 유료는 그 이용권을 부여한 주문(`accounts.active_order_id`)이 곧
 * period_id다. **30일 이용권은 이 주문 하나에 고정**되므로 달력월이
 * 바뀌어도 사용량이 조용히 초기화되지 않는다 — 새 주문(재구매)이
 * 있어야만 새 period_id로 넘어간다.
 *
 * 신규 장소 위치 확인 집계: `entitlement_place_confirmed`(계정+장소
 * 조합당 평생 한 행)로 "이 장소를 이 계정이 이미 확인한 적 있는지"를
 * 판단한다 — 있으면 이번이 몇 번째 기간이든 다시는 신규로 안 센다
 * ("이미 위치가 확인된 기존 장소를 재사용하는 것은 신규 장소 한도를
 * 안 깎는다"는 지시). 예약(reserve)은 실제 외부 호출 전에 낙관적으로
 * 기록해 두고, 결과가 실패로 밝혀지면 되돌린다(release) — "실패·추정
 * 결과는 미차감"을 정확히 지키기 위해서다(성공을 확인한 뒤에야 확정
 * 짓는 2단계 대신, "실패하면 되돌린다"는 더 단순한 1단계 모델).
 */
import { openDb, nowIso } from './db.mjs';
import { config } from './config.mjs';
import { checkEntitlement } from './routes/entitlement.mjs';
import { periodCostMicros } from './cost-ledger.mjs';

/* 이 계정이 지금 속한 이용권 기간과 그 기간에 적용되는 한도. */
export function currentPeriod(accountId) {
  const ent = checkEntitlement(accountId);
  if (ent.ok && ent.plan === 'paid') {
    const db = openDb();
    const row = db.prepare('SELECT active_order_id FROM accounts WHERE id = ?').get(accountId);
    const periodId = (row && row.active_order_id) || 'paid-unknown';
    return {
      kind: 'paid',
      periodId,
      placeLookupLimit: config.entitlementUsage.paidPlaceLookupLimit,
      courseLimit: config.entitlementUsage.paidCourseLimit,
      costCapMicros: config.costSafetyCap.paidEntitlementMicros,
      expiresAt: ent.expiresAt,
    };
  }
  return {
    kind: 'free',
    periodId: 'free',
    placeLookupLimit: config.entitlementUsage.freePlaceLookupLimit,
    courseLimit: config.entitlementUsage.freeCourseLimit,
    costCapMicros: config.costSafetyCap.freeAccountMicros,
    expiresAt: null,
  };
}

function usageRow(db, accountId, periodId) {
  return db.prepare('SELECT * FROM entitlement_usage WHERE account_id = ? AND period_id = ?').get(accountId, periodId);
}

/* 계정 화면에 보여줄 요약 — 잔여 횟수·기간 종류만 포함하고 API/SKU 같은
   개발 용어는 이 함수 결과에 전혀 없다(소비자 화면이 그대로 써도 됨). */
export function usageSummaryForAccount(accountId) {
  const period = currentPeriod(accountId);
  const db = openDb();
  const row = usageRow(db, accountId, period.periodId);
  const placeLookupsUsed = row ? row.place_lookups_used : 0;
  const courseSuccessesUsed = row ? row.course_successes_used : 0;
  return {
    ok: true,
    kind: period.kind,
    expiresAt: period.expiresAt,
    placeLookups: { used: placeLookupsUsed, limit: period.placeLookupLimit, remaining: Math.max(0, period.placeLookupLimit - placeLookupsUsed) },
    courseGenerations: { used: courseSuccessesUsed, limit: period.courseLimit, remaining: Math.max(0, period.courseLimit - courseSuccessesUsed) },
  };
}

/* 신규 장소 위치 확인 슬롯을 낙관적으로 예약한다 — 실제 외부 호출
   전에 부른다(한도 도달 시 애초에 비용이 드는 호출 자체를 안 하기
   위해서). 이미 확인된 장소면(isNew:false) 아무 것도 안 건드리고
   통과시킨다(재조회 허용 — 비용은 별도로 계속 청구됨, 다만 이 함수가
   아니라 cost-ledger.mjs 몫). */
export function reservePlaceLookupSlot(accountId, placeId) {
  const period = currentPeriod(accountId);
  if (!placeId) return { ok: true, isNew: false, period };
  const db = openDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const already = db.prepare('SELECT 1 FROM entitlement_place_confirmed WHERE account_id = ? AND place_id = ?').get(accountId, placeId);
    if (already) { db.exec('COMMIT'); return { ok: true, isNew: false, period }; }
    const row = usageRow(db, accountId, period.periodId);
    const used = row ? row.place_lookups_used : 0;
    if (used >= period.placeLookupLimit) {
      db.exec('ROLLBACK');
      return { ok: false, reason: 'entitlement-place-lookup-limit-reached', period, used, limit: period.placeLookupLimit };
    }
    const now = nowIso();
    db.prepare('INSERT INTO entitlement_place_confirmed (account_id, place_id, first_period_id, confirmed_at) VALUES (?, ?, ?, ?)').run(accountId, placeId, period.periodId, now);
    db.prepare(`
      INSERT INTO entitlement_usage (account_id, period_id, place_lookups_used, course_successes_used, updated_at)
      VALUES (?, ?, 1, 0, ?)
      ON CONFLICT(account_id, period_id) DO UPDATE SET place_lookups_used = place_lookups_used + 1, updated_at = excluded.updated_at
    `).run(accountId, period.periodId, now);
    db.exec('COMMIT');
    return { ok: true, isNew: true, period };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) { /* 이미 롤백됐거나 트랜잭션이 없음 */ }
    throw e;
  }
}

/* 예약을 되돌린다 — 실제로는 실패했거나(not-found/network-error) 비용
   한도 등으로 호출 자체가 취소된 경우에만 부른다. isNew였던 예약만
   되돌릴 의미가 있다(호출부가 그 조건을 미리 확인하고 부른다). */
export function releasePlaceLookupSlot(accountId, placeId, period) {
  if (!placeId || !period) return;
  const db = openDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM entitlement_place_confirmed WHERE account_id = ? AND place_id = ?').run(accountId, placeId);
    db.prepare('UPDATE entitlement_usage SET place_lookups_used = MAX(0, place_lookups_used - 1), updated_at = ? WHERE account_id = ? AND period_id = ?').run(nowIso(), accountId, period.periodId);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) { /* noop */ }
    throw e;
  }
}

/* 코스 생성 — 실제 라우팅 호출(비용이 드는 일) 전에 먼저 확인한다.
   실패/추정 결과는 애초에 이 함수가 아니라 호출부가 성공 여부를 보고
   나서만 commitCourseGenerationSuccess를 부르므로, 여기서는 "지금 이
   기간에 아직 여유가 있는지"만 본다. */
export function checkCourseGenerationAllowed(accountId) {
  const period = currentPeriod(accountId);
  const db = openDb();
  const row = usageRow(db, accountId, period.periodId);
  const used = row ? row.course_successes_used : 0;
  if (used >= period.courseLimit) {
    return { ok: false, reason: period.kind === 'free' ? 'free-trial-course-limit-reached' : 'entitlement-course-limit-reached', period, used, limit: period.courseLimit };
  }
  return { ok: true, period, used, limit: period.courseLimit };
}

/* 실제 경로로 성공(routedReal===true)했을 때만 호출부가 부른다 —
   추정/실패는 절대 이 함수를 안 부르는 것으로 "미차감"을 지킨다(기존
   무료체험 consumeTrial과 동일한 원칙). 멱등 재전송(같은
   idempotencyKey 재요청)은 course-generation.mjs가 이 함수 자체를
   다시 안 불러서(저장된 결과를 그대로 재생) 자동으로 미차감된다. */
export function commitCourseGenerationSuccess(accountId, period) {
  const db = openDb();
  const now = nowIso();
  db.prepare(`
    INSERT INTO entitlement_usage (account_id, period_id, place_lookups_used, course_successes_used, updated_at)
    VALUES (?, ?, 0, 1, ?)
    ON CONFLICT(account_id, period_id) DO UPDATE SET course_successes_used = course_successes_used + 1, updated_at = excluded.updated_at
  `).run(accountId, period.periodId, now);
}

/* 내부 원가 안전상한 확인용 — cost-ledger.mjs의 chargeCost(Batch)에
   periodId/periodCapMicros로 그대로 넘겨 쓴다. 이 함수 자체는 순수
   조회라 사이드이펙트가 없다(실제 확인·기록은 cost-ledger.mjs가 같은
   트랜잭션 안에서 한다 — 이중 확인 아님, cost-ledger가 필요로 하는
   값을 이 파일이 계산해서 건네주는 것뿐). */
export function periodCostStatus(accountId, period) {
  const used = periodCostMicros(accountId, period.periodId);
  return { usedMicros: used, capMicros: period.costCapMicros, remainingMicros: Math.max(0, period.costCapMicros - used) };
}
