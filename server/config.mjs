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
  const webhookSecretIsDefault = !env.PAYMENT_WEBHOOK_SECRET || env.PAYMENT_WEBHOOK_SECRET === 'test-webhook-secret-not-for-production';

  let services;
  if (isProd) {
    // 운영에서는 절대 가짜 응답을 안 준다 — 키가 없으면 그 기능은
    // 'unavailable'이지 'test'가 아니다(조용한 대체 금지).
    services = {
      placeLookup: hasPlaceKey ? 'real' : 'unavailable',
      routing: hasRoutesKey ? 'real' : 'unavailable',
      payment: hasPaymentSecret && hasTossClientKey ? 'real' : 'unavailable',
      email: hasEmailKey ? 'real' : 'unavailable',
    };
  } else {
    services = {
      placeLookup: serviceModeDev(forceTest, hasPlaceKey, env.PLACE_LOOKUP_ADAPTER),
      routing: serviceModeDev(forceTest, hasRoutesKey, env.ROUTING_ADAPTER),
      payment: serviceModeDev(forceTest, hasPaymentSecret && hasTossClientKey, env.PAYMENT_ADAPTER),
      email: serviceModeDev(forceTest, hasEmailKey, env.EMAIL_ADAPTER),
    };
  }

  return {
    appEnv,
    isProd,
    services,
    // 참고용 요약값(운영에서는 "전부 unavailable이 아니면 test는 아니다"는
    // 의미가 없어지므로, development/test에서만 의미 있게 쓴다).
    testMode: !isProd && (forceTest || Object.values(services).every((m) => m === 'test')),
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
    expectedCurrency: env.PAYMENT_EXPECTED_CURRENCY || 'KRW',
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
