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
 *  5) (12차 신규) 캐시 localId 오염 방지 — ChatGPT가 실제로 재현한
 *     결함: localId A로 분류→캐시된 뒤, 완전히 다른 localId B가 우연히
 *     같은 이름·주소·confirmedTypes로 요청하면 캐시 결과가 A의
 *     localId를 그대로 돌려줬다(B의 요청인데 A로 응답). 캐시는 분류
 *     내용만 저장하고, 응답은 항상 지금 요청의 localId로 라벨링해야
 *     한다.
 *  6) (12차 신규) 동시 요청 중복 처리·비용 이중기록 방지 — 같은 계정·
 *     입력·분류버전의 캐시미스 요청 두 개를 Promise.all로 동시에
 *     보내도 실제 분류(및 과금)는 한 번만 일어나고, 둘 다 각자의
 *     localId로 정확한 결과를 받는다. 배치 하나 안에 동일 입력이
 *     여러 개 있어도 마찬가지다.
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
// 5) (12차 신규) 캐시 localId 오염 방지 — 서로 다른 localId가 우연히
//    같은 입력(이름·주소·confirmedTypes)을 가지면, 두 번째 요청의
//    캐시 응답이 반드시 "두 번째 요청 자신의 localId"로 와야 한다 —
//    첫 번째 요청 때의 localId가 그대로 새어 나오면 안 된다.
// =====================================================================
{
  const acc = accountWithHeadroom('ai-cache-localid@example.com');
  const itemA = { localId: 'place-A', name: '우연히같은가게', address: '같은주소시' };
  const itemB = { localId: 'place-B', name: '우연히같은가게', address: '같은주소시' }; // A와 완전히 같은 입력, localId만 다름.

  const rA = await classifyBatchRoute(acc, [itemA]);
  t('5) 첫 요청(A)은 실제로 분류되고 자기 localId로 응답함', rA.ok === true && rA.processedCount === 1 && rA.results[0].localId === 'place-A');

  const rB = await classifyBatchRoute(acc, [itemB]);
  t('5) 같은 입력이지만 다른 localId(B)로 보내면 캐시로 처리되면서도 B 자신의 localId로 응답함', rB.ok === true && rB.processedCount === 0 && rB.cachedCount === 1 && rB.results[0].localId === 'place-B');
  t('5) B의 응답에 A의 localId가 잘못 섞여 나오지 않음', rB.results[0].localId !== 'place-A');
  t('5) 분류 내용(category)은 같은 입력이므로 A와 B가 동일함', rB.results[0].category === rA.results[0].category);

  // 한 배치 안에 서로 다른 localId·같은 입력이 여러 개 섞여 있어도
  // 각자 자기 localId로 정확히 응답해야 한다.
  const itemC = { localId: 'place-C', name: '또다른우연가게', address: '주소2' };
  const itemD = { localId: 'place-D', name: '또다른우연가게', address: '주소2' };
  const rBatch = await classifyBatchRoute(acc, [itemC, itemD]);
  t('5) 한 배치 안에서도 서로 다른 localId가 각자 정확히 매칭됨', rBatch.ok === true);
  const byId = new Map(rBatch.results.map((r) => [r.localId, r]));
  t('5) 배치 응답에 C·D 각각의 localId가 정확히 존재함(서로 안 섞임)', byId.has('place-C') && byId.has('place-D'));
}

// =====================================================================
// 6) (12차 신규) 동시 요청 중복 처리·비용 이중기록 방지 — ChatGPT가
//    실제로 재현한 결함: 같은 계정·입력·분류버전의 캐시미스 요청 두
//    개를 Promise.all로 동시에 보내면, 예전엔 둘 다 독립적으로
//    "캐시에 없다"고 판단해 각자 분류하고 각자 과금했다(비용 2배).
//    실제로 Promise.all을 써서 재현한다(지시대로 "동일 작업을 합쳐
//    한 번만 처리").
// =====================================================================
{
  const acc = accountWithHeadroom('ai-concurrent-dedup@example.com');
  const itemX = { localId: 'concurrent-X', name: '동시요청가게', address: '동시주소' };
  const itemY = { localId: 'concurrent-Y', name: '동시요청가게', address: '동시주소' }; // X와 완전히 같은 입력, localId만 다름.

  const period0 = currentPeriod(acc);
  const costBefore = periodCostMicros(acc, period0.periodId);
  const [rX, rY] = await Promise.all([
    classifyBatchRoute(acc, [itemX]),
    classifyBatchRoute(acc, [itemY]),
  ]);
  const costAfter = periodCostMicros(acc, period0.periodId);
  const unitMicros = config.aiClassify.placeholderPerItemMicros;

  t('6) 두 동시 요청 모두 성공함', rX.ok === true && rY.ok === true);
  t('6) 각자 자기 localId로 정확한 결과를 받음', rX.results[0].localId === 'concurrent-X' && rY.results[0].localId === 'concurrent-Y');
  t('6) 실제 비용은 딱 한 건 분(합쳐서 한 번만 처리)만 늘어남 — 예전 버그는 2배였음', costAfter - costBefore === unitMicros);
  // processedCount 합계도 실제로 처리된 고유 입력 수(1)를 반영해야
  // 한다 — 두 요청 각각 자기 localId 몫 1건씩만 "처리됨"으로 셈해도
  // 되지만, 핵심은 실제 분류 호출·과금이 한 번만 일어났다는 사실이다.
  t('6) 두 요청 모두 실제로 결과를 받았음(processedCount>=1 또는 캐시 경유)', (rX.processedCount + rX.cachedCount) >= 1 && (rY.processedCount + rY.cachedCount) >= 1);

  // 같은 배치 안에 동일 입력이 여러 번 있어도 마찬가지로 한 번만 처리.
  const accBatch = accountWithHeadroom('ai-inbatch-dedup@example.com');
  const period1 = currentPeriod(accBatch);
  const costBefore2 = periodCostMicros(accBatch, period1.periodId);
  const dupItems = [
    { localId: 'dup-1', name: '배치중복가게', address: '배치주소' },
    { localId: 'dup-2', name: '배치중복가게', address: '배치주소' },
    { localId: 'dup-3', name: '배치중복가게', address: '배치주소' },
  ];
  const rDup = await classifyBatchRoute(accBatch, dupItems);
  const costAfter2 = periodCostMicros(accBatch, period1.periodId);
  t('6) 한 배치 안의 동일 입력 3개도 실제로는 한 번만 과금됨', costAfter2 - costBefore2 === unitMicros);
  const dupIds = new Set(rDup.results.map((r) => r.localId));
  t('6) 그래도 3개 localId 모두 각자 결과를 받음', dupIds.has('dup-1') && dupIds.has('dup-2') && dupIds.has('dup-3'));
}

