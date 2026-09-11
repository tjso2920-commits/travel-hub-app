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
import { openDb, uuid, nowIso } from './db.mjs';
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
   판정된다).

   2026-09-10 재검토(8차) 2절 — ChatGPT가 재현한 추가 우회: "같은 로컬
   슬롯 + 같은 검색 지문"이면 위 빠른 경로가 걸리지만, 그 판정은
   실제로 돌아온 결과와 전혀 대조하지 않았다 — 캐시 만료 후 재조회
   등으로 공급자가 실제로 다른 장소를 돌려줘도(actual-A → actual-B)
   링크만 조용히 바뀌고 사용량은 그대로였다. 지금은
   finalizePlaceLookupResult가 빠른 경로로 들어온 예약이라도
   "실제로 돌아온 placeId가 그때 그 장소와 같은지" 반드시 다시
   대조한다(아래 finalizePlaceLookupResult 참고).

   또한 예전엔 "한도가 이미 다 찼다"고 판단되면 reserve 단계에서
   곧바로 거절해, 외부 호출 자체를 아예 안 보내 버렸다 — 그런데 그
   시도가 실제로는 "다른 로컬 id로 이미 확인된 실제 장소를 다시 본
   것"(비과금 재사용)일 수도 있다는 걸 그때는 알 방법이 없다. 그래서
   한도가 다 찬 상태에서 로컬 슬롯이 처음이거나(또는 검색 조건이
   달라졌으면) 사용량은 아직 늘리지 않은 채 "한도 초과 상태의 시도"로
   표시만 해 두고, 실제 호출 결과가 돌아온 뒤(finalize)에 최종
   판정한다 — 진짜 재사용이면 한도와 무관하게 성공, 진짜 신규면 그때
   가서 거절한다(호출 자체는 비용 원장(cost-ledger.mjs)이 별도로
   추적하므로 이 판단은 "고객에게 보여줄 성공/실패"만 결정한다).

   2026-09-10 재검토(8차) 2절 — 잠정 예약(사용량 +1)이 서버 프로세스
   종료로 finalize 없이 유실되면 그 +1은 영원히 안 풀린다.
   generation_locks/payment_locks와 같은 이유로
   entitlement_place_reservations에 "진행 중" 표시를 남기고, 다음
   reserve 시도 때 이 계정의 오래된(entitlementReservationTimeoutSeconds
   초과) 예약을 발견하면 죽은 시도로 보고 사용량을 되돌린 뒤 회수한다
   (locks.mjs의 만료 회수와 동일한 지연 스윕 방식 — 별도 백그라운드
   작업 없음). */

function sweepStaleReservations(db, accountId) {
  const timeoutMs = (config.entitlementReservationTimeoutSeconds || 60) * 1000;
  const stale = db.prepare('SELECT * FROM entitlement_place_reservations WHERE account_id = ?').all(accountId)
    .filter((r) => Date.now() - new Date(r.created_at).getTime() > timeoutMs);
  for (const r of stale) {
    // 죽은 프로세스가 남긴 잠정 예약으로 보고 그 사용량 +1을 되돌린다.
    db.prepare('UPDATE entitlement_usage SET place_lookups_used = MAX(0, place_lookups_used - 1), updated_at = ? WHERE account_id = ? AND period_id = ?').run(nowIso(), r.account_id, r.period_id);
    db.prepare('DELETE FROM entitlement_place_reservations WHERE reservation_id = ?').run(r.reservation_id);
  }
}

/* 2026-09-11 재검토(9차) — ChatGPT가 실제로 재현한 멱등성 결함: 예전
   deleteReservation은 그냥 지우기만 하고 "정말 아직 진행 중이던 예약을
   지운 건지" 확인하지 않았다. 그래서 같은 finalize(성공)를 두 번
   부르면(재전송·재시도) 두 번째 호출이 "이미 확인된 실제 장소라 잠정
   예약을 되돌린다"는 분기를 다시 타면서, 이미 첫 번째 호출이 확정해
   지운 예약을 또 되돌리려 해 사용량을 잘못 차감했다(1 → 0). 스윕으로
   회수된 예약의 뒤늦은 실패 결과가 다른(멀쩡한) 예약의 사용량까지
   잘못 건드리는 것도 같은 원인이었다.
   지금은 "그 예약 행이 실제로 아직 DB에 남아 있었는지"를 DELETE의
   영향받은 행 수(changes)로 직접 확인한다 — 행이 없었으면(이미 다른
   호출이 처리했거나 스윕됐으면) 이 호출은 완전히 없었던 일처럼
   무시한다(사용량을 또 건드리지 않음). 계정·기간·로컬장소까지 함께
   대조해 소유권도 같이 확인한다(다른 계정·다른 기간의 예약을 실수로
   건드릴 수 없다). */
