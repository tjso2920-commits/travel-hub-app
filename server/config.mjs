'use strict';
/**
 * 서버 설정 — 로드맵 ⑧(유료 출시 준비) 실제 구현.
 *
 * 2026-09-09 코드 검토: "실 계정·크리덴셜이 없다는 이유로 실제로 구현
 * 가능한 서버 코드·DB 스키마·테스트 작성 자체를 멈추지 말 것." 이 파일이
 * 그 경계를 긋는다 — 실제 운영에 필요한 값(결제대행사 시크릿, 실 place
 * lookup API 키, 실 이메일 발송 키)은 전부 환경변수로만 읽고, 값이 없으면
 * TEST_MODE로 자동 전환해 어댑터가 가짜(하지만 실제 코드 경로를 그대로
 * 타는) 응답을 준다. 실 크리덴셜을 코드에 박아 넣지 않는다 — 이 저장소
 * 어디에도 실제 비밀값이 없어야 한다.
 *
 * 가격은 절대 숫자로 박지 않는다 — 여기 설정값 하나로만 바꾼다(코드
 * 검토 지시사항: "가격은 설정 가능한 값으로 유지"). 지금 적힌 9900원/
 * 30일은 ChatGPT가 아직 확정하지 않은 가설 가격이다 — 실제 결정은
 * BUSINESS_DECISIONS.md를 보고 판단할 사람의 몫이다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRUE_MODE = process.env.PAYMENT_PG_SECRET && process.env.GOOGLE_PLACES_API_KEY;

export const config = {
  // 실제 크리덴셜이 하나라도 없으면 무조건 테스트 모드다 — 절반만 실제
  // 모드로 도는 상태(예: 결제는 진짜인데 place lookup은 가짜)를 방지한다.
  testMode: !TRUE_MODE || process.env.FORCE_TEST_MODE === 'true',
  port: Number(process.env.PORT || 8787),
  dbPath: process.env.DB_PATH || path.join(HERE, 'data', 'app.db'),

  // 가격 — 설정값 하나로만 바꾼다. "9900원/30일"은 확정 가격이 아니라
  // ChatGPT가 검토 중인 가설이다(BUSINESS_DECISIONS.md 참고).
  price: {
    amountKrw: Number(process.env.PRICE_AMOUNT_KRW || 9900),
    periodDays: Number(process.env.PRICE_PERIOD_DAYS || 30),
    autoRenew: process.env.PRICE_AUTO_RENEW === 'true', // 기본값: 자동결제 아님(명시적 동의 없이 켜지 않는다)
  },

  // 무료체험: "계정당 개인화 코스 생성 성공 1회". 서버가 판정한다 —
  // 클라이언트는 참고 표시만 한다.
  freeTrialLimit: Number(process.env.FREE_TRIAL_LIMIT || 1),

  // 세션 만료(초) — 로그인 코드로 발급되는 베어러 토큰의 수명.
  sessionTtlSeconds: Number(process.env.SESSION_TTL_SECONDS || 60 * 60 * 24 * 30), // 30일

  // 로그인 코드(매직 코드) 만료(초).
  loginCodeTtlSeconds: Number(process.env.LOGIN_CODE_TTL_SECONDS || 60 * 10), // 10분

  adapters: {
    // 'test' | 'google' — 실제 공급자로 바꾸려면 GOOGLE_PLACES_API_KEY를
    // 설정하고 이 값을 'google'로 바꾼다(테스트 모드에서는 무시하고
    // 항상 test 어댑터를 쓴다).
    placeLookup: process.env.PLACE_LOOKUP_ADAPTER || 'test',
    // 'test' | 'iamport' | 'tosspayments' 등 — 실제 PG 연동 시 확장.
    payment: process.env.PAYMENT_ADAPTER || 'test',
    // 'test' | 'smtp' — 실제 이메일 발송 시 확장.
    email: process.env.EMAIL_ADAPTER || 'test',
  },

  webhookSecret: process.env.PAYMENT_WEBHOOK_SECRET || 'test-webhook-secret-not-for-production',
};

export function ensureDataDir() {
  const dir = path.dirname(config.dbPath);
  fs.mkdirSync(dir, { recursive: true });
}
