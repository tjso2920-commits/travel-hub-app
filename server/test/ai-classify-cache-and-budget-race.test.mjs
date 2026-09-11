'use strict';
/**
 * 2026-09-11 재검토(11차) 4절 — AI 분류 원가 통제 강화 검증:
 *  1) 입력 최소화 — 개인 메모(note)는 서버로 전혀 넘어가지 않고
 *     confirmedTypes만 어댑터 입력에 반영됨(같은 이름·주소라도
 *     confirmedTypes가 다르면 다른 입력으로 취급됨, note는 달라도
 *     같은 입력으로 취급됨).
 *  2) 입력 해시+분류버전+계정별 캐시 — 같은 항목을 다시 보내면 AI를
 *     다시 안 부르고(비용도 다시 안 물고) 저장된 결과를 그대로 줌.
 *     분류 버전이 바뀌면 캐시가 무효화되어 다시 분류함.
 *  3) 전체(서비스 전역) 하루 배치 한도 — 계정 한도와 별개로 존재함.
 *  4) 헤드룸-차감 후 charge 경합 방지 — periodCapMicros를 헤드룸이
 *     반영된 값으로 좁혀서 넘기므로, 헤드룸을 이미 다 쓴 뒤의 추가
 *     분류 요청은 원자적 트랜잭션 안에서 실제로 거절됨(단순히 "읽은
 *     시점의 헤드룸"만 보고 통과시키지 않음).
 *
 * 실행: node server/test/ai-classify-cache-and-budget-race.test.mjs
 */
process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'development';
process.env.AI_CLASSIFY_ADAPTER = 'mock';
process.env.AI_CLASSIFY_MAX_ITEMS_PER_BATCH = '200'; // 4절에서 헤드룸이 감당하는 만큼(보통 200 미만)을 한 배치로 그대로 보내야 하므로 배치 크기 상한에 먼저 잘리지 않게 넉넉히 잡는다.
process.env.AI_CLASSIFY_PER_ACCOUNT_DAILY_BATCH_LIMIT = '50';
process.env.AI_CLASSIFY_GLOBAL_DAILY_BATCH_LIMIT = '20'; // 3절에서 peek()으로 현재값을 읽어 정확히 채우므로 다른 절과 안 부딪히게 넉넉히 잡되, cost-ledger.mjs의 전역 원가 안전상한(기본 하루 3,000원 ≈ 1,000건×3원)보다는 훨씬 작게 둬서 "전체 배치 횟수 한도" 검증이 실제 원가 한도에 먼저 걸려버리지 않게 한다.
process.env.ENTITLEMENT_FREE_PLACE_LOOKUP_LIMIT = '10';
process.env.ENTITLEMENT_FREE_COURSE_LIMIT = '1';
process.env.COST_SAFETY_CAP_FREE_KRW_MICROS = String(700_000_000); // 700원.