function consumeReservationRow(db, accountId, period, localPlaceId, reservationId) {
  if (!reservationId) return false;
  const info = db.prepare(
    'DELETE FROM entitlement_place_reservations WHERE reservation_id = ? AND account_id = ? AND period_id = ? AND local_place_id = ?'
  ).run(reservationId, accountId, period.periodId, localPlaceId);
  return info.changes > 0;
}
/* 예약이 "실제로 아직 진행 중이었을 때만" 사용량 +1을 되돌린다(위
   consumeReservationRow의 반환값으로 판단) — 이미 확정됐거나(committed)
   스윕으로 회수됐으면(released) 아무것도 안 한다. */
function releaseIfStillPending(db, accountId, period, localPlaceId, reservationId) {
  if (!consumeReservationRow(db, accountId, period, localPlaceId, reservationId)) return false;
  db.prepare('UPDATE entitlement_usage SET place_lookups_used = MAX(0, place_lookups_used - 1), updated_at = ? WHERE account_id = ? AND period_id = ?').run(nowIso(), accountId, period.periodId);
  return true;
}

export function reservePlaceLookupSlot(accountId, localPlaceId, queryFingerprint) {
  const period = currentPeriod(accountId);
  if (!localPlaceId) return { ok: true, isNew: false, period };
  const fp = String(queryFingerprint || '');
  const db = openDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    sweepStaleReservations(db, accountId);
    const link = db.prepare('SELECT real_place_id, query_fingerprint FROM entitlement_place_local_link WHERE account_id = ? AND local_place_id = ?').get(accountId, localPlaceId);
    if (link && link.query_fingerprint === fp) {
      // 완전히 같은 로컬 슬롯 + 완전히 같은 검색 조건 — "예전에 이미
      // 신규가 아니라고 판정됐던 조건 그대로"라는 뜻일 뿐, 이번에도
      // 실제로 같은 장소가 돌아올지는 finalize에서 다시 대조해야
      // 한다(아래 finalizePlaceLookupResult 참고) — 그래서 여기선
      // 외부 호출을 건너뛰지 않고, 한도 확인도 생략한 채 그대로
      // 진행시킨다(예전처럼 무조건 공짜로 확정하지 않는다).
      db.exec('COMMIT');
      return { ok: true, isNew: false, period, knownRealPlaceId: link.real_place_id, queryFingerprint: fp };
    }
    // 로컬 슬롯이 처음이거나 검색 조건이 이전과 달라졌다 — 실제로
    // 어떤 장소가 나올지 아직 모르므로 "신규일 수 있다"고 본다.
    const row = usageRow(db, accountId, period.periodId);
    const used = row ? row.place_lookups_used : 0;
    if (used >= period.placeLookupLimit) {
      // 한도가 이미 다 찼다 — 그래도 이 시도가 "다른 로컬 id로 이미
      // 확인된 실제 장소"의 재사용일 수 있으므로 여기서 곧바로
      // 거절하지 않는다. 사용량은 아직 늘리지 않은 채, finalize가
      // 실제 real_place_id를 보고 최종 판정하게 한다(진짜 신규로
      // 밝혀지면 그때 거절).
      db.exec('COMMIT');
      return { ok: true, isNew: true, provisional: false, overLimit: true, period, used, limit: period.placeLookupLimit, queryFingerprint: fp };
    }
    const reservationId = uuid();
    const now = nowIso();
    db.prepare(`
      INSERT INTO entitlement_usage (account_id, period_id, place_lookups_used, course_successes_used, updated_at)
      VALUES (?, ?, 1, 0, ?)
      ON CONFLICT(account_id, period_id) DO UPDATE SET place_lookups_used = place_lookups_used + 1, updated_at = excluded.updated_at
    `).run(accountId, period.periodId, now);
    db.prepare('INSERT INTO entitlement_place_reservations (reservation_id, account_id, period_id, local_place_id, created_at) VALUES (?, ?, ?, ?, ?)').run(reservationId, accountId, period.periodId, localPlaceId, now);
    db.exec('COMMIT');
    return { ok: true, isNew: true, provisional: true, reservationId, period, queryFingerprint: fp };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) { /* 이미 롤백됐거나 트랜잭션이 없음 */ }
    throw e;
  }
}

