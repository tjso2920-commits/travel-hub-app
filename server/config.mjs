'use strict';
/**
 * 서버 설정 — 로드맵 ⑧(유료 출시 준비) 실제 구현.
 *
 * 2026-09-10 재검토(3차) 반영 — "명시적인 development/test/production
 * 환경을 도입하고 production에서는 키가 없는 기능을 unavailable로
 * 처리하거나 필수 설정 누락으로 시작을 거부하라." 예전 버전은 "키가
 * 있으면 real, 없으면 test"만 판정했다 — production에 실수로 키를 안
 * 넣고 배포해도 서버가 조용히 test 어댑터로 도는 사고가 가능했다.
 * 이제는 세 가지 명시적 환경(APP_ENV)이 있고:
 *   - development/test: 예전처럼 키 유무로 real/test를 판정한다(로컬
 *     개발 편의 유지).
 *   - production: 키가 없는 서비스는 'test'가 아니라 **'unavailable'**
 *     이다 — 가짜 응답을 절대 안 주고, 그 기능만 정직하게 막힌다.
 *     그리고 결제·이메일처럼 이게 없으면 서비스 자체가 의미 없는
 *     핵심 크리덴셜은 아예 **서버 시작을 거부한다**(assertBootReady 참고,
 *     index.mjs가 실제 리스닝 직전에 부른다 — config.mjs를 그냥
 *     import만 해도 되는 테스트 코드는 안 건드린다).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function serviceModeDev(forceTest, keyPresent, adapterOverride) {
  if (forceTest) return 'test';
  if (adapterOverride === 'test') return 'test';
  return keyPresent ? 'real' : 'test';
}

/* USD/1,000회 단가 → 계산용 환율(가정) → 마이크로원 단가로 변환한다.
   *_KRW_MICROS 환경변수를 직접 주면(고급 사용 — 실제 계약 후 정확한
   원화 단가를 알게 됐을 때) 그 값을 그대로 쓰고, 아니면 위 USD 단가·
   환율로 계산한다. 안전 여유는 여기(단가)가 아니라 costBudget에만
   적용한다 — 실제 원가 계산(BUSINESS_DECISIONS.md)과 예산 안전판을
   같은 숫자로 섞지 않기 위해서다. */
function buildCostEstimateMicros(env) {
  const fx = Number(env.COST_FX_KRW_PER_USD || 1400);
  const usd = {
    placesTextSearchPro: Number(env.COST_PLACES_TEXT_SEARCH_PRO_USD_PER_1000 || 32),
    routesComputeEssentials: Number(env.COST_ROUTES_COMPUTE_ESSENTIALS_USD_PER_1000 || 5),
    routesComputePro: Number(env.COST_ROUTES_COMPUTE_PRO_USD_PER_1000 || 10),
  };
  const fromUsdPer1000 = (usdPer1000) => Math.round((usdPer1000 / 1000) * fx * 1_000_000);
  return {
    placesTextSearchMicros: env.COST_PLACES_TEXT_SEARCH_KRW_MICROS != null
      ? Number(env.COST_PLACES_TEXT_SEARCH_KRW_MICROS)
      : fromUsdPer1000(usd.placesTextSearchPro),
    routesComputeMicros: env.COST_ROUTES_COMPUTE_KRW_MICROS != null
      ? Number(env.COST_ROUTES_COMPUTE_KRW_MICROS)
      : fromUsdPer1000(usd.routesComputeEssentials),
    routesComputeHighVolumeMicros: env.COST_ROUTES_COMPUTE_HIGHVOLUME_KRW_MICROS != null
      ? Number(env.COST_ROUTES_COMPUTE_HIGHVOLUME_KRW_MICROS)
      : fromUsdPer1000(usd.routesComputePro),
  };
}