const { config } = await import('../config.mjs');
const { openDb, uuid, nowIso } = await import('../db.mjs');
const { classifyBatchRoute } = await import('../routes/ai-classify.mjs');
const { currentPeriod, reservePlaceLookupSlot, finalizePlaceLookupResult, aiClassifyBudgetHeadroomMicros } = await import('../entitlement-usage.mjs');
const { periodCostMicros, chargeCost } = await import('../cost-ledger.mjs');
const { peek, dayWindow } = await import('../rate-limit.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

function directAccount(email) {
  const db = openDb();
  const id = uuid();
  db.prepare('INSERT INTO accounts (id, email, created_at, plan) VALUES (?, ?, ?, ?)').run(id, email, nowIso(), 'free');
  return id;
}

// 위치확인 제공량을 전부 소진해서(다 써서) 핵심 예약분을 0으로 만들고
// AI 헤드룸을 충분히 확보한 계정 — 캐시/한도 검증에 방해되지 않게
// 매번 이 헬퍼로 "여유 있는" 계정을 만든다.
function accountWithHeadroom(email) {
  const acc = directAccount(email);
  for (let i = 0; i < 10; i++) {
    const r = reservePlaceLookupSlot(acc, 'local-' + i, 'query-' + i);
    finalizePlaceLookupResult(acc, 'local-' + i, r, { ok: true, placeId: 'real-' + i });
  }
  return acc;
}

// =====================================================================
// 1) 입력 최소화 — note는 무시되고 confirmedTypes가 실제로 입력에
//    반영된다(캐시 해시가 note 변화에 무반응, confirmedTypes 변화에는
//    반응함을 통해 간접 확인).
// =====================================================================
{
  const acc = accountWithHeadroom('ai-cache-note@example.com');
  const item = { localId: 'p1', name: '스시 하나', address: '후쿠오카시', note: '첫 번째 메모(개인정보 예시)' };
  const r1 = await classifyBatchRoute(acc, [item]);
  t('1) 첫 호출은 실제로 분류를 수행함(processedCount=1)', r1.ok === true && r1.processedCount === 1 && r1.cachedCount === 0);

  // 같은 name/address, note만 다르게 다시 보낸다 — 캐시 히트로
  // 처리돼야 한다(개인 메모는 해시에 안 들어가므로).
  const itemDifferentNote = { ...item, note: '완전히 다른 메모' };
  const r2 = await classifyBatchRoute(acc, [itemDifferentNote]);
  t('1) note만 바뀐 같은 항목은 캐시로 처리됨(다시 분류 안 함)', r2.ok === true && r2.processedCount === 0 && r2.cachedCount === 1);

  // confirmedTypes가 다르면 실제로 다른 입력으로 취급돼 다시 분류돼야
  // 한다.
  const itemDifferentTypes = { ...item, confirmedTypes: ['restaurant'] };
  const r3 = await classifyBatchRoute(acc, [itemDifferentTypes]);
  t('1) confirmedTypes가 다르면 다른 입력으로 취급돼 다시 분류함', r3.ok === true && r3.processedCount === 1 && r3.cachedCount === 0);
}

// =====================================================================
// 2) 캐시 — 재가져오기/재접속을 흉내낸 같은 항목 재전송은 비용을 다시
//    물지 않는다. 분류 버전이 바뀌면 캐시가 무효화된다.
// =====================================================================
{
  const acc = accountWithHeadroom('ai-cache-cost@example.com');
  const item = { localId: 'p1', name: '카페 모모', address: '서울시' };
  const r1 = await classifyBatchRoute(acc, [item]);
  const period = currentPeriod(acc);
  const costAfterFirst = periodCostMicros(acc, period.periodId);
  t('2) 첫 분류는 실제로 비용이 기록됨', costAfterFirst > 0);

  const r2 = await classifyBatchRoute(acc, [item]);
  const costAfterSecond = periodCostMicros(acc, period.periodId);
  t('2) 같은 항목을 다시 보내도(재가져오기/재접속 흉내) 비용이 그대로임(다시 과금 안 됨)', costAfterSecond === costAfterFirst);
  t('2) 캐시 응답도 원래 결과와 같은 category를 돌려줌', r2.results[0].category === r1.results[0].category);

  // 분류 버전을 올리면(프롬프트/검증 규칙 변경 상황을 흉내) 캐시가
  // 무효화돼 다시 분류되고 비용이 늘어야 한다.
  process.env.AI_CLASSIFY_VERSION = '2';
  // config는 process.env를 최초 로드 시에만 읽으므로, 버전 무효화
  // 자체는 실제 재기동 없이 이 프로세스 안에서 검증할 수 없다 — 대신
  // 캐시 테이블에 다른 classification_version 값이 별도로 남아 캐시가
  // 자연히 무효화되는 구조임을 DB 레벨에서 직접 확인한다.
  const db = openDb();
  const rows = db.prepare('SELECT classification_version FROM ai_classify_cache WHERE account_id = ?').all(acc);
  t('2) 캐시 행이 현재 분류버전으로 저장됨(버전이 바뀌면 이 값과 안 맞아 자연히 무효화됨)', rows.length > 0 && rows.every((r) => r.classification_version === config.aiClassify.classificationVersion));
  delete process.env.AI_CLASSIFY_VERSION;
}

// =====================================================================
// 4) 헤드룸-차감 charge 경합 방지 — "헤드룸을 읽는 시점"과 "실제로
//    charge하는 시점" 사이에 동시 요청 두 개가 끼어들면, 고친 코드가
//    실제로 두 번째를 atomic 트랜잭션에서 막는지 확인한다. 두 "동시"
//    요청이 정확히 같은(스테일한) 헤드룸 스냅샷을 각자 읽고 각자
//    "감당 가능"이라고 판단한 뒤 거의 동시에 charge를 시도하는 상황을
//    그대로 재현한다 — classifyBatchRoute를 두 번 순차 호출하면 두
//    번째 호출이 항상 최신 헤드룸을 다시 읽어버려(스테일하지 않게 돼)
//    이 경합 자체를 재현할 수 없으므로, 라우트가 실제로 쓰는
//    headroomAdjustedCapMicros 계산과 chargeCost 호출을 여기서 직접
//    두 번 반복해 "같은 스냅샷을 공유하는 두 동시 요청"을 흉내낸다.
// =====================================================================
{
  const acc = directAccount('ai-headroom-race@example.com'); // 신선한 계정 — 핵심 예약분이 큼(헤드룸이 작음).
  const period = currentPeriod(acc);
  const headroom = aiClassifyBudgetHeadroomMicros(acc, period); // 두 "동시" 요청이 공유하는 스테일한 스냅샷.
  t('4) 준비 확인 — 신선한 계정은 헤드룸이 0보다 큼(테스트가 뜻하는 좁은 여유가 실제로 있음)', headroom.headroomMicros > 0);
  const unitMicros = config.aiClassify.placeholderPerItemMicros;
  const maxAffordable = Math.floor(headroom.headroomMicros / unitMicros);
  t('4) 준비 확인 — 헤드룸으로 감당 가능한 항목 수가 유한함', maxAffordable >= 1);
  const headroomAdjustedCapMicros = Math.max(0, headroom.capMicros - headroom.reservedForCoreMicros);

  // "동시" 요청 1 — 같은 스냅샷을 보고 maxAffordable만큼 charge 시도.
  const charge1 = chargeCost({ accountId: acc, service: 'ai-classify', sku: 'ai-classify-batch', count: maxAffordable, periodId: period.periodId, periodCapMicros: headroomAdjustedCapMicros });
  t('4) 첫 번째 "동시" 요청은 스테일 헤드룸이 실제로 맞아 성공함', charge1.ok === true);

  // "동시" 요청 2 — 정확히 같은 스냅샷(같은 periodCapMicros)으로 또
  // maxAffordable만큼 charge 시도. 두 요청을 합치면 헤드룸의 거의 2배를
  // 쓰게 되므로, 원자적 트랜잭션(periodUsed 누적 검사)이 이걸 실제로
  // 막아야 한다 — 막지 못하면 두 동시 요청이 핵심 제공량(위치확인·
  // 코스생성) 몫까지 갉아먹는 원래 버그가 재현된 것이다.
  const charge2 = chargeCost({ accountId: acc, service: 'ai-classify', sku: 'ai-classify-batch', count: maxAffordable, periodId: period.periodId, periodCapMicros: headroomAdjustedCapMicros });
  t('4) 같은 스테일 스냅샷을 본 두 번째 "동시" 요청은 원자적 트랜잭션이 실제로 막음(핵심 제공량 몫을 지킴)', charge2.ok === false && charge2.reason === 'entitlement-period-cost-safety-cap-exceeded');
}

// =====================================================================
// 3) 전체(서비스 전역) 하루 배치 한도 — 계정이 서로 달라도 전체 한도에
//    걸린다. 앞선 절들이 이미 전역 카운터를 얼마나 썼는지 peek()으로
//    읽어(직접 증가시키지 않고) 남은 여유를 정확히 채운 뒤, 그다음
//    한 번은 반드시 거절돼야 한다 — 파일 안 다른 절의 실행 순서·횟수가
//    바뀌어도 이 절이 깨지지 않게 하드코딩된 횟수 대신 실측값을 쓴다.
//    (전역 카운터를 실제로 상한까지 채우는 검증이라 이 프로세스 안에서
//    되돌릴 방법이 없다 — 이후 다른 AI 분류 호출에 영향을 주지 않도록
//    일부러 이 파일의 마지막 절로 둔다.)
// =====================================================================
{
  const globalLimit = config.aiClassify.globalDailyBatchLimit;
  const usedSoFar = peek('ai-classify:global', dayWindow());
  const remaining = Math.max(0, globalLimit - usedSoFar);
  for (let i = 0; i < remaining; i++) {
    const acc = accountWithHeadroom(`ai-global-cap-fill-${i}@example.com`);
    const r = await classifyBatchRoute(acc, [{ localId: 'gf' + i, name: '채우기가게' + i }]);
    if (!r.ok) { t(`3) 준비 단계(${i}번째 채우기 호출)가 예상외로 실패함`, false); }
  }
  t('3) 전체 한도를 정확히 다 채울 때까지는 계속 성공함', peek('ai-classify:global', dayWindow()) === globalLimit);

  const accOver = accountWithHeadroom('ai-global-cap-over@example.com');
  const rOver = await classifyBatchRoute(accOver, [{ localId: 'gOver', name: '한도초과가게' }]);
  t('3) 전체 한도를 다 채운 뒤의 다음 호출(다른 계정이어도)은 전체 한도로 거절됨', rOver.ok === false && rOver.status === 503 && rOver.reason === 'ai-classify-service-daily-cap-reached');
}

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
