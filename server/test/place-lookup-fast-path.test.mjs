'use strict';
/**
 * 2026-09-10 재검토(8차) 2절 — ChatGPT가 재현한 "빠른 경로" 우회.
 *
 * 재현 순서(원문 그대로):
 *  1) 무료 한도 1곳.
 *  2) 첫 결과 actual-A로 성공(신규 확정, 사용량 1).
 *  3) 같은 조회 조건(같은 로컬 id + 같은 검색 지문)의 다음 결과가
 *     actual-B로 성공 — 공급자가 실제로 다른 장소를 돌려줬다(캐시
 *     만료 후 재조회 시 실제로 바뀔 수 있음, 재현을 위해 이 테스트는
 *     entitlement-usage.mjs를 직접 호출해 이 상황을 강제로 만든다).
 *  4) 예전 코드는 "같은 로컬 슬롯+같은 검색 조건"이면 무조건 빠른
 *     경로(isNew:false)로 통과시키고, finalize에서도 실제 반환된
 *     placeId가 바뀌었는지 전혀 대조하지 않은 채 링크만 B로 바꿨다
 *     — 링크는 B로 바뀌는데 사용량은 계속 1로만 남았다(진짜 신규
 *     확인인데 공짜로 처리됨).
 *
 * places.mjs가 아니라 entitlement-usage.mjs를 직접 호출한다 — 이
 * 결함은 캐시 계층과 무관하게 이 파일 자체의 판정 로직에 있고, HTTP
 * 계층의 짧은 캐시(10분)를 우회해 "같은 질의가 실제로 다른 결과를
 * 낸" 상황을 직접·정확히 재현하기 위해서다.
 *
 * 실행: node server/test/place-lookup-fast-path.test.mjs
 */
process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'development';
process.env.ENTITLEMENT_FREE_PLACE_LOOKUP_LIMIT = '1';

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
// 1) 정확히 지시된 재현 — 같은 슬롯+같은 검색 지문인데 실제 반환된
//    장소가 바뀌면, 빠른 경로라도 "진짜 신규 확인"으로 다시 판정해야
//    한다. 한도(1곳)를 이미 다 썼으니 이번엔 성공으로 처리되면 안
//    된다.
// =====================================================================
{
  const acc = directAccount('fast-path-bypass@example.com');
  const fp = 'query-fingerprint-1';

  const r1 = reservePlaceLookupSlot(acc, 'slot-x', fp);
  t('사전 조건 — 첫 예약은 신규로 판정됨', r1.ok && r1.isNew === true);
  finalizePlaceLookupResult(acc, 'slot-x', r1, { ok: true, placeId: 'actual-A' });
  const usageAfterFirst = usageSummaryForAccount(acc);
  t('사전 조건 — 첫 확인이 실제로 사용량 1로 기록됨(한도 1 전부 소진)', usageAfterFirst.placeLookups.used === 1 && usageAfterFirst.placeLookups.remaining === 0);

  // 같은 로컬 슬롯 + 같은 검색 지문 — 예전 코드라면 여기서 곧바로
  // "신규 아님"으로 통과했다.
  const r2 = reservePlaceLookupSlot(acc, 'slot-x', fp);
  t('빠른 경로 조건(같은 슬롯+같은 지문)이 실제로 걸림(재현 전제 확인)', r2.ok && r2.isNew === false);

  // 그런데 실제로 돌아온 장소는 actual-A가 아니라 actual-B다(공급자가
  // 실제로 다른 결과를 줬다) — 이건 더 이상 "그 반복 재조회"가 아니다.
  const fin2 = finalizePlaceLookupResult(acc, 'slot-x', r2, { ok: true, placeId: 'actual-B' });
  t('실제 반환 장소가 바뀌면 빠른 경로라도 신규로 재판정하고, 한도가 없으므로 성공 처리하지 않음', fin2 && fin2.ok === false && fin2.reason === 'entitlement-place-lookup-limit-reached');

  const usageAfterSecond = usageSummaryForAccount(acc);
  t('한도 초과로 거부된 두 번째 확인은 사용량을 추가로 안 깎음(여전히 1)', usageAfterSecond.placeLookups.used === 1);
}

// =====================================================================
// 2) 같은 반복이어도 한도에 여유가 있으면, 실제로 다른 장소로
//    밝혀졌을 때 정직하게 신규로 과금돼야 한다(위 1번과 짝 — "한도가
//    있으면 원자적으로 확인·차감"의 성공 경로).
// =====================================================================
{
  const acc = directAccount('fast-path-with-room@example.com');
  const fp = 'query-fingerprint-2';
  const r1 = reservePlaceLookupSlot(acc, 'slot-y', fp);
  finalizePlaceLookupResult(acc, 'slot-y', r1, { ok: true, placeId: 'actual-C' });
  t('사전 조건 — 첫 확인 성공(사용량 1, 한도 1이라 이 계정도 이미 소진)', usageSummaryForAccount(acc).placeLookups.used === 1);

  // 이번엔 실제로 같은 장소(actual-C)가 그대로 반복 확인된 경우 —
  // 진짜 무료 재사용이니 한도가 이미 다 찼어도 여전히 통과해야 한다.
  const r2 = reservePlaceLookupSlot(acc, 'slot-y', fp);
  const fin2 = finalizePlaceLookupResult(acc, 'slot-y', r2, { ok: true, placeId: 'actual-C' });
  t('실제로 같은 장소가 반복 확인되면(진짜 재사용) 한도와 무관하게 여전히 성공', fin2 && fin2.ok === true);
  t('진짜 재사용은 사용량을 추가로 안 깎음(그대로 1)', usageSummaryForAccount(acc).placeLookups.used === 1);
}

// =====================================================================
// 3) "다른 id + 같은 실제 장소" 비과금 규칙(7차)이 빠른 경로 재판정
//    에서도 그대로 지켜지는지 — 슬롯이 바뀌어도 이미 확인된 실제
//    장소면 비과금이어야 한다.
// =====================================================================
{
  const acc = directAccount('fast-path-other-slot@example.com');
  const r1 = reservePlaceLookupSlot(acc, 'slot-z1', 'fp-z');
  finalizePlaceLookupResult(acc, 'slot-z1', r1, { ok: true, placeId: 'actual-D' });
  t('사전 조건 — slot-z1로 actual-D 확인 성공', usageSummaryForAccount(acc).placeLookups.used === 1);

  // 다른 로컬 슬롯이 같은 실제 장소(actual-D)로 확인됐다 — 슬롯 자체가
  // 다르니 빠른 경로는 안 걸리지만(신규 예약 시도), 실제 장소가 이미
  // 확인된 것이므로 finalize에서 비과금 처리돼야 한다.
  const r2 = reservePlaceLookupSlot(acc, 'slot-z2', 'fp-z');
  t('다른 로컬 슬롯이라 빠른 경로가 안 걸림(신규 시도로 판정)', r2.isNew === true);
  const fin2 = finalizePlaceLookupResult(acc, 'slot-z2', r2, { ok: true, placeId: 'actual-D' });
  t('다른 슬롯이 같은 실제 장소로 확인되면 여전히 비과금 처리됨', fin2 && fin2.ok === true);
  t('사용량이 추가로 안 깎임(그대로 1)', usageSummaryForAccount(acc).placeLookups.used === 1);
}

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
