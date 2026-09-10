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
 * 신규 장소 위치 확인 집계: `entitlement_place_confirmed`(계정+**실제
 * 장소**(공급자가 돌려준 real_place_id) 조합당 평생 한 행)로 "이 실제
 * 장소를 이 계정이 이미 확인한 적 있는지"를 판단한다 — 있으면 이번이
 * 몇 번째 기간이든, 클라이언트의 어느 로컬 id로 다시 나타나든 다시는
 * 신규로 안 센다("이미 위치가 확인된 기존 장소를 재사용하는 것은 신규
 * 장소 한도를 안 깎는다"는 지시).
 *
 * 2026-09-10 재검토(7차) — 예전엔 이 표의 키가 클라이언트가 불러주는
 * 로컬 place id 문자열이었다. "신규 여부"를 실제 조회 결과와 전혀
 * 대조하지 않았기 때문에, 같은 로컬 id에 검색어만 바꿔 보내는 것으로
 * 서로 다른 실제 장소를 무제한 무료로 확인받는 우회가 가능했다(ChatGPT
 * 재현). 지금은 reserve(외부 호출 전 잠정 예약, 한도만 미리 확인)와
 * finalize(호출 결과가 돌아온 뒤, 실제 real_place_id로 최종 판정 —
 * 이미 확인된 실제 장소면 잠정 예약을 되돌리고, 처음 보는 실제 장소면
 * 확정) 두 단계로 분리했다. 실패로 밝혀지면 잠정 예약을 되돌린다
 * (release) — "실패·추정 결과는 미차감"을 정확히 지키기 위해서다.
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

/* 검색 조건 지문 — "완전히 같은 로컬 슬롯에 완전히 같은 조건"인지
   판별하는 근거. places.mjs의 캐시 키와 같은 원칙(질의+지역 힌트를
   정규화)이라 그 함수를 그대로 재사용한다(호출부에서 넘겨준다 — 이
   파일이 질의 문자열 형식을 몰라도 되게 하기 위해서). */

/* 2026-09-10 재검토(7차) — "클라이언트가 불러주는 로컬 place id 자체를
   확정 증거로 믿지 말라"(2절 지시)를 실제로 고친 두 단계 구조.
   ChatGPT가 재현한 우회: 같은 로컬 id에 서로 다른 검색어를 보내면
   서로 다른 실제 장소 6곳을 확인받고도 사용량은 1로만 기록됐다 —
   과거엔 entitlement_place_confirmed의 키가 클라이언트 문자열
   (로컬 id)이었고, "신규 여부"를 외부 호출 결과와 전혀 대조하지
   않았기 때문이다.

   이제는:
   1) reservePlaceLookupSlot — 외부 호출 **전**에 부른다. 완전히 같은
      로컬 슬롯+완전히 같은 검색 조건(query_fingerprint)이 이미
      링크돼 있으면(entitlement_place_local_link) 그 자리에서 바로
      "신규 아님"으로 통과시킨다(외부 호출 결과를 기다릴 필요조차
      없음 — 진짜 반복 재조회). 그 외의 모든 경우(로컬 슬롯이 처음
      이거나 검색 조건이 달라짐)는 "신규일 수도 있다"고 보고 한도를
      먼저 확인한 뒤 잠정으로 1건을 예약(사용량 +1)한다 — 실제로
      어떤 장소가 확정됐는지는 아직 모른다.
   2) finalizePlaceLookupResult — 외부 호출 결과가 돌아온 **후**에
      부른다. 결과가 실패면 잠정 예약을 되돌린다(기존과 동일). 결과가
      성공이면 공급자가 실제로 돌려준 real_place_id를 본다:
      - 이 계정이 그 real_place_id를 이미(다른 로컬 id로든, 다른 검색
        조건으로든) 확인한 적이 있으면 → 방금 만든 잠정 예약을
        되돌린다("다른 id + 같은 실제 장소"는 비과금이어야 한다는
        지시를 지킨다).
      - 처음 보는 real_place_id면 → 잠정 예약을 그대로 확정하고
        entitlement_place_confirmed에 real_place_id로 기록한다.
      마지막으로 로컬 슬롯↔검색 조건↔real_place_id 링크를 항상 최신
      값으로 갱신한다(다음에 완전히 같은 조건이 다시 오면 1)의 빠른
      경로로 즉시 무료 처리되게).

   장소 병합·별칭 변경으로 로컬 id가 바뀌어도 과금 근거표
   (entitlement_place_confirmed)는 real_place_id로만 채워지므로 이미
   낸 비용은 그대로 보존된다 — 로컬 링크 표는 그저 캐시라 잃어도
   손해가 없다(다음 조회 때 한 번 더 실제 호출로 재확인될 뿐, 이미
   confirmed된 real_place_id면 그 결과 finalize에서 다시 비과금으로
   판정된다). */
export function reservePlaceLookupSlot(accountId, localPlaceId, queryFingerprint) {
  const period = currentPeriod(accountId);
  if (!localPlaceId) return { ok: true, isNew: false, period };
  const fp = String(queryFingerprint || '');
  const db = openDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const link = db.prepare('SELECT real_place_id, query_fingerprint FROM entitlement_place_local_link WHERE account_id = ? AND local_place_id = ?').get(accountId, localPlaceId);
    if (link && link.query_fingerprint === fp) {
      // 완전히 같은 로컬 슬롯 + 완전히 같은 검색 조건 — 진짜 반복
      // 재조회다. 이전에 이미 신규가 아니라고 판정됐던 조건 그대로라
      // 외부 호출 결과를 기다릴 필요 없이 바로 통과.
      db.exec('COMMIT');
      return { ok: true, isNew: false, period, knownRealPlaceId: link.real_place_id, queryFingerprint: fp };
    }
    // 로컬 슬롯이 처음이거나 검색 조건이 이전과 달라졌다 — 실제로
    // 어떤 장소가 나올지 아직 모르므로 "신규일 수 있다"고 보고 한도를
    // 먼저 확인한 뒤 잠정 예약한다. 결과가 돌아오면
    // finalizePlaceLookupResult가 진짜 신규인지 다시 판정한다.
    const row = usageRow(db, accountId, period.periodId);
    const used = row ? row.place_lookups_used : 0;
    if (used >= period.placeLookupLimit) {
      db.exec('ROLLBACK');
      return { ok: false, reason: 'entitlement-place-lookup-limit-reached', period, used, limit: period.placeLookupLimit };
    }
    const now = nowIso();
    db.prepare(`
      INSERT INTO entitlement_usage (account_id, period_id, place_lookups_used, course_successes_used, updated_at)
      VALUES (?, ?, 1, 0, ?)
      ON CONFLICT(account_id, period_id) DO UPDATE SET place_lookups_used = place_lookups_used + 1, updated_at = excluded.updated_at
    `).run(accountId, period.periodId, now);
    db.exec('COMMIT');
    return { ok: true, isNew: true, provisional: true, period, queryFingerprint: fp };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) { /* 이미 롤백됐거나 트랜잭션이 없음 */ }
    throw e;
  }
}