// =====================================================================
// 7) (13차 신규) 부분적으로 겹치는 동시 요청의 결과 유실 방지 — ChatGPT가
//    지시한 정확한 재현: Promise.all([classifyBatchRoute(acc,[shared]),
//    classifyBatchRoute(acc,[shared,other])]). 두 요청이 같은 항목
//    (shared)을 공유하지만 완전히 같은 배치는 아니다(부분 겹침). 예전
//    (12차) 코드는 "지금 진행 중"이라고 기록만 해 두고, 자기 몫을
//    처리한 "뒤에" 다시 aiClassifyInFlight 맵을 조회했는데, 그 사이
//    원래 진행 중이던 요청(shared를 단독으로 보낸 첫 번째)이 이미 끝나
//    finally가 맵 항목을 지워 버리면 두 번째 요청은 shared의 결과를
//    통째로 잃었다(응답 자체는 ok:true라서 조용히 성공한 것처럼
//    보였다). 실제 Promise.all + 진짜 모의 어댑터로 재현한다(인위적
//    지연 없이도 마이크로태스크 순서만으로 재현됨 — 첫 요청의 결과가
//    두 번째 요청이 자기 몫을 처리하는 동안 이미 확정·정리된다).
// =====================================================================
{
  const acc = accountWithHeadroom('ai-partial-overlap@example.com');
  const itemShared = { localId: 'shared-item', name: '겹치는가게', address: '겹치는주소' };
  const itemOther = { localId: 'other-item', name: '단독가게', address: '단독주소' };

  const period0 = currentPeriod(acc);
  const costBefore = periodCostMicros(acc, period0.periodId);
  const [r1, r2] = await Promise.all([
    classifyBatchRoute(acc, [itemShared]),
    classifyBatchRoute(acc, [itemShared, itemOther]),
  ]);
  const costAfter = periodCostMicros(acc, period0.periodId);
  const unitMicros = config.aiClassify.placeholderPerItemMicros;

  t('7) 준비 확인 — 두 요청 모두 ok:true로 응답함(실패로 위장 안 됨)', r1.ok === true && r2.ok === true);
  t('7) 첫 번째 요청(shared 단독)은 자기 항목 결과를 정상적으로 받음', r1.results.some((x) => x.localId === 'shared-item'));
  // 재현하려던 정확한 결함: 두 번째 요청(shared+other)의 응답에서
  // shared 결과가 사라지지 않아야 한다.
  const r2Ids = new Set(r2.results.map((x) => x.localId));
  t('7) 두 번째 요청(shared+other)의 응답에 shared 결과가 유실되지 않고 그대로 있음', r2Ids.has('shared-item'));
  t('7) 두 번째 요청의 응답에 other 결과도 정상적으로 있음', r2Ids.has('other-item'));
  t('7) 두 번째 요청이 어떤 항목도 "말없이 누락"으로 처리하지 않음(unresolvedCount=0)', r2.unresolvedCount === 0);
  t('7) 첫 번째 요청도 마찬가지로 누락 없음', r1.unresolvedCount === 0);
  // 같은 해시(shared)는 실제로는 딱 한 번만 처리·과금돼야 한다(동일
  // 작업 병합) — shared 1건 + other 1건 = 총 2단위만 늘어야 한다.
  t('7) 실제 비용은 shared 1건 + other 1건, 총 2단위만 늘어남(중복 과금 없음)', costAfter - costBefore === unitMicros * 2);

  // "재시도가 영구 잠금으로 이어지지 않는지" — 위 동시 요청이 완전히
  // 끝난 뒤, shared 항목을 다시(이번엔 단독으로) 요청하면 남은
  // in-flight 잠금 없이 정상적으로 캐시 히트로 처리돼야 한다.
  const r3 = await classifyBatchRoute(acc, [itemShared]);
  t('7) 동시 요청이 끝난 뒤 같은 항목을 다시 요청하면 정상적으로 캐시로 처리됨(잔여 잠금 없음)', r3.ok === true && r3.cachedCount === 1 && r3.processedCount === 0);
  t('7) 재요청 결과도 자기 localId로 정확히 옴', r3.results[0] && r3.results[0].localId === 'shared-item');
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
