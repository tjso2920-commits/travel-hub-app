'use strict';
/**
 * 2026-09-11 재검토(9차) 2절 — ChatGPT가 실제로 재현한 장소확인 예약
 * 확정/해제의 멱등성·소유권 결함.
 *
 * 재현 1: 신규 예약 r을 actual-a로 확정(finalize)하면 사용량 1. 같은
 * r과 같은 성공 결과를 다시 finalize하면(재전송·중복 호출) 예전
 * 코드는 사용량을 0으로 잘못 되돌렸다 — 예약 행이 실제로 아직 남아
 * 있는지 확인하지 않고 reservation.provisional 플래그만 믿었기 때문.
 *
 * 재현 2: old 예약을 만들고 생성 시각을 과거로 되돌린다. fresh 예약
 * 시 만료 스윕으로 old가 회수된다(사용량 원복). fresh를 성공
 * 확정한다(사용량 1이어야 함). 그 뒤에야 old의 늦은 실패 결과가
 * 도착해 finalize되면, 예전 코드는 이미 스윕으로 정리된 old를 또
 * 되돌리려 해 fresh의 정당한 사용량까지 0으로 만들었다.
 *
 * 실행: node server/test/place-lookup-reservation-idempotency.test.mjs
 */
process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'development';
process.env.ENTITLEMENT_FREE_PLACE_LOOKUP_LIMIT = '5';
process.env.ENTITLEMENT_RESERVATION_TIMEOUT_SECONDS = '60';