/* 잠정 예약을 되돌린다 — 외부 호출 자체가 실패했거나(not-found/
   network-error), 결과는 성공했지만 이미 확인된 실제 장소로 밝혀져
   과금할 필요가 없어진 경우에 부른다. isNew(=provisional)였던 예약만
   되돌릴 의미가 있다(호출부가 그 조건을 미리 확인하고 부른다). 여기서
   entitlement_place_confirmed는 절대 건드리지 않는다 — 그 표는 오직
   finalizePlaceLookupResult가 "진짜 신규로 확정됐을 때"만 채우므로,
   이 함수가 부를 시점엔 애초에 그 계정·real_place_id 조합으로 아직
   아무것도 기록된 적이 없거나(신규 실패) 이미 다른 확인으로 기록된
   것이다(둘 다 지우면 안 됨 — 후자를 지우면 "성공 기록을 잘못 지운다"). */
export function releasePlaceLookupSlot(accountId, localPlaceId, period) {
  if (!localPlaceId || !period) return;
  const db = openDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE entitlement_usage SET place_lookups_used = MAX(0, place_lookups_used - 1), updated_at = ? WHERE account_id = ? AND period_id = ?').run(nowIso(), accountId, period.periodId);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) { /* noop */ }
    throw e;
  }
}

/* 외부 호출 결과가 돌아온 뒤 실제로 신규인지 최종 판정하고, 로컬
   슬롯↔검색 조건↔real_place_id 링크를 최신으로 남긴다. reservation은
   reservePlaceLookupSlot의 반환값을 그대로 넘겨받는다. */
