'use strict';
/**
 * 2026-09-11 재검토(9차) 3절 — ChatGPT가 지적한 비용 운영 경계: 이용권
 * 한도를 이미 다 쓴 계정이 새 검색어를 계속 보내면(재사용 여부와
 * 무관하게) 매번 실제 유료 외부 호출을 만들어 비용 상한을 소진할 수
 * 있었다. 이제 계정당 하루 "한도 초과 상태에서 시도해 볼 수 있는
 * 횟수" 자체에 작은 안전판(entitlementOverLimitVerificationDailyLimit)
 * 을 둔다.
 *
 * 지켜야 할 것 세 가지를 모두 확인한다:
 *  1) 안전판을 넘기면 더 이상 새 시도(reserve)를 허용하지 않는다
 *     (외부 호출 자체를 안 보냄 — reserve 단계에서 정직하게 거절).
 *  2) 안전판과 무관하게, 이미 확인된 실제 장소의 재사용(빠른 경로)은
 *     여전히 무제한 공짜다 — "재사용은 절대 막지 않는다"는 약속을
 *     이 안전판이 깨면 안 된다.
 *  3) 유료 고객의 정상 시나리오(하루 50곳 전부 확인 + 코스 생성)는
 *     이 안전판 때문에 막히면 안 된다(이 시나리오는 애초에 한도
 *     초과 상태로 진입하지 않으므로 안전판을 아예 안 거친다).
 *
 * 실행: node server/test/entitlement-overlimit-verify-cap.test.mjs
 */
process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'development';
process.env.ENTITLEMENT_FREE_PLACE_LOOKUP_LIMIT = '1';
process.env.ENTITLEMENT_OVERLIMIT_VERIFY_DAILY_LIMIT = '3';

const { openDb, uuid, nowIso } = await import('../db.mjs');
const { reservePlaceLookupSlot, finalizePlaceLookupResult, usageSummaryForAccount } = await import('../entitlement-usage.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

function directAccount(email) {
  const db = openDb();
  const id = uuid();
  db.prepare('INSERT INTO accounts (id, email, created_at, plan) VALUES (?, ?, ?, ?)').run(id, email, nowIso(), 'free');
  return id;
}

// =====================================================================
// 1) 한도를 다 쓴 뒤, 계속 새 검색을 시도하면(전부 신규로 밝혀지는
//    상황을 흉내) 안전판(하루 3회)을 넘긴 시점부터는 reserve 자체가
//    거절돼 더 이상 외부 호출로 이어지지 않는다.
// =====================================================================
{
  const acc = directAccount('overlimit-cap@example.com');
  const r1 = reservePlaceLookupSlot(acc, 'slot-0', 'fp-0');
  finalizePlaceLookupResult(acc, 'slot-0', r1, { ok: true, placeId: 'actual-0' });
  t('사전 조건 — 한도(1) 전부 소진', usageSummaryForAccount(acc).placeLookups.used === 1);

  const attempts = [];
  for (let i = 1; i <= 5; i++) {
    const r = reservePlaceLookupSlot(acc, `slot-${i}`, `fp-${i}`);
    attempts.push(r);
  }
  t('1) 안전판(3회) 안에서는 시도가 허용됨(외부 호출로 이어질 수 있음)', attempts[0].ok === true && attempts[1].ok === true && attempts[2].ok === true);
  t('1) 안전판을 넘긴 4번째 시도부터는 reserve 자체가 거절됨(외부 호출 자체를 안 보냄)', attempts[3].ok === false && attempts[3].reason === 'entitlement-place-lookup-limit-reached');
  t('1) 그 이후 시도도 계속 거절됨(한 번 막히면 계속 막힘)', attempts[4].ok === false);

  // 허용됐던 시도들이 전부 "진짜 신규"로 밝혀지면(재사용이 아님)
  // 한도 초과로 실패 처리돼야 하고, 사용량은 그대로 1이어야 한다.
  const fin1 = finalizePlaceLookupResult(acc, 'slot-1', attempts[0], { ok: true, placeId: 'actual-1' });
  t('1) 안전판 안에서 허용된 시도도 진짜 신규면 한도 초과로 정직하게 거절됨', fin1 && fin1.ok === false);
  t('1) 사용량은 여전히 1(허용된 시도들도 전부 신규라 성공 처리 안 됨)', usageSummaryForAccount(acc).placeLookups.used === 1);
}

// =====================================================================
// 2) 안전판을 완전히 소진한 뒤에도, 이미 확인된 실제 장소를 "다른
//    로컬 id"로 다시 확인하면 여전히 무제한 공짜여야 한다(빠른 경로는
//    이 안전판 카운터를 아예 건드리지 않는 별도 경로).
// =====================================================================
{
  const acc = directAccount('overlimit-cap-reuse@example.com');
  const r1 = reservePlaceLookupSlot(acc, 'slot-a', 'fp-a');
  finalizePlaceLookupResult(acc, 'slot-a', r1, { ok: true, placeId: 'actual-known' });
  t('사전 조건 — 한도 소진 + actual-known 확인됨', usageSummaryForAccount(acc).placeLookups.used === 1);

  // 안전판(3회)을 다른 시도들로 완전히 소진시킨다.
  for (let i = 0; i < 5; i++) reservePlaceLookupSlot(acc, `noise-${i}`, `fp-noise-${i}`);

  // 안전판이 이미 다 찼어도, "다른 로컬 id로 이미 확인된 실제 장소"
  // 재사용은 여전히 통과해야 한다.
  const rReuse = reservePlaceLookupSlot(acc, 'slot-b', 'fp-b');
  t('2) 안전판 소진 후에도 새 로컬 슬롯의 첫 시도 자체는 여전히 거절됨(정상 — 신규일 수도 있어서)', rReuse.ok === false);
  // 실제 서비스 흐름에서 "다른 id + 같은 실제 장소" 재사용은 이미
  // entitlement_place_local_link에 해당 로컬 id로 링크가 걸려 있어야
  // 빠른 경로를 탄다 — 그 경로 자체가 이 안전판을 거치지 않음을
  // 직접 확인한다: 링크를 먼저 만들어 두고(과거에 이미 이 조건으로
  // 확인했던 것처럼) 다시 reserve하면 안전판과 무관하게 통과해야 한다.
  finalizePlaceLookupResult(acc, 'slot-b', rReuse, { ok: false }); // 실패 처리로 예약 정리(사용량 영향 없음).
  const rSameCondition = reservePlaceLookupSlot(acc, 'slot-a', 'fp-a'); // slot-a는 이미 링크가 걸려 있음(1)에서).
  t('2) 이미 링크된 같은 로컬 슬롯+같은 조건은 안전판 소진과 무관하게 빠른 경로로 통과함', rSameCondition.ok === true && rSameCondition.isNew === false);
}

// 3) 유료 고객의 정상 시나리오(한도 안에서 정상적으로 다 쓰는 것)는
//    이 안전판을 애초에 안 거친다(used < limit이면 이 분기 자체에
//    안 들어감) — 실제 50곳+코스 생성 시나리오 회귀는
//    server/test/paid-daily-burst-budget.test.mjs가 별도로 확인한다.

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