/* 잠정 예약을 되돌린다 — 외부 호출 자체가 실패했거나(not-found/
   network-error), 결과는 성공했지만 이미 확인된 실제 장소로 밝혀져
   과금할 필요가 없어진 경우에 부른다. provisional(=사용량을 이미
   +1한) 예약만 되돌릴 의미가 있다(호출부가 그 조건을 미리 확인하고
   부른다). 여기서 entitlement_place_confirmed는 절대 건드리지 않는다
   — 그 표는 오직 finalizePlaceLookupResult가 "진짜 신규로 확정됐을
   때"만 채우므로, 이 함수가 부를 시점엔 애초에 그 계정·real_place_id
   조합으로 아직 아무것도 기록된 적이 없거나(신규 실패) 이미 다른
   확인으로 기록된 것이다(둘 다 지우면 안 됨 — 후자를 지우면 "성공
   기록을 잘못 지운다"). 반드시 진행 중 표시(reservation_id)도 함께
   지워야 이중 해제·유령 스윕을 막는다. */
export function releasePlaceLookupSlot(accountId, localPlaceId, period, reservationId) {
  if (!localPlaceId || !period) return;
  const db = openDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    // 2026-09-11 재검토(9차) — 이 예약이 실제로 아직 진행 중이었을
    // 때만 사용량을 되돌린다. 이미 스윕으로 회수됐거나 다른 finalize
    // 호출이 먼저 처리했으면(예: 재전송·늦게 도착한 결과) 아무 것도
    // 안 한다 — 멀쩡한 다른 예약의 사용량을 잘못 깎지 않기 위해서다.
    releaseIfStillPending(db, accountId, period, localPlaceId, reservationId);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) { /* noop */ }
    throw e;
  }
}

/* 외부 호출 결과가 돌아온 뒤 실제로 신규인지 최종 판정하고, 로컬
   슬롯↔검색 조건↔real_place_id 링크를 최신으로 남긴다. reservation은
   reservePlaceLookupSlot의 반환값을 그대로 넘겨받는다. 호출부
   (places.mjs)는 반드시 반환값의 ok를 확인해서, false면 이미 외부
   호출이 성공했더라도 고객에게는 실패(한도 초과)로 응답해야 한다. */
export function finalizePlaceLookupResult(accountId, localPlaceId, reservation, result) {
  if (!localPlaceId || !reservation) return { ok: true };
  const period = reservation.period;
  if (!result || !result.ok) {
    if (reservation.isNew && reservation.provisional) releasePlaceLookupSlot(accountId, localPlaceId, period, reservation.reservationId);
    return { ok: true };
  }
  const fp = reservation.queryFingerprint;
  const realPlaceId = result.placeId || null;

  if (!reservation.isNew) {
    // 빠른 경로로 통과했던 예약 — 그래도 실제로 돌아온 장소가 그때
    // 그 장소와 같은지 다시 대조해야 한다(8차: 검색 조건이 같아도
    // 공급자가 실제로 다른 장소를 줄 수 있다 — 캐시 만료 후 재조회 등).
    if (realPlaceId && reservation.knownRealPlaceId && realPlaceId === reservation.knownRealPlaceId) {
      if (fp !== undefined) upsertLocalLink(accountId, localPlaceId, realPlaceId, fp);
      return { ok: true };
    }
    // 실제로 장소가 바뀌었다 — 더 이상 "그 반복 재조회"가 아니라 진짜
    // 신규 시도다. 아래 신규 판정 경로를 그대로 탄다(사용량이 아직
    // 전혀 늘지 않은 상태이므로 provisional=false와 동일하게 처리).
    return finalizeAsNewAttempt(accountId, localPlaceId, period, fp, realPlaceId, reservation);
  }

  return finalizeAsNewAttempt(accountId, localPlaceId, period, fp, realPlaceId, reservation);
}

/* "신규일 수 있다"고 보고 예약됐던 시도(또는 빠른 경로였지만 실제
   결과가 달라져 신규로 재판정된 시도)의 최종 판정. reservation.provisional
   이 true면 사용량이 이미 +1된 상태(reserve 시점에 잠정 확정)이므로
   재사용으로 밝혀지면 되돌리기만 하면 되고, false면(reserve가 한도
   초과라 아직 안 늘렸거나, 빠른 경로였던 경우) 지금 이 시점에 다시
   한도를 확인해야 한다. */
