'use strict';
/**
 * 2026-09-10 재검토(8차) 2절 — "잠정 예약은 프로세스 종료 시 복구
 * 가능해야 한다"(성공/실패/재시도 경로에서 이중 해제나 영구 소비
 * 없이). reservePlaceLookupSlot이 사용량을 잠정으로 +1 하는 순간부터
 * finalizePlaceLookupResult가 그 상태를 해소할 때까지를
 * entitlement_place_reservations에 "진행 중"으로 남긴다
 * (server/locks.mjs의 generation_locks/payment_locks와 같은 만료
 * 회수 패턴). 여기서는 그 표를 직접 조작해 "서버가 finalize 전에
 * 죽었다"를 재현하고, 다음 reserve 시도가 그 유실된 예약을 실제로
 * 회수하는지 확인한다.
 *
 * 실행: node server/test/place-lookup-reservation-recovery.test.mjs
 */
process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'development';
process.env.ENTITLEMENT_FREE_PLACE_LOOKUP_LIMIT = '3';
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

function reservationCount(accountId) {
  const db = openDb();
  return db.prepare('SELECT COUNT(*) AS n FROM entitlement_place_reservations WHERE account_id = ?').get(accountId).n;
}

// =====================================================================
// 1) 정상 경로 — reserve가 진행 중 표시를 남기고, finalize(신규 확정)가
//    그 표시를 지운다. 죽지 않았으니 다음 reserve 때 아무 것도 회수될
//    게 없어야 한다(사용량이 잘못 되돌려지면 안 됨).
// =====================================================================
{
  const acc = directAccount('reservation-normal@example.com');
  const r1 = reservePlaceLookupSlot(acc, 'slot-1', 'fp-1');
  t('1) 예약 시 진행 중 표시가 남음', reservationCount(acc) === 1);
  const fin1 = finalizePlaceLookupResult(acc, 'slot-1', r1, { ok: true, placeId: 'actual-1' });
  t('1) 신규 확정 성공', fin1 && fin1.ok === true);
  t('1) 확정 후 진행 중 표시가 사라짐(이중 해제 방지 기반)', reservationCount(acc) === 0);
  t('1) 사용량 1로 정상 반영', usageSummaryForAccount(acc).placeLookups.used === 1);
}

// =====================================================================
// 2) 실패 경로 — 외부 호출 실패로 release되면 표시도 함께 사라져야
//    한다(사용량 되돌림 + 표시 제거가 한 트랜잭션).
// =====================================================================
{
  const acc = directAccount('reservation-fail@example.com');
  const r1 = reservePlaceLookupSlot(acc, 'slot-1', 'fp-1');
  t('2) 예약 시 진행 중 표시가 남음', reservationCount(acc) === 1);
  const fin1 = finalizePlaceLookupResult(acc, 'slot-1', r1, { ok: false });
  t('2) 실패 결과는 finalize도 성공(해제 자체는 성공)으로 응답', fin1 && fin1.ok === true);
  t('2) 실패 후 진행 중 표시가 사라짐', reservationCount(acc) === 0);
  t('2) 사용량이 0으로 되돌아감(실패는 미차감)', usageSummaryForAccount(acc).placeLookups.used === 0);
}

// =====================================================================
// 3) 진짜 재현 — 서버가 reserve 직후, finalize를 부르기 **전**에
//    죽었다고 가정한다(진행 중 표시만 남고 아무도 안 지움). 그 상태로
//    타임아웃을 넘겨(created_at을 인위적으로 과거로 되돌려) 다음
//    reserve 시도가 자동으로 그 유실분을 회수하는지 확인한다.
// =====================================================================
{
  const acc = directAccount('reservation-crash@example.com');
  reservePlaceLookupSlot(acc, 'slot-crashed', 'fp-c');
  t('3) 사전 조건 — 죽기 전 잠정 예약으로 사용량이 1로 늘어남', usageSummaryForAccount(acc).placeLookups.used === 1);
  t('3) 사전 조건 — 진행 중 표시가 남아 있음(서버가 죽어 finalize를 못 부름)', reservationCount(acc) === 1);

  // 타임아웃(60초)을 훨씬 넘겼다고 가정 — 죽은 프로세스가 남긴 것으로
  // 판단할 수 있는 상태를 재현한다.
  backdateAllReservations(acc, 3600);

  // 이 계정이 (다른 장소를 확인하려고) 다시 서버에 요청을 보냈다 —
  // 이번 reserve 시도가 죽은 예약을 발견하고 회수해야 한다.
  const r2 = reservePlaceLookupSlot(acc, 'slot-new', 'fp-new');
  t('3) 죽은 예약이 회수되어 진행 중 표시가 사라짐', reservationCount(acc) === 1); // 옛 것 삭제 + 새 것 1개
  t('3) 죽은 예약의 사용량 +1이 되돌려진 뒤 새 예약이 다시 +1 함(순사용량 그대로 1)', usageSummaryForAccount(acc).placeLookups.used === 1);

  const fin2 = finalizePlaceLookupResult(acc, 'slot-new', r2, { ok: true, placeId: 'actual-new' });
  t('3) 회수 이후에도 새 예약은 정상적으로 신규 확정됨', fin2 && fin2.ok === true);
  t('3) 최종 사용량 1(죽은 시도 1건은 영구 소비되지 않고, 새 시도 1건만 정확히 과금)', usageSummaryForAccount(acc).placeLookups.used === 1);
  t('3) 정리 후 진행 중 표시 없음', reservationCount(acc) === 0);
}

// =====================================================================
// 4) 타임아웃 전이면 회수하면 안 된다 — 아직 진행 중일 수도 있는
//    시도를 성급하게 되돌리면 이중 처리(외부 호출은 살아있는데 사용량만
//    풀림) 위험이 생긴다.
// =====================================================================
{
  const acc = directAccount('reservation-not-stale@example.com');
  reservePlaceLookupSlot(acc, 'slot-a', 'fp-a');
  // 타임아웃(60초)에 한참 못 미치게(5초) 되돌린다 — 아직 살아있는
  // 시도로 취급돼야 한다.
  backdateAllReservations(acc, 5);
  reservePlaceLookupSlot(acc, 'slot-b', 'fp-b');
  t('4) 타임아웃 전 예약은 회수되지 않고 그대로 남음', reservationCount(acc) === 2);
  t('4) 사용량도 그대로 2(잘못 되돌려지지 않음)', usageSummaryForAccount(acc).placeLookups.used === 2);
}

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
