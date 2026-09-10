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

    // API 비용 통제(2026-09-10 재검토(4차) 6절) — SKU별 "예상" 비용을
    // 마이크로원(KRW의 100만분의 1) 정수로 둔다(부동소수점 오차 방지).
    // **이 값들은 학습 기억 기준의 자릿수 추정치이지 확정 단가가
    // 아니다** — 이 세션은 mapsplatform.google.com 접속이 막혀 공식
    // 가격표를 재확인하지 못했다(docs/BUSINESS_DECISIONS.md 3절 참고).
    // 실제 계약 후 이 값을 반드시 재확인하고 필요하면 환경변수로
    // 갱신해야 한다 — 코드 변경 없이 값만 바꿀 수 있게 전부 env로 뺐다.
    costEstimate: {
      placesTextSearchMicros: Number(env.COST_PLACES_TEXT_SEARCH_KRW_MICROS || 15_000_000), // 약 15원/건 추정
      routesComputeMicros: Number(env.COST_ROUTES_COMPUTE_KRW_MICROS || 8_000_000), // 약 8원/건 추정(경유지 10개 이하)
      routesComputeHighVolumeMicros: Number(env.COST_ROUTES_COMPUTE_HIGHVOLUME_KRW_MICROS || 24_000_000), // 약 24원/건 추정(경유지 11개 이상 — 고요금 구간, 배수는 미확인 가정)
    },
    // 서버가 직접 집행하는 예산 한도(마이크로원 정수, 0 이하 = 무제한).
    // 초기 제안값은 BUSINESS_DECISIONS.md 3절의 월 5만원 목표에서
    // 고정비를 뺀 나머지를 계정 수 가정으로 나눈 것 — 확정 아님, 전부
    // env로 조정 가능.
    costBudget: {
      perAccountDailyMicros: Number(env.COST_PER_ACCOUNT_DAILY_KRW_MICROS || 500_000_000), // 계정당 하루 약 500원
      globalDailyMicros: Number(env.COST_GLOBAL_DAILY_KRW_MICROS || 3_000_000_000), // 전체 하루 약 3,000원
      globalMonthlyMicros: Number(env.COST_GLOBAL_MONTHLY_KRW_MICROS || 30_000_000_000), // 전체 한 달 약 30,000원(고정비 제외 Google 예산 제안치)
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