function finalizeAsNewAttempt(accountId, localPlaceId, period, fp, realPlaceId, reservation) {
  const db = openDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    if (realPlaceId) {
      const already = db.prepare('SELECT 1 FROM entitlement_place_confirmed WHERE account_id = ? AND real_place_id = ?').get(accountId, realPlaceId);
      if (already) {
        // 이 계정이 이 실제 장소를 (다른 로컬 id로든, 다른 검색
        // 조건으로든) 이미 확인한 적 있다 — 한도와 무관하게 비과금
        // 성공이다. 잠정으로 이미 늘려둔 사용량이 있으면 되돌리되,
        // 그 예약이 "지금도 실제로 진행 중"일 때만 되돌린다 — 같은
        // finalize가 두 번(재전송 등) 불리면 두 번째 호출 시점엔 첫
        // 번째 호출이 이미 이 예약을 확정·소비한 뒤라 예약 행이 없고,
        // releaseIfStillPending이 그걸 확인해 아무 것도 안 한다(이미
        // 확정된 다른 성공 건의 사용량을 잘못 또 깎지 않기 위해).
        if (reservation.provisional) releaseIfStillPending(db, accountId, period, localPlaceId, reservation.reservationId);
        if (fp !== undefined) upsertLocalLinkTx(db, accountId, localPlaceId, realPlaceId, fp);
        db.exec('COMMIT');
        return { ok: true };
      }
      // 처음 보는 실제 장소 — 진짜 신규다.
      if (!reservation.provisional) {
        // reserve 시점엔 아직 사용량을 안 늘렸다(한도 초과 상태로
        // 시도했거나 빠른 경로였다가 재판정됨) — 지금 다시 한도를
        // 확인해서 여유가 있을 때만 새로 늘린다. 없으면 외부 호출은
        // 이미 끝났어도 고객에게는 실패(한도 초과)로 응답해야 한다.
        const row = usageRow(db, accountId, period.periodId);
        const used = row ? row.place_lookups_used : 0;
        if (used >= period.placeLookupLimit) {
          db.exec('ROLLBACK');
          return { ok: false, reason: 'entitlement-place-lookup-limit-reached', period, used, limit: period.placeLookupLimit };
        }
        db.prepare(`
          INSERT INTO entitlement_usage (account_id, period_id, place_lookups_used, course_successes_used, updated_at)
          VALUES (?, ?, 1, 0, ?)
          ON CONFLICT(account_id, period_id) DO UPDATE SET place_lookups_used = place_lookups_used + 1, updated_at = excluded.updated_at
        `).run(accountId, period.periodId, nowIso());
      }
      db.prepare('INSERT INTO entitlement_place_confirmed (account_id, real_place_id, first_period_id, confirmed_at) VALUES (?, ?, ?, ?)').run(accountId, realPlaceId, period.periodId, nowIso());
    } else if (!reservation.provisional) {
      // realPlaceId가 없는 공급자 결과(강한 식별자를 못 줌)는 안전한
      // 쪽으로: 검증 못 할 재사용을 무료로 허용하는 것보다, 한도가
      // 있으면 신규로 확정한다.
      const row = usageRow(db, accountId, period.periodId);
      const used = row ? row.place_lookups_used : 0;
      if (used >= period.placeLookupLimit) {
        db.exec('ROLLBACK');
        return { ok: false, reason: 'entitlement-place-lookup-limit-reached', period, used, limit: period.placeLookupLimit };
      }
      db.prepare(`
        INSERT INTO entitlement_usage (account_id, period_id, place_lookups_used, course_successes_used, updated_at)
        VALUES (?, ?, 1, 0, ?)
        ON CONFLICT(account_id, period_id) DO UPDATE SET place_lookups_used = place_lookups_used + 1, updated_at = excluded.updated_at
      `).run(accountId, period.periodId, nowIso());
    }
    // 신규로 확정됐다(과금 여부와 무관하게 이 판정은 끝났다) — 예약을
    // "소비됨"으로 지운다. 사용량은 이미 위에서 정확히 처리했으므로
    // 여기서는 절대 다시 건드리지 않는다(그냥 진행 중 표시만 지움).
    consumeReservationRow(db, accountId, period, localPlaceId, reservation.reservationId);
    if (fp !== undefined) upsertLocalLinkTx(db, accountId, localPlaceId, realPlaceId, fp);
    db.exec('COMMIT');
    return { ok: true };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) { /* noop */ }
    throw e;
  }
}

function upsertLocalLink(accountId, localPlaceId, realPlaceId, fp) {
  upsertLocalLinkTx(openDb(), accountId, localPlaceId, realPlaceId, fp);
}

function upsertLocalLinkTx(db, accountId, localPlaceId, realPlaceId, fp) {
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