export function buildConfig(env) {
  env = env || {};
  const forceTest = env.FORCE_TEST_MODE === 'true';
  // APP_ENV를 명시하지 않으면 안전한 쪽(운영 아님)으로 기본값을 둔다 —
  // "설정을 깜빡해서 실수로 운영 모드가 되는" 사고보다 "설정을 깜빡해서
  // 실수로 개발 모드로 남는" 쪽이 훨씬 덜 위험하다(전자는 보안 사고,
  // 후자는 그냥 배포가 정상 동작 안 하는 것으로 바로 티가 난다).
  const appEnv = env.APP_ENV || (forceTest ? 'test' : 'development');
  const isProd = appEnv === 'production';

  const hasPlaceKey = !!env.GOOGLE_PLACES_API_KEY;
  const hasRoutesKey = !!env.GOOGLE_ROUTES_API_KEY;
  const hasPaymentSecret = !!env.PAYMENT_PG_SECRET;
  const hasTossClientKey = !!env.TOSS_CLIENT_KEY;
  const hasEmailKey = !!env.EMAIL_API_KEY;
  // 2026-09-10 재검토(7차) 4절 — 착장 판단용 날씨 카드. 날씨는 장소조회·
  // 결제·이메일과 달리 "이게 없으면 서비스 자체가 의미 없는" 핵심
  // 기능이 아니다(코스·동선 기능이 먼저고, 날씨는 비동기로 얹는
  // 부가 기능) — 그래서 운영에서도 키가 없으면 서버 시작을 막지 않고
  // 그냥 'unavailable'로만 둔다(routing/placeLookup과 같은 원칙).
  const hasWeatherKey = !!env.WEATHER_API_KEY;
  const webhookSecretIsDefault = !env.PAYMENT_WEBHOOK_SECRET || env.PAYMENT_WEBHOOK_SECRET === 'test-webhook-secret-not-for-production';

  // 2026-09-11 재검토(10차) 5절 — AI 보조 분류는 "실제 공급자 미확정,
  // 운영 AI 호출은 기본 비활성"이 명시된 요구사항이다. 다른 서비스처럼
  // 키 유무로 real을 켜는 게 아니라, real 모드 자체를 아직 구현하지
  // 않는다(server/adapters/ai-classify.mjs 참고) — 실수로도 실과금
  // 경로가 열리지 않게 하기 위해서다. 개발/테스트에서만, 명시적으로
  // AI_CLASSIFY_ADAPTER=mock을 준 경우에 한해 결정론적 모의 어댑터를
  // 켤 수 있다(계약 테스트용).
  const aiClassifyMode = isProd ? 'disabled' : (env.AI_CLASSIFY_ADAPTER === 'mock' ? 'mock' : 'disabled');

  let services;
  if (isProd) {
    // 운영에서는 절대 가짜 응답을 안 준다 — 키가 없으면 그 기능은
    // 'unavailable'이지 'test'가 아니다(조용한 대체 금지).
    services = {
      placeLookup: hasPlaceKey ? 'real' : 'unavailable',
      routing: hasRoutesKey ? 'real' : 'unavailable',
      payment: hasPaymentSecret && hasTossClientKey ? 'real' : 'unavailable',
      email: hasEmailKey ? 'real' : 'unavailable',
      weather: hasWeatherKey ? 'real' : 'unavailable',
      aiClassify: aiClassifyMode,
    };
  } else {
    services = {
      placeLookup: serviceModeDev(forceTest, hasPlaceKey, env.PLACE_LOOKUP_ADAPTER),
      routing: serviceModeDev(forceTest, hasRoutesKey, env.ROUTING_ADAPTER),
      payment: serviceModeDev(forceTest, hasPaymentSecret && hasTossClientKey, env.PAYMENT_ADAPTER),
      email: serviceModeDev(forceTest, hasEmailKey, env.EMAIL_ADAPTER),
      weather: serviceModeDev(forceTest, hasWeatherKey, env.WEATHER_ADAPTER),
      aiClassify: aiClassifyMode,
    };
  }

  return {
    appEnv,
    isProd,
    services,
    // 참고용 요약값(운영에서는 "전부 unavailable이 아니면 test는 아니다"는
    // 의미가 없어지므로, development/test에서만 의미 있게 쓴다).
    // 2026-09-11 재검토(10차) — aiClassify는 real/test 이분법이 아니라
    // disabled/mock뿐이라(위 설명 참고) 이 "전부 test인지" 요약 판정에서
    // 제외한다 — 안 그러면 다른 서비스가 전부 test여도 aiClassify가
    // 'disabled'라는 이유만으로 testMode가 항상 false가 되는 회귀가
    // 생긴다.
    testMode: !isProd && (forceTest || Object.entries(services).every(([k, m]) => k === 'aiClassify' || m === 'test')),
    port: Number(env.PORT || 8787),
    dbPath: env.DB_PATH || path.join(HERE, 'data', 'app.db'),

    price: {
      amountKrw: Number(env.PRICE_AMOUNT_KRW || 9900),
      periodDays: Number(env.PRICE_PERIOD_DAYS || 30),
      autoRenew: env.PRICE_AUTO_RENEW === 'true',
    },

    freeTrialLimit: Number(env.FREE_TRIAL_LIMIT || 1),

    // 2026-09-10 재검토(6차) — "고객에게 약속한 사용량"(이용권 횟수)을
    // 실제 비용 원장과 분리한다. 이 숫자들은 소비자에게 보여주는 상품
    // 사양의 원천이다(구매 화면·계정 화면이 이 값을 그대로 표시한다).
    // 신규 장소 위치 확인은 "이 계정이 그 장소를 실제로 처음 확인한
    // 순간"에만 차감되고(같은 장소 재사용·재조회는 미차감), 코스
    // 생성은 "실제 경로로 성공"했을 때만 차감된다(추정/실패 미차감) —
    // server/entitlement-usage.mjs가 이 규칙을 집행한다. 초기 테스트
    // 상품 사양이며 공개 출시 전 실사용량으로 재조정한다
    // (docs/BUSINESS_DECISIONS.md 3-1절).
    entitlementUsage: {
      freePlaceLookupLimit: Number(env.ENTITLEMENT_FREE_PLACE_LOOKUP_LIMIT || 10),
      freeCourseLimit: Number(env.ENTITLEMENT_FREE_COURSE_LIMIT || 1),
      paidPlaceLookupLimit: Number(env.ENTITLEMENT_PAID_PLACE_LOOKUP_LIMIT || 50),
      paidCourseLimit: Number(env.ENTITLEMENT_PAID_COURSE_LIMIT || 30),
    },
    // 내부 원가 안전상한(고객에게 보여주는 상품 가격·잔여량이 아니다 —
    // "약속한 사용량을 실제로 다 채워도 원가가 이 밑으로 들어오는지"를
    // 감시하는 엔지니어링 안전장치). 무료체험 계정은 평생 누적,
    // 유료는 이용권(주문) 하나당 누적. 이 상한에 걸리면 조용히 막지
    // 않고 실제 요청 수 기준 계산을 보고한다(docs/BUSINESS_DECISIONS.md
    // 3-1/3-3절 — 700원/3,500원은 R6 제안값, 확정 아님).
    costSafetyCap: {
      freeAccountMicros: Number(env.COST_SAFETY_CAP_FREE_KRW_MICROS || 700_000_000),
      paidEntitlementMicros: Number(env.COST_SAFETY_CAP_PAID_KRW_MICROS || 3_500_000_000),
    },

    sessionTtlSeconds: Number(env.SESSION_TTL_SECONDS || 60 * 60 * 24 * 30),
    loginCodeTtlSeconds: Number(env.LOGIN_CODE_TTL_SECONDS || 60 * 10),

    // 로그인 코드 남용 방지(2026-09-10 신규 — "이메일/IP 기준 제한").
    loginCodeCooldownSeconds: Number(env.LOGIN_CODE_COOLDOWN_SECONDS || 30),
    loginMaxVerifyAttempts: Number(env.LOGIN_MAX_VERIFY_ATTEMPTS || 5),
    loginLockoutSeconds: Number(env.LOGIN_LOCKOUT_SECONDS || 600),

    // 코스 생성 시도 한도(성공/실패 무관 — 남용 방지). 제안값이며 실제
    // 관찰 데이터로 조정해야 한다(BUSINESS_DECISIONS.md 3-3절).
    generationRateLimitPerHour: Number(env.GENERATION_RATE_LIMIT_PER_HOUR || 10),

    // 장소 조회 한도 — 초기 대량 정리(import)와 이후 재조회(requery)를
    // 분리한다. 기본값은 "후쿠오카 160~300곳을 한 번에 정리하는" 실제
    // 시나리오를 막지 않도록 여유 있게 잡았다(2026-09-10: "위치 조회
    // 하루 30회" 같은 낮은 값은 채택하지 않는다는 지시 반영) — 그래도
    // 확정 수치가 아니라 제안값이라 전부 환경변수로 바꿀 수 있게 했다.
    placeLookupImportDailyLimit: Number(env.PLACE_LOOKUP_IMPORT_DAILY_LIMIT || 400),
    placeLookupRequeryDailyLimit: Number(env.PLACE_LOOKUP_REQUERY_DAILY_LIMIT || 60),
    placeLookupGlobalDailyCap: Number(env.PLACE_LOOKUP_GLOBAL_DAILY_CAP || 5000),
    // 2026-09-10 재검토(4차): 클라이언트가 보내는 phase=import 문자열
    // 하나만으로 더 큰 한도를 주면(서버가 실제로 "이건 정말 가져오기
    // 직후 일괄 확인이다"를 확인하지 않으면) 아무 요청이나 phase=import를
    // 붙여 큰 한도를 받아갈 수 있다. 그래서 "일괄 확인"은 별도
    // 엔드포인트(/api/places/lookup-batch)로만 가능하게 하고, 그
    // 엔드포인트 자체가 한 번 호출에 담을 수 있는 개수 상한을 강제한다
    // (서버쪽 배치 크기 = 실제 요청 개수이지 클라이언트 자기 신고가
    // 아니다). 개별 재조회(GET .../lookup)는 phase 값과 무관하게 항상
    // requery 한도만 받는다(더 큰 한도로 가는 유일한 문은 배치
    // 엔드포인트뿐).
    placeLookupBatchMaxItemsPerCall: Number(env.PLACE_LOOKUP_BATCH_MAX_ITEMS || 40),
    placeLookupBatchDailyLimit: Number(env.PLACE_LOOKUP_BATCH_DAILY_LIMIT || 400),
    // 2026-09-11 재검토(9차) 3절 — "한도 소진 후 유료 검색을 무제한
    // 반복하면 비용 상한이 소진돼 다른(정당한) 요청까지 막힐 수
    // 있다"는 지시. 이용권 한도(entitlementUsage.*PlaceLookupLimit)를
    // 이미 다 쓴 계정이라도 "다른 로컬 id로 이미 확인된 실제 장소"
    // 재사용은 한도와 무관하게 여전히 공짜여야 하므로(7차 약속) 이런
    // 시도 자체를 막을 수는 없다 — 그런데 그 판정 자체가 실제 외부
    // 호출 없인 안 되므로(재사용인지 신규인지는 공급자가 실제로
    // 돌려준 식별자를 봐야 안다), 계정당 하루 "한도 초과 상태에서
    // 시도해 볼 수 있는 횟수" 자체에 작은 상한을 둔다 — 정말 재사용
    // 확인이 필요한 정상적인 몇 건은 통과시키되, 스크립트로 새 검색을
    // 무한 반복해 비용 예산을 고갈시키는 시나리오는 막는다.
    // 기본값 20 = 위치확인 단가(약 44.8원, docs/BUSINESS_DECISIONS.md
    // 참고) 기준 계정당 하루 최대 약 896원 추가 노출 — 이용권 자체
    // 안전상한(엔티틀먼트 기간 누적 700/3,500원)과 별개의 "하루 단위"
    // 보조 안전판이다. 확정 수치가 아니라 제안값이며, 실사용 데이터로
    // 조정해야 한다(docs/BUSINESS_DECISIONS.md에 근거를 남긴다).
    entitlementOverLimitVerificationDailyLimit: Number(env.ENTITLEMENT_OVERLIMIT_VERIFY_DAILY_LIMIT || 20),

    // 외부 API 호출 전체에 공통 적용하는 타임아웃(2026-09-10 재검토(4차):
    // "모든 외부 요청에 제한 시간을 적용하라"). 타임아웃 자체가 "과금
    // 안 됐다"는 뜻은 아니다(net.mjs 참고) — 그래도 요청이 무한정
    // 걸리는 사고는 막아야 한다.
    externalRequestTimeoutMs: Number(env.EXTERNAL_REQUEST_TIMEOUT_MS || 8000),

    // 코스 생성 잠금 만료(2026-09-10 재검토(4차): "generation_locks 만료
    // 및 안전한 복구"). 이 시간이 지난 잠금은 죽은 프로세스가 남긴
    // 것으로 보고 회수한다 — 그렇지 않으면 서버가 생성 도중 죽었을 때
    // 그 계정은 영원히 코스를 다시 못 만든다.
    generationLockTimeoutSeconds: Number(env.GENERATION_LOCK_TIMEOUT_SECONDS || 120),
    // 결제 승인·취소 잠금도 같은 이유로 만료 회수가 필요하다(별도
    // 환경변수로 분리 — 결제 API는 코스 생성보다 느릴 수 있어 여유를
    // 더 둘 수 있게).
    paymentLockTimeoutSeconds: Number(env.PAYMENT_LOCK_TIMEOUT_SECONDS || 60),

    // 2026-09-10 재검토(8차) 2절 — 장소 확인 잠정 예약(reserve→finalize
    // 사이)도 서버가 그 사이에 죽으면 회수돼야 한다(같은 이유:
    // generation_locks/payment_locks와 동일한 잠금 만료 패턴). 외부
    // 장소조회는 코스 생성보다 훨씬 빨리 끝나는 게 정상이라 기본값을
    // 짧게 잡았다.
    entitlementReservationTimeoutSeconds: Number(env.ENTITLEMENT_RESERVATION_TIMEOUT_SECONDS || 60),

    // 코스 생성 입력 상한 — 서버가 좌표 범위·개수·시간 예산을 검증한다
    // (2026-09-10 재검토(4차) 지시). Google Routes의 중간 경유지 상한
    // (아래 routes 절)과는 별개로, 애초에 "여행 하루 코스"라는 상식적
    // 범위를 벗어난 입력(장소 수천 개, 억 단위 시간 예산 등)을 걸러
    // 비용·성능 사고를 막는다.
    maxPlacesPerGeneration: Number(env.MAX_PLACES_PER_GENERATION || 60),
    maxBudgetMinutes: Number(env.MAX_BUDGET_MINUTES || 24 * 60),

    // Google Routes computeRoutes 중간 경유지 상한. ChatGPT가 확인한
    // 값(최대 25개, 11개 이상이면 더 비싼 요금 구간)을 그대로 반영한다 —
    // 이 세션은 developers.google.com 접속이 막혀 있어 공식 문서로 직접
    // 재대조하지 못했다(RELEASE_STATUS.md 참고).
    routesMaxIntermediatesPerCall: Number(env.ROUTES_MAX_INTERMEDIATES_PER_CALL || 25),
    routesHighVolumeThreshold: Number(env.ROUTES_HIGH_VOLUME_THRESHOLD || 11),

    // API 비용 통제(2026-09-10 재검토 4차 6절, 5차에서 단가 정확화) —
    // SKU별 "예상" 비용을 마이크로원(KRW의 100만분의 1) 정수로 둔다
    // (부동소수점 오차 방지).
    //
    // **2026-09-10 재검토(5차) 수정 — ChatGPT가 지적한 단가 오류를
    // 고쳤다.** 예전엔 "학습 기억 기준 자릿수 추정치"(15원/건 등)를
    // 바로 마이크로원에 박아 뒀는데, 이건 (1) 실제 공식 단가와 얼마나
    // 차이 나는지 알 수 없고 (2) 우리가 실제로 요청하는 필드가 바뀌면
    // 등급도 같이 바뀌어야 한다는 걸 코드에서 알 수 없었다. 이제
    // "공식 SKU별 달러 단가 → 계산용 환율(가정, 실시간 아님) → 최종
    // 원화 단가"를 명시적으로 분리한 뒤 계산한다(안전 여유는 단가가
    // 아니라 예산 상한 쪽에 적용한다 — 아래 costBudget 참고, 실제
    // 원가 계산과 예산 안전판을 같은 숫자로 섞지 않기 위해서다).
    //
    // 공식 SKU·단가 근거(2026-09-10, ChatGPT가 공식 가격표 기준으로
    // 확인해 전달한 값 — 이 세션 자체는 mapsplatform.google.com 접속이
    // 막혀 직접 재대조하지 못했다, RELEASE_STATUS.md 참고):
    //   - Places API(New) Text Search, **Pro 등급**(우리가 실제로
    //     요청하는 필드 `places.displayName`/`places.location`/
    //     `places.formattedAddress`가 이 등급에 해당 — "가장 싼 등급"
    //     이라던 예전 주석은 틀렸다): 무료 구간 소진 후 $32 / 1,000회.
    //   - Routes API computeRoutes, Essentials 등급(거리·시간만 요청,
    //     교통정보·대안경로 없음 — 경유지 11개 미만): $5 / 1,000회.
    //   - Routes API computeRoutes, Pro 등급(경유지 11개 이상은 이
    //     등급으로 전환된다고 가정): $10 / 1,000회.
    costUsdPerThousand: {
      placesTextSearchPro: Number(env.COST_PLACES_TEXT_SEARCH_PRO_USD_PER_1000 || 32),
      routesComputeEssentials: Number(env.COST_ROUTES_COMPUTE_ESSENTIALS_USD_PER_1000 || 5),
      routesComputePro: Number(env.COST_ROUTES_COMPUTE_PRO_USD_PER_1000 || 10),
    },
    // 계산용 환율 — **실시간 환율이 아니라 예산 산정을 위한 가정치다.**
    // 실제 카드·PG 결제는 이 값과 무관하게 그때그때의 실제 환율로
    // 이뤄진다. 이 값은 순수히 "우리 서버가 비용 한도를 얼마로 잡을지"
    // 계산하는 내부 상수일 뿐이다.
    costFxKrwPerUsd: Number(env.COST_FX_KRW_PER_USD || 1400),
    costEstimate: buildCostEstimateMicros(env),
    // 서버가 직접 집행하는 예산 한도(마이크로원 정수, 0 이하 = 무제한).
    // **여기에만 안전 여유(costSafetyMarginRatio)를 적용한다** — 실제
    // 단가(costEstimate)는 안 부풀리고, "우리가 쓸 수 있다고 보는
    // 한도"만 그만큼 낮춰 잡는다(환율 변동·요금 인상·우리가 놓친
    // 부가 비용에 대비한 안전판). 초기 제안값은
    // `docs/BUSINESS_DECISIONS.md` 3절의 월 5만원 목표에서 고정비를
    // 뺀 나머지(Google 예산 약 32,000~45,000원)에 안전 여유를 적용해
    // 보수적으로 잡은 것 — 확정 아님, 전부 env로 조정 가능.
    costSafetyMarginRatio: Number(env.COST_SAFETY_MARGIN_RATIO || 0.15),
    costBudget: {
      perAccountDailyMicros: Number(env.COST_PER_ACCOUNT_DAILY_KRW_MICROS || 500_000_000), // 계정당 하루 약 500원
      globalDailyMicros: Number(env.COST_GLOBAL_DAILY_KRW_MICROS || 3_000_000_000), // 전체 하루 약 3,000원
      globalMonthlyMicros: Number(env.COST_GLOBAL_MONTHLY_KRW_MICROS || 27_000_000_000), // 전체 한 달 약 27,000원(Google 예산 제안치 32,000원에 15% 안전 여유 반영)
      // 2026-09-10 재검토(5차) 신규 — "계정별 월간 비용 한도도
      // 추가하라"는 지시 반영. 계정당 일일 한도만 있으면 매일 한도를
      // 꽉 채워 쓰는 악성/오작동 계정이 한 달 내내 예산을 잠식할 수
      // 있다.
      perAccountMonthlyMicros: Number(env.COST_PER_ACCOUNT_MONTHLY_KRW_MICROS || 5_000_000_000), // 계정당 한 달 약 5,000원
    },

    adapters: {
      placeLookup: env.PLACE_LOOKUP_ADAPTER || 'test',
      routing: env.ROUTING_ADAPTER || 'test',
      payment: env.PAYMENT_ADAPTER || 'test',
      email: env.EMAIL_ADAPTER || 'test',
    },

    webhookSecret: env.PAYMENT_WEBHOOK_SECRET || 'test-webhook-secret-not-for-production',
    webhookSecretIsDefault,

    // 테스트 전용 — routing 서비스가 test 모드일 때 성공/실패를 강제로
    // 고정한다(장소조회 test 어댑터의 결정론적 해시 패턴과 같은 목적,
    // 다만 이건 값 하나로 명시적으로 고를 수 있게 했다 — 코스 생성
    // 테스트에서 "실제 경로 성공"/"실패→추정" 두 경로를 매번 좌표를
    // 역산하지 않고 바로 고를 수 있어야 하기 때문). production에서는
    // services.routing이 애초에 'test'가 될 수 없어 이 값은 절대 안 쓰인다.
    routingTestForce: env.ROUTING_TEST_FORCE || null,

    toss: {
      clientKey: env.TOSS_CLIENT_KEY || '',
      secretKey: env.PAYMENT_PG_SECRET || '',
      apiBase: env.TOSS_API_BASE || 'https://api.tosspayments.com',
    },
    resend: {
      apiKey: env.EMAIL_API_KEY || '',
      from: env.EMAIL_FROM || 'travel hub <onboarding@resend.dev>',
      apiBase: env.RESEND_API_BASE || 'https://api.resend.com',
    },
    google: {
      placesKey: env.GOOGLE_PLACES_API_KEY || '',
      // 2026-09-10 재검토(4차): Legacy Find Place(findplacefromtext)에서
      // Places API(New) Text Search로 전환한다(지시 그대로 — "실제
      // 필드마스크·SKU·응답 형식을 명시하라"). 학습 기억 기준 엔드포인트라
      // 재확인 필요(RELEASE_STATUS.md 참고).
      placesApiBase: env.GOOGLE_PLACES_API_BASE || 'https://places.googleapis.com',
      routesKey: env.GOOGLE_ROUTES_API_KEY || '',
      routesApiBase: env.GOOGLE_ROUTES_API_BASE || 'https://routes.googleapis.com',
    },
    // 2026-09-10 재검토(7차) 4절 — 착장 판단용 날씨 카드. WeatherAPI.com
    // 무료 등급(공식 가격표 확인 — https://www.weatherapi.com/pricing.aspx:
    // 상업적 사용 허용, 월 100,000회, 현재 날씨+3일 예보 포함,
    // https://www.weatherapi.com/docs/). 서버가 키를 들고 있고,
    // 소비자는 절대 키를 입력하지 않는다(placesKey/routesKey와 같은 원칙).
    weather: {
      apiKey: env.WEATHER_API_KEY || '',
      apiBase: env.WEATHER_API_BASE || 'https://api.weatherapi.com/v1',
    },
    // 같은 지역(위경도를 대략 1km 단위로 반올림)의 날씨는 여러 사용자가
    // 공유해서 캐시한다 — "도시 하나 고를 때마다 매번 호출" 방지. 현재
    // 날씨는 자연 갱신 주기가 짧아(대체로 수십 분 단위) 너무 길게
    // 캐시하면 오래된 값을 최신인 것처럼 보여주는 위험이 있고, 너무
    // 짧으면 호출이 과도하다 — 25분으로 절충(제안값, 확정 아님).
    weatherCacheTtlMs: Number(env.WEATHER_CACHE_TTL_MS || 25 * 60 * 1000),
    // 서비스 전체 하루 호출 상한(무료 등급 월 100,000회 ÷ 30일 ≈
    // 3,333회/일 — 지역 캐시 공유로 실제 호출은 이보다 훨씬 적게
    // 나가겠지만, 안전하게 그보다 낮게 잡는다).
    weatherGlobalDailyCap: Number(env.WEATHER_GLOBAL_DAILY_CAP || 2000),
    expectedCurrency: env.PAYMENT_EXPECTED_CURRENCY || 'KRW',

    // 2026-09-11 재검토(9차) 6-4절 — 소규모 베타·피드백 체계.
    // adminToken이 비어 있으면 관리자 엔드포인트는 "설정 안 됨"으로
    // 정직하게 막힌다(빈 문자열끼리 비교해 누구나 통과하는 사고 방지 —
    // server/index.mjs의 requireAdmin 참고).
    adminToken: env.ADMIN_TOKEN || '',
    // requireInviteCodeForSignup: 기본값 false. "가격이 미정인 지금은
    // 실제 유료 모집을 켜지 않는다"는 지시대로, 이 라운드에서 코드는
    // 전부 준비해 두되 실제로 신규 가입을 초대 코드로 막는 건 사용자가
    // 명시적으로 이 환경변수를 켰을 때만 시작된다(기본값 유지 시 기존
    // 열린 가입 흐름·기존 회귀 테스트가 전부 그대로 동작한다).
    requireInviteCodeForSignup: env.REQUIRE_INVITE_CODE_FOR_SIGNUP === 'true',
    invite: {
      // 코드 하나당 기본 허용 인원 — "5명→10명은 예시일 뿐 확정 값이
      // 아니다"라는 지시를 따라 5보다 살짝 여유 있게 잡되(실제 초대
      // 발송 실수·한두 명 이탈을 감안), 여전히 "소규모"라 부를 수 있는
      // 크기로 뒀다. 운영자가 언제든 admin API로 다른 값의 코드를 새로
      // 만들 수 있다.
      defaultMaxUses: Number(env.INVITE_CODE_DEFAULT_MAX_USES || 8),
      defaultTtlDays: Number(env.INVITE_CODE_DEFAULT_TTL_DAYS || 14),
      // recruitmentTotalCap: 이번 베타 전체를 통틀어 실제로 새 계정을
      // 만들 수 있는 사람 수의 상한(운영자가 코드를 여러 개 만들어도
      // 이 총량을 못 넘는다). 초기 운영 여력(문의 응대 1인, 하루 1회
      // 검토)을 기준으로 "코드 하나(8명)의 3~4배" 정도인 30명을
      // 제안값으로 둔다 — 확정 아님, 실제로 응대가 밀리면 낮추고
      // 여유가 있으면 admin API로 코드를 더 만들면 된다.
      recruitmentTotalCap: Number(env.RECRUITMENT_TOTAL_CAP || 30),
    },
    feedback: {
      maxDescriptionLength: Number(env.FEEDBACK_MAX_DESCRIPTION_LENGTH || 300),
      // 남용 방지 — 로그인 계정은 하루 10건, 로그인 없는 익명(IP 기준)은
      // 더 낮게 잡는다(무료 API를 건드리지 않는 순수 DB 쓰기라 비용
      // 위험은 없지만, 관리자가 하루 한 번 훑어보는 소규모 운영 전제상
      // 스팸이 몰리면 그 자체가 운영 부담이다).
      perAccountDailyLimit: Number(env.FEEDBACK_PER_ACCOUNT_DAILY_LIMIT || 10),
      perIpDailyLimit: Number(env.FEEDBACK_PER_IP_DAILY_LIMIT || 20),
    },

    // 2026-09-11 재검토(10차) 5·6절 — AI 보조 분류 비용 통제.
    // **중요: aiClassifyPlaceholderMicros는 실제 공급자 견적이 아니다.**
    // 이 라운드 시점에 AI 공급자·모델이 전혀 확정되지 않았고(사업 문서
    // 어디에도 결정된 적 없음), 이 세션은 공식 가격 페이지 접속도 막혀
    // 있어(placesTextSearchPro/routesCompute와 같은 상황, 위 주석 참고)
    // 실제 단가를 확인할 방법이 없다. 이 값은 오직 "예산 예약·헤드룸
    // 계산 코드 경로가 실제로 동작하는지"를 테스트하기 위한 구조적
    // 자리표시자이며, 실제 원가 보고서(BUSINESS_DECISIONS.md 10차 갱신)
    // 에는 이 숫자를 확정 단가처럼 쓰지 않고 "미검증"이라고 명시한다.
    // 공급자가 정해지면 이 값을 실제 공식 단가로 교체해야 한다.
    aiClassify: {
      // 배치당(여러 장소를 한 번의 요청에 묶어 보낼 때) 항목 1개를
      // 처리하는 데 드는 예상 비용의 자리표시자.
      placeholderPerItemMicros: Number(env.AI_CLASSIFY_PLACEHOLDER_PER_ITEM_KRW_MICROS || 3_000_000), // 자리표시자 3원/건 — 검증되지 않음.
      // 한 번의 배치 요청에 담을 수 있는 최대 항목 수(공급자 토큰
      // 한도·타임아웃을 감안한 보수적 상한 — 공급자가 정해지면 재조정).
      maxItemsPerBatch: Number(env.AI_CLASSIFY_MAX_ITEMS_PER_BATCH || 20),
      // 계정당 하루 배치 호출 횟수 상한(재시도·남용 방지 — 코스 생성
      // rate-limit과 같은 목적).
      perAccountDailyBatchLimit: Number(env.AI_CLASSIFY_PER_ACCOUNT_DAILY_BATCH_LIMIT || 10),
      // 분류 결과 캐시 무효화 버전 — 프롬프트·검증 규칙이 바뀌면 이
      // 값을 올려서 기존 캐시(해시+버전 일치 확인)를 전부 무효화한다.
      classificationVersion: Number(env.AI_CLASSIFY_VERSION || 1),
      // 2026-09-11 재검토(11차) — "남은 코스 횟수 × 가장 싼 routes-
      // compute 단가"만 곱하던 예약 계산이 과소평가라는 지적(ChatGPT)
      // 반영해 1세그먼트분만 예약했었으나, **12차에서 다시 지적됨**:
      // maxPlacesPerGeneration(기본 60곳)까지 실제로 허용하면서
      // 1세그먼트(약 27곳)만 예약하는 건 여전히 과소평가였다. 이제
      // entitlement-usage.mjs의 aiClassifyBudgetHeadroomMicros가
      // maxPlacesPerGeneration 전체를 routing.mjs와 완전히 같은 함수
      // (server/route-segments.mjs의 splitIntoSegments)로 나눠 실제로
      // 몇 세그먼트·어떤 SKU 등급이 나오는지 정확히 계산해 예약한다 —
      // 별도 조정용 상수가 필요 없어져 이 값 자체를 없앴다(12차).
      // 2026-09-11 재검토(11차) — "전체 및 계정 한도"(4절 지시). 기존엔
      // 계정별 하루 배치 횟수 상한만 있고 전체(서비스 전체) 상한이
      // 없었다. places.mjs의 placeLookupGlobalDailyCap과 같은 목적·
      // 같은 순서(계정 한도를 먼저 확인해 거부되면 전체 한도를 아예
      // 건드리지 않는다)로 둔다.
      globalDailyBatchLimit: Number(env.AI_CLASSIFY_GLOBAL_DAILY_BATCH_LIMIT || 2000),
    },
  };
}