export function finalizePlaceLookupResult(accountId, localPlaceId, reservation, result) {
  if (!localPlaceId || !reservation) return;
  const period = reservation.period;
  if (!result || !result.ok) {
    if (reservation.isNew) releasePlaceLookupSlot(accountId, localPlaceId, period);
    return;
  }
  const fp = reservation.queryFingerprint;
  if (!reservation.isNew) {
    // 이미 "신규 아님"으로 통과한 빠른 경로 — 링크만 그대로 최신
    // 시각으로 갱신해 두면 된다(내용은 안 바뀜).
    if (fp !== undefined) upsertLocalLink(accountId, localPlaceId, result.placeId || reservation.knownRealPlaceId || null, fp);
    return;
  }
  const realPlaceId = result.placeId || null;
  const db = openDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    if (realPlaceId) {
      const already = db.prepare('SELECT 1 FROM entitlement_place_confirmed WHERE account_id = ? AND real_place_id = ?').get(accountId, realPlaceId);
      if (already) {
        // 이 계정이 이 실제 장소를 (다른 로컬 id로든, 다른 검색
        // 조건으로든) 이미 확인한 적 있다 — 방금 예약한 신규 슬롯은
        // 취소한다("다른 id + 같은 실제 장소"는 비과금).
        db.prepare('UPDATE entitlement_usage SET place_lookups_used = MAX(0, place_lookups_used - 1), updated_at = ? WHERE account_id = ? AND period_id = ?').run(nowIso(), accountId, period.periodId);
      } else {
        db.prepare('INSERT INTO entitlement_place_confirmed (account_id, real_place_id, first_period_id, confirmed_at) VALUES (?, ?, ?, ?)').run(accountId, realPlaceId, period.periodId, nowIso());
      }
    }
    // realPlaceId가 없는 경우(강한 식별자를 못 주는 공급자 결과)는
    // 안전한 쪽으로: 잠정 예약을 그대로 확정(신규로 과금)한다 — 검증
    //못 할 재사용을 무료로 허용하는 것보다 안전하다.
    if (fp !== undefined) {
      db.prepare(`
        INSERT INTO entitlement_place_local_link (account_id, local_place_id, real_place_id, query_fingerprint, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(account_id, local_place_id) DO UPDATE SET real_place_id = excluded.real_place_id, query_fingerprint = excluded.query_fingerprint, updated_at = excluded.updated_at
      `).run(accountId, localPlaceId, realPlaceId, fp, nowIso());
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) { /* noop */ }
    throw e;
  }
}

function upsertLocalLink(accountId, localPlaceId, realPlaceId, fp) {
  const db = openDb();
  db.prepare(`
    INSERT INTO entitlement_place_local_link (account_id, local_place_id, real_place_id, query_fingerprint, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(account_id, local_place_id) DO UPDATE SET real_place_id = excluded.real_place_id, query_fingerprint = excluded.query_fingerprint, updated_at = excluded.updated_at
  `).run(accountId, localPlaceId, realPlaceId, fp, nowIso());
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
