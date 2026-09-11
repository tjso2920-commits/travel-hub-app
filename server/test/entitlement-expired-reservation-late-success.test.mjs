'use strict';
/**
 * 2026-09-11 재검토(10차) — ChatGPT가 실제로 재현한 결함: 스윕으로
 * 이미 회수된(만료된) 예약에 대해 뒤늦게 도착한 "성공" 결과를
 * finalize하면, entitlement_place_confirmed에는 새로 기록되면서도
 * place_lookups_used는 전혀 다시 늘지 않아 그 조회가 완전히 공짜로
 * 확정됐다.
 *
 * 재현 순서(ChatGPT 원문 그대로):
 *   ① old 슬롯 reserve
 *   ② old 예약 created_at을 오래된 시각으로 변경
 *   ③ new 슬롯 reserve로 old 스윕 발생
 *   ④ new를 real-new 성공으로 finalize
 *   ⑤ 만료된 old를 real-old 성공으로 finalize
 *
 * 버그가 있었을 때 결과: entitlement_place_confirmed 2개, used 1.
 * 고친 뒤 기대 결과: confirmed 2개, used도 실제로 2(공짜 확정 없음).
 *
 * 이 재현은 합성 데이터·인메모리 DB로 entitlement-usage.mjs의 함수를
 * 직접 호출하는 Node 실행이다 — 실제 브라우저·iPhone 검증이 아니다.
 *
 * 실행: node server/test/entitlement-expired-reservation-late-success.test.mjs
 */
process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'development';
process.env.ENTITLEMENT_FREE_PLACE_LOOKUP_LIMIT = '10';

const { openDb, uuid, nowIso } = await import('../db.mjs');
const { reservePlaceLookupSlot, finalizePlaceLookupResult, usageSummaryForAccount } = await import('../entitlement-usage.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

function directAccount(email) {
  const db = openDb();
  const id = uuid();
  db.prepare('INSERT INTO accounts (id, email, created_at, plan) VALUES (?, ?, ?, ?)').run(id, email, nowIso(), 'free');
  return id;
}

const accountId = directAccount('expired-late-success@example.com');

// ① old 슬롯 reserve.
const oldReservation = reservePlaceLookupSlot(accountId, 'local-old', 'query-old');
t('① old 슬롯이 잠정 예약됨', oldReservation.ok === true && oldReservation.provisional === true && !!oldReservation.reservationId);

// ② old 예약 created_at을 실제로 오래된 시각으로 되돌린다(스윕 대상이 되도록).
{
  const db = openDb();
  const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1시간 전.
  db.prepare('UPDATE entitlement_place_reservations SET created_at = ? WHERE reservation_id = ?').run(longAgo, oldReservation.reservationId);
}

// ③ new 슬롯 reserve — 이 호출 안에서 sweepStaleReservations가 old를
//    실제로 회수한다(예약 행 삭제 + 사용량 -1).
const newReservation = reservePlaceLookupSlot(accountId, 'local-new', 'query-new');
t('③ new 슬롯도 잠정 예약됨', newReservation.ok === true && newReservation.provisional === true);
const db0 = openDb();
const oldRowGoneAfterSweep = !db0.prepare('SELECT 1 FROM entitlement_place_reservations WHERE reservation_id = ?').get(oldReservation.reservationId);
t('③ old 예약 행이 스윕으로 실제로 사라짐', oldRowGoneAfterSweep);
const usageAfterSweep = usageSummaryForAccount(accountId).placeLookups.used;
t('③ 스윕 후 사용량이 정확히 1(old reserve+1, new reserve+1, old 스윕 회수-1)', usageAfterSweep === 1);

// ④ new를 real-new 성공으로 finalize — 정상 경로.
const r4 = finalizePlaceLookupResult(accountId, 'local-new', newReservation, { ok: true, placeId: 'real-new' });
t('④ new 확정 성공', r4.ok === true);
t('④ 확정 직후 사용량 1(아직 old의 뒤늦은 성공 처리 전)', usageSummaryForAccount(accountId).placeLookups.used === 1);

// ⑤ 이미 스윕으로 회수된(만료된) old 예약을 뒤늦게 "성공"으로 finalize —
//    재현하려는 바로 그 상황(응답이 스윕보다 늦게 도착).
const r5 = finalizePlaceLookupResult(accountId, 'local-old', oldReservation, { ok: true, placeId: 'real-old' });
t('⑤ 뒤늦은 old 성공 finalize 자체는 정상 응답(호출은 실패 아님)', r5.ok === true);

const confirmedCount = openDb().prepare('SELECT COUNT(*) AS n FROM entitlement_place_confirmed WHERE account_id = ?').get(accountId).n;
const finalUsage = usageSummaryForAccount(accountId).placeLookups.used;
t('버그였던 시절: confirmed=2인데 used=1로 old가 공짜 확정 — 이제는 그렇지 않음', !(confirmedCount === 2 && finalUsage === 1));
t('수정 확인: 실제 신규 확인 2건(real-new, real-old) 모두 사용량에 정확히 반영됨(confirmed=2, used=2)', confirmedCount === 2 && finalUsage === 2);

// =====================================================================
// 6) 정상 시나리오(기존 지시 유지) — 재사용 미차감, 실패 미차감,
//    한도 도달 시 정직한 거절.
// =====================================================================
const reuseReservation = reservePlaceLookupSlot(accountId, 'local-reuse', 'query-reuse');
const reuseResult = finalizePlaceLookupResult(accountId, 'local-reuse', reuseReservation, { ok: true, placeId: 'real-new' }); // 이미 확인된 실제 장소 재사용.
t('6) 이미 확인된 실제 장소 재사용은 사용량을 안 늘림', reuseResult.ok === true && usageSummaryForAccount(accountId).placeLookups.used === 2);

const failReservation = reservePlaceLookupSlot(accountId, 'local-fail', 'query-fail');
finalizePlaceLookupResult(accountId, 'local-fail', failReservation, { ok: false });
t('6) 실패한 조회는 사용량을 안 늘림(잠정 예약 되돌림)', usageSummaryForAccount(accountId).placeLookups.used === 2);

for (let i = 0; i < 8; i++) {
  const r = reservePlaceLookupSlot(accountId, 'local-fresh-' + i, 'query-fresh-' + i);
  finalizePlaceLookupResult(accountId, 'local-fresh-' + i, r, { ok: true, placeId: 'real-fresh-' + i });
}
t('6) 정상적으로 8건을 더 신규 확인하면 사용량이 10(한도)까지 정확히 오름', usageSummaryForAccount(accountId).placeLookups.used === 10);

const overLimitReservation = reservePlaceLookupSlot(accountId, 'local-over', 'query-over');
t('6) 한도 도달 후 신규 시도는 정직하게 거절되거나 한도초과로 표시됨', overLimitReservation.ok === false || overLimitReservation.overLimit === true);

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