export const config = buildConfig(process.env);

export function ensureDataDir() {
  const dir = path.dirname(config.dbPath);
  fs.mkdirSync(dir, { recursive: true });
}

/* 운영 시작 직전에만 부른다(index.mjs의 "직접 실행됐을 때"에서만 —
   config.mjs를 import만 하는 테스트 코드는 이 함수를 안 부르니 영향
   없다). 여기서 던지면 서버가 아예 안 뜬다 — "필수 설정 누락으로 시작을
   거부하라"는 지시를 문자 그대로 구현한 것이다. 결제·이메일·웹훅
   시크릿은 핵심 크리덴셜이라 없으면 서버 자체를 안 띄운다. 장소 조회·
   도보 경로 키는 없어도 서버는 뜨되(정직한 대체/미제공으로 동작),
   그 기능만 'unavailable'이다 — 둘 다 없어도 "코스 자체를 못 만드는
   건 아니고 정직하게 추정으로 대체"되는 기존 원칙과 일관된다. */
export function assertBootReady(cfg) {
  cfg = cfg || config;
  if (!cfg.isProd) return { ok: true };
  const missing = [];
  if (cfg.services.payment !== 'real') missing.push('PAYMENT_PG_SECRET, TOSS_CLIENT_KEY(토스페이먼츠)');
  if (cfg.webhookSecretIsDefault) missing.push('PAYMENT_WEBHOOK_SECRET(기본값 그대로 두면 안 됨)');
  if (cfg.services.email !== 'real') missing.push('EMAIL_API_KEY(Resend)');
  if (missing.length) {
    return { ok: false, missing };
  }
  return { ok: true };
}