const { openDb, uuid, nowIso } = await import('../db.mjs');
const { reservePlaceLookupSlot, finalizePlaceLookupResult, usageSummaryForAccount } = await import('../entitlement-usage.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

function directAccount(email) {
  const db = openDb();
  const id = uuid();
  db.prepare('INSERT INTO accounts (id, email, created_at, plan) VALUES (?, ?, ?, ?)').run(id, email, nowIso(), 'free');
  return id;
}
function backdateAllReservations(accountId, secondsAgo) {
  const db = openDb();
  const past = new Date(Date.now() - secondsAgo * 1000).toISOString();
  db.prepare('UPDATE entitlement_place_reservations SET created_at = ? WHERE account_id = ?').run(past, accountId);
}

// =====================================================================
// 1) 같은 성공 결과를 두 번 finalize해도 사용량이 잘못 깎이면 안 된다
//    (멱등성) — 재전송·중복 호출은 실제로 일어날 수 있는 일이다.
// =====================================================================
{
  const acc = directAccount('idempotent-double-finalize@example.com');
  const r = reservePlaceLookupSlot(acc, 'slot-1', 'fp-1');
  const fin1 = finalizePlaceLookupResult(acc, 'slot-1', r, { ok: true, placeId: 'actual-a' });
  t('1) 첫 번째 finalize 성공', fin1 && fin1.ok === true);
  t('1) 첫 번째 finalize 후 사용량 1', usageSummaryForAccount(acc).placeLookups.used === 1);

  const fin2 = finalizePlaceLookupResult(acc, 'slot-1', r, { ok: true, placeId: 'actual-a' });
  t('1) 같은 예약을 같은 성공 결과로 다시 finalize해도 실패 처리되지 않음(멱등)', fin2 && fin2.ok === true);
  t('1) 중복 finalize 후에도 사용량이 그대로 1(0으로 잘못 깎이지 않음 — 재현 확인)', usageSummaryForAccount(acc).placeLookups.used === 1);

  // 세 번째, 네 번째도 안전해야 한다(진짜 멱등).
  finalizePlaceLookupResult(acc, 'slot-1', r, { ok: true, placeId: 'actual-a' });
  finalizePlaceLookupResult(acc, 'slot-1', r, { ok: true, placeId: 'actual-a' });
  t('1) 여러 번 반복해도 사용량이 계속 1로 안정적임', usageSummaryForAccount(acc).placeLookups.used === 1);
}

// =====================================================================
// 2) 스윕으로 회수된 예약의 뒤늦은 실패 결과가 다른(정당한) 예약의
//    사용량을 잘못 건드리면 안 된다.
// =====================================================================
{
  const acc = directAccount('idempotent-stale-then-fresh@example.com');
  const oldReservation = reservePlaceLookupSlot(acc, 'slot-old', 'fp-old');
  t('2) 사전 조건 — old 예약으로 사용량 1', usageSummaryForAccount(acc).placeLookups.used === 1);

  // old가 타임아웃을 훨씬 넘겼다고 가정 — 죽은 프로세스가 남긴 것으로
  // 판단할 수 있는 상태를 재현한다.
  backdateAllReservations(acc, 3600);

  // fresh 예약 — 이 reserve 시도가 old를 스윕(회수)한다.
  const freshReservation = reservePlaceLookupSlot(acc, 'slot-fresh', 'fp-fresh');
  t('2) 스윕 이후에도 사용량은 여전히 1(old 회수 후 fresh가 다시 +1)', usageSummaryForAccount(acc).placeLookups.used === 1);

  const finFresh = finalizePlaceLookupResult(acc, 'slot-fresh', freshReservation, { ok: true, placeId: 'actual-fresh' });
  t('2) fresh를 성공 확정하면 사용량이 정확히 1(정당한 신규 1건)', finFresh && finFresh.ok === true && usageSummaryForAccount(acc).placeLookups.used === 1);

  // old의 외부 호출이 뒤늦게 실패로 돌아왔다 — 이미 스윕으로 정리된
  // 예약이므로 지금 finalize돼도 아무 것도 건드리면 안 된다.
  const finOld = finalizePlaceLookupResult(acc, 'slot-old', oldReservation, { ok: false });
  t('2) 스윕된 예약의 늦은 실패 결과도 finalize 자체는 안전하게 처리됨', finOld && finOld.ok === true);
  t('2) old의 늦은 실패가 fresh의 정당한 사용량을 잘못 건드리지 않음(여전히 1 — 재현 확인)', usageSummaryForAccount(acc).placeLookups.used === 1);

  // old의 외부 호출이 뒤늦게 "성공"으로 돌아온 경우도 같은 원리로
  // 안전해야 한다(이미 회수된 예약이 공짜로 재확정되면 안 됨).
  const finOldSuccess = finalizePlaceLookupResult(acc, 'slot-old', oldReservation, { ok: true, placeId: 'actual-old-late' });
  t('2) 스윕된 예약의 늦은 성공 결과도 새로 과금하지 않고 안전하게 무시됨', finOldSuccess && finOldSuccess.ok === true);
  t('2) 사용량은 여전히 1(스윕된 예약이 뒤늦게 공짜로 재확정되지 않음)', usageSummaryForAccount(acc).placeLookups.used === 1);
}

// =====================================================================
// 3) 실패 후 release도 같은 예약을 두 번 부르면 안전해야 한다.
// =====================================================================
{
  const acc = directAccount('idempotent-double-release@example.com');
  const r = reservePlaceLookupSlot(acc, 'slot-fail', 'fp-fail');
  t('3) 사전 조건 — 예약으로 사용량 1', usageSummaryForAccount(acc).placeLookups.used === 1);
  const fin1 = finalizePlaceLookupResult(acc, 'slot-fail', r, { ok: false });
  t('3) 실패 finalize 성공', fin1 && fin1.ok === true);
  t('3) 실패 후 사용량 0으로 복구됨', usageSummaryForAccount(acc).placeLookups.used === 0);
  const fin2 = finalizePlaceLookupResult(acc, 'slot-fail', r, { ok: false });
  t('3) 같은 예약의 실패를 두 번째로 finalize해도 안전(다른 예약을 잘못 깎지 않음)', fin2 && fin2.ok === true);
  t('3) 사용량이 음수로 안 내려가고 0에 머무름', usageSummaryForAccount(acc).placeLookups.used === 0);
}

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
