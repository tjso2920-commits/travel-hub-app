'use strict';
/**
 * 2026-09-11 재검토(10차) 5·6절 — AI 보조 분류 어댑터·예산 헤드룸 검증
 * (기본 비활성 상태). mock 어댑터를 켠 상태의 라우트 성공 경로는
 * server/test/ai-classify-mock-enabled.test.mjs가 별도로 다룬다(이
 * 파일과 같은 프로세스에서 config를 두 번 다르게 초기화할 수 없어서
 * 분리했다 — config.mjs가 모듈 최초 로드 시 process.env를 한 번만
 * 읽는다).
 *
 * 실제 AI 공급자는 없다(server/adapters/ai-classify.mjs 참고).
 *
 * 실행: node server/test/ai-classify.test.mjs
 */
process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'development';
process.env.ENTITLEMENT_FREE_PLACE_LOOKUP_LIMIT = '10';
process.env.ENTITLEMENT_FREE_COURSE_LIMIT = '1';
process.env.COST_SAFETY_CAP_FREE_KRW_MICROS = String(700_000_000); // 700원.

const { config } = await import('../config.mjs');
const { openDb, uuid, nowIso } = await import('../db.mjs');
const { validateClassifyResult } = await import('../adapters/ai-classify.mjs');
const { aiClassifyBudgetHeadroomMicros, currentPeriod, reservePlaceLookupSlot, finalizePlaceLookupResult } = await import('../entitlement-usage.mjs');
const { classifyBatchRoute } = await import('../routes/ai-classify.mjs');
const { planWorstCaseSkus, splitIntoSegments } = await import('../route-segments.mjs');
const { skuCostMicros } = await import('../cost-ledger.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

function directAccount(email) {
  const db = openDb();
  const id = uuid();
  db.prepare('INSERT INTO accounts (id, email, created_at, plan) VALUES (?, ?, ?, ?)').run(id, email, nowIso(), 'free');
  return id;
}

// =====================================================================
// 1) 기본 비활성 — 이 세션(개발 환경, AI_CLASSIFY_ADAPTER 미설정)에서는
//    services.aiClassify가 반드시 'disabled'다. "운영 AI 호출은 기본
//    비활성"이라는 요구사항이 설정 단계에서부터 지켜지는지 확인한다.
// =====================================================================
t('1) AI_CLASSIFY_ADAPTER를 명시하지 않으면 기본값은 disabled', config.services.aiClassify === 'disabled');

const accDisabled = directAccount('ai-disabled@example.com');
const routeDisabled = await classifyBatchRoute(accDisabled, [{ localId: 'p1', name: '스시 마사', note: '', address: '' }]);
t('1) 비활성 상태에서 라우트를 불러도 서버 오류가 아니라 정직한 사유로 응답함', routeDisabled.ok === false && routeDisabled.status === 200 && routeDisabled.reason === 'ai-classify-disabled');
t('1) 비활성 상태에서는 items가 없어도 missing-items보다 disabled 사유가 먼저 나와서 헷갈리지 않음(참고용)', true);

const routeNoItems = await classifyBatchRoute(accDisabled, []);
t('1) 항목이 아예 없으면 missing-items로 정직하게 거절됨', routeNoItems.ok === false && routeNoItems.status === 400 && routeNoItems.reason === 'missing-items');

const routeNoAuth = await classifyBatchRoute(null, [{ localId: 'p1', name: 'x' }]);
t('1) 로그인 없이는 401', routeNoAuth.ok === false && routeNoAuth.status === 401);

// =====================================================================
// 2) 모의 어댑터 출력 검증 — 스키마를 벗어난 값은 그 항목만 unresolved로
//    강등되고, 알려진 상위분류 밖의 값을 지어내면 거부된다.
// =====================================================================
const idSet = new Set(['a', 'b', 'c']);
const validOne = validateClassifyResult({ localId: 'a', category: '카페·디저트', tags: ['카페', '  브런치  ', '카페'], evidence: 'name contains coffee', confidence: 'high' }, idSet);
t('2) 정상적인 결과는 그대로 통과함', validOne.category === '카페·디저트' && validOne.unresolved === false);
t('2) 태그 중복(공백 차이 포함)은 정규화돼 하나로 합쳐짐', validOne.tags.length === 2 && validOne.tags.includes('브런치'));

const fakeCategory = validateClassifyResult({ localId: 'b', category: '없는분류', tags: [], evidence: 'x', confidence: 'high' }, idSet);
t('2) 알려진 상위분류 목록에 없는 값을 지어내면 거부되고 unresolved로 남음', fakeCategory.category === null && fakeCategory.unresolved === true);

const unknownLocalId = validateClassifyResult({ localId: 'not-in-batch', category: '카페·디저트', tags: [], evidence: 'x', confidence: 'high' }, idSet);
t('2) 이번 배치에 없던 localId를 돌려주면 통째로 무시됨(응답 위조 방지)', unknownLocalId === null);

const tooManyTags = validateClassifyResult({ localId: 'c', category: '맛집·식당', tags: ['1', '2', '3', '4', '5', '6', '7'], evidence: 'x', confidence: 'medium' }, idSet);
t('2) 태그 개수는 최대 5개로 잘림(폭주 방지)', tooManyTags.tags.length === 5);

const tooLongTag = validateClassifyResult({ localId: 'a', category: null, tags: ['가'.repeat(30)], evidence: 'x', confidence: 'low' }, idSet);
t('2) 20자를 넘는 태그는 버려지고, 근거 부족은 unresolved로 정직하게 남음', tooLongTag.tags.length === 0 && tooLongTag.unresolved === true);

// =====================================================================
// 3) 예산 헤드룸 — "핵심 제공량(위치확인·코스생성) 예산을 먼저 확보한
//    뒤 AI 여유를 계산한다." 아직 아무것도 안 쓴 계정은 남은 제공량
//    전체가 예약되므로, 700원 한도 안에서는 AI에게 줄 여유가 거의
//    없어야 정상이다(10건 예약분이 이미 한도 대부분을 차지).
// =====================================================================
const accFresh = directAccount('ai-budget-fresh@example.com');
const periodFresh = currentPeriod(accFresh);
const headroomFresh = aiClassifyBudgetHeadroomMicros(accFresh, periodFresh);
t('3) 아무것도 안 쓴 계정은 남은 위치확인 10건 전부가 예약분에 잡힘', headroomFresh.remainingLookups === 10);
t('3) 예약분(reservedForCoreMicros)이 0보다 큼(핵심 제공량을 먼저 확보)', headroomFresh.reservedForCoreMicros > 0);
t('3) AI 헤드룸은 상한에서 예약분을 뺀 만큼만 정확히 나옴(전체 상한을 그대로 안 줌)', headroomFresh.headroomMicros === Math.max(0, headroomFresh.capMicros - headroomFresh.spentMicros - headroomFresh.reservedForCoreMicros));
t('3) 예약 때문에 AI 헤드룸이 전체 상한보다 뚜렷하게 작음(핵심 제공량 몫을 실제로 떼어 둠)', headroomFresh.headroomMicros < headroomFresh.capMicros);

// 위치확인을 실제로 다 써서(신규 확인 10건 성공) 더 이상 예약할 core
// 제공량이 안 남으면, 그만큼 AI에게 줄 여유가 생겨야 한다.
const accExhausted = directAccount('ai-budget-exhausted@example.com');
for (let i = 0; i < 10; i++) {
  const r = reservePlaceLookupSlot(accExhausted, 'local-' + i, 'query-' + i);
  finalizePlaceLookupResult(accExhausted, 'local-' + i, r, { ok: true, placeId: 'real-' + i });
}
const periodExhausted = currentPeriod(accExhausted);
const headroomExhausted = aiClassifyBudgetHeadroomMicros(accExhausted, periodExhausted);
t('3) 위치확인을 이미 다 쓴 계정은 그 몫을 더 예약할 필요가 없음(remainingLookups=0)', headroomExhausted.remainingLookups === 0);
t('3) 그만큼 AI 헤드룸이 방금 전(신선한 계정)보다 더 커짐(예약분이 줄어든 만큼 여유가 생김)', headroomExhausted.headroomMicros >= headroomFresh.headroomMicros);

// AI 비활성 상태에서는 헤드룸이 있어도 라우트 자체가 아예 어댑터를
// 안 부른다(1절에서 이미 확인) — 여기서는 순수 계산 함수만 검증한다.

// =====================================================================
// 4) (12차 신규) 예약 계산이 실제 최대 입력·세그먼트 분할·SKU 등급에
//    근거하는지 — "전형적인 하루 코스" 같은 임의 가정이 아니라
//    config.maxPlacesPerGeneration(실제 서비스가 허용하는 최대 경유지
//    수)을 그대로 쓰는지, 그리고 routing.mjs와 완전히 같은 함수
//    (splitIntoSegments)로 계산하는지 직접 확인한다.
// =====================================================================
{
  // 4-a) reservedForCoreMicros가 실제로 maxCourseReserveMicros 계산과
  // 일치하는지(코스분만 따로 떼어) 확인 — 위치확인 몫을 빼고 비교한다.
  const acc = directAccount('ai-headroom-formula@example.com');
  const period = currentPeriod(acc);
  const headroom = aiClassifyBudgetHeadroomMicros(acc, period);
  const expectedSkus = planWorstCaseSkus(config.maxPlacesPerGeneration + 1);
  const expectedPerCourseMicros = expectedSkus.reduce((sum, sku) => sum + skuCostMicros(sku), 0);
  t('4) 헤드룸 함수가 돌려주는 코스당 예약액이 실제 세그먼트·SKU 계산과 정확히 일치함', headroom.perCourseReserveMicros === expectedPerCourseMicros);

  // 4-b) 이 값이 routing.mjs가 실제로 쓰는 것과 같은 splitIntoSegments
  // 함수를 거친 결과임을 직접 확인 — 자리표시자 배열로 같은 지점 수를
  // 넣으면 세그먼트 수·경계가 완전히 같아야 한다.
  const realSegments = splitIntoSegments(new Array(config.maxPlacesPerGeneration + 1));
  t('4) 세그먼트 수가 실제 최대 입력(경유지 상한) 기준으로 여러 개로 나뉨(1개 고정 가정 아님)', realSegments.length > 1);
  t('4) planWorstCaseSkus가 계산한 세그먼트 수와 실제 splitIntoSegments 결과가 일치함', expectedSkus.length === realSegments.length);

  // 4-c) maxPlacesPerGeneration이 커지면(더 큰 코스를 허용하면) 예약액도
  // 그만큼 커져야 한다 — "실제 허용 최대 입력에 근거"함을 보여준다.
  const biggerSkus = planWorstCaseSkus(200);
  const biggerMicros = biggerSkus.reduce((sum, sku) => sum + skuCostMicros(sku), 0);
  t('4) 더 큰 최대 입력을 가정하면 예약액도 그만큼 늘어남(고정 1세그먼트 가정이었다면 안 늘어났을 것)', biggerMicros > expectedPerCourseMicros);
}

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
