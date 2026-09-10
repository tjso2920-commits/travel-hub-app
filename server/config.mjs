'use strict';
/**
 * 서버 설정 — 로드맵 ⑧(유료 출시 준비) 실제 구현.
 *
 * 2026-09-09 코드 검토: "실 계정·크리덴셜이 없다는 이유로 실제로 구현
 * 가능한 서버 코드·DB 스키마·테스트 작성 자체를 멈추지 말 것." 이 파일이
 * 그 경계를 긋는다 — 실제 운영에 필요한 값(결제대행사 시크릿, 실 place
 * lookup API 키, 실 이메일 발송 키)은 전부 환경변수로만 읽고, 값이 없으면
 * 그 서비스만 TEST_MODE로 자동 전환해 어댑터가 가짜(하지만 실제 코드
 * 경로를 그대로 타는) 응답을 준다. 실 크리덴셜을 코드에 박아 넣지 않는다
 * — 이 저장소 어디에도 실제 비밀값이 없어야 한다.
 *
 * 2026-09-10 재검토 반영 — "서비스별 연결 상태를 독립적으로 관리하고,
 * 운영 모드에서 키가 없다고 가짜로 조용히 대체하지 말 것": 예전 버전은
 * `PAYMENT_PG_SECRET`과 `GOOGLE_PLACES_API_KEY`가 **둘 다** 있어야만 전체를
 * 실제 모드로 봤다 — 그 결과 실제 Google 키를 넣어도 결제 키가 아직 없으면
 * 장소 조회까지 계속 조용히 가짜 좌표를 돌려주는 상태가 됐다(실제로 이런
 * 구성이 되는데도 겉으로는 "왜 아직도 가짜 좌표가 나오지" 원인을 알기
 * 어려웠다 — 그게 "조용한 대체"다). 이제 서비스마다(placeLookup/payment/
 * email) 자기 크리덴셜 유무만으로 독립적으로 real/test를 판정한다 — 다른
 * 서비스 상태와 무관하다. 전체 `testMode`는 "셋 다 test일 때만 true"인
 * 참고용 요약값으로만 남긴다(개별 분기에는 절대 안 쓴다 — services.<이름>을
 * 직접 본다).
 *
 * 가격은 절대 숫자로 박지 않는다 — 여기 설정값 하나로만 바꾼다(코드
 * 검토 지시사항: "가격은 설정 가능한 값으로 유지"). 지금 적힌 9900원/
 * 30일은 첫 출시 확정 상품(BUSINESS_DECISIONS.md 참고)이지만, 실제
 * 서버에 적용하려면 여전히 환경변수로 넣어야 한다(코드에 숫자를 박지
 * 않는다는 원칙은 확정 후에도 유지).
 *
 * 테스트 용이성을 위해 "process.env를 읽어 설정 객체를 만드는" 부분을
 * buildConfig(env) 순수 함수로 분리했다 — 서버 테스트가 실제 프로세스를
 * 여러 개 띄우지 않고도 "키가 하나만 있을 때/전혀 없을 때/전부 있을 때"
 * 조합별로 services 판정이 서로 독립적인지 직접 검증할 수 있다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* 서비스 하나의 real/test 판정 — 오직 그 서비스 자신의 크리덴셜 유무에만
   좌우된다(다른 서비스 상태를 절대 안 본다 — 이게 "독립적으로 관리"의
   핵심이다). FORCE_TEST_MODE=true는 예외적으로 전부 test로 묶는다(로컬
   개발·테스트 실행 중에 실수로 환경에 남아 있는 실제 키를 건드리지
   않기 위한 안전장치). adapterOverride가 명시적으로 'test'면 실제 키가
   있어도 test로 둔다(스테이징에서 일부러 가짜로 돌리고 싶을 때 쓴다). */
function serviceMode(forceTest, keyPresent, adapterOverride) {
  if (forceTest) return 'test';
  if (adapterOverride === 'test') return 'test';
  return keyPresent ? 'real' : 'test';
}

export function buildConfig(env) {
  env = env || {};
  const forceTest = env.FORCE_TEST_MODE === 'true';

  const services = {
    placeLookup: serviceMode(forceTest, !!env.GOOGLE_PLACES_API_KEY, env.PLACE_LOOKUP_ADAPTER),
    payment: serviceMode(forceTest, !!env.PAYMENT_PG_SECRET, env.PAYMENT_ADAPTER),
    email: serviceMode(forceTest, !!env.EMAIL_API_KEY, env.EMAIL_ADAPTER),
  };

  return {
    // 서비스별 실제 판정 — 어댑터 코드는 반드시 이 값만 보고 real/test를 고른다.
    services,
    // 참고용 요약값. 개별 분기에 쓰지 않는다 — 셋 다 test일 때만 true라서,
    // "payment만 실제 연결됐는지" 같은 질문에는 이 값으로 답할 수 없다
    // (그런 질문엔 services.payment를 본다).
    testMode: forceTest || Object.values(services).every((m) => m === 'test'),
    port: Number(env.PORT || 8787),
    dbPath: env.DB_PATH || path.join(HERE, 'data', 'app.db'),

    // 가격 — 설정값 하나로만 바꾼다. 첫 출시 확정 상품: 9,900원/30일,
    // 자동결제 없음(BUSINESS_DECISIONS.md 참고). 실제 서버에는 여전히
    // 환경변수로 넣어야 한다 — 코드에 숫자를 박지 않는다.
    price: {
      amountKrw: Number(env.PRICE_AMOUNT_KRW || 9900),
      periodDays: Number(env.PRICE_PERIOD_DAYS || 30),
      autoRenew: env.PRICE_AUTO_RENEW === 'true', // 기본값: 자동결제 아님(명시적 동의 없이 켜지 않는다)
    },

    // 무료체험: "계정당 개인화 코스 생성 성공 1회". 서버가 판정한다 —
    // 클라이언트는 참고 표시만 한다.
    freeTrialLimit: Number(env.FREE_TRIAL_LIMIT || 1),

    // 세션 만료(초) — 로그인 코드로 발급되는 베어러 토큰의 수명.
    sessionTtlSeconds: Number(env.SESSION_TTL_SECONDS || 60 * 60 * 24 * 30), // 30일

    // 로그인 코드(매직 코드) 만료(초).
    loginCodeTtlSeconds: Number(env.LOGIN_CODE_TTL_SECONDS || 60 * 10), // 10분

    // 레거시 참고 필드 — 실제 분기는 services.*를 쓴다. 어떤 어댑터
    // 이름을 요청했는지 로그·디버깅용으로만 남겨 둔다.
    adapters: {
      placeLookup: env.PLACE_LOOKUP_ADAPTER || 'test',
      payment: env.PAYMENT_ADAPTER || 'test',
      email: env.EMAIL_ADAPTER || 'test',
    },

    webhookSecret: env.PAYMENT_WEBHOOK_SECRET || 'test-webhook-secret-not-for-production',
  };
}

export const config = buildConfig(process.env);

export function ensureDataDir() {
  const dir = path.dirname(config.dbPath);
  fs.mkdirSync(dir, { recursive: true });
}
