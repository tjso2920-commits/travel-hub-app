'use strict';
/**
 * 서비스별 독립 연결 상태 판정 검증 — 2026-09-10 재검토: "운영 모드에서
 * 키가 없다고 가짜로 조용히 대체하지 말고, 서비스별로 독립적으로
 * 관리하라." buildConfig(env)는 순수 함수라 실제 프로세스를 여러 개
 * 띄우지 않고도 여러 키 조합을 바로 검증할 수 있다.
 *
 * 실행: node server/test/config.test.mjs
 */
const { buildConfig } = await import('../config.mjs');

let fail = 0;
const t = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fail++; };

// --- 키가 하나도 없으면 전부 test ---
{
  const c = buildConfig({});
  t('키 없음 — placeLookup은 test', c.services.placeLookup === 'test');
  t('키 없음 — payment는 test', c.services.payment === 'test');
  t('키 없음 — email은 test', c.services.email === 'test');
  t('키 없음 — 전체 testMode 요약값도 true', c.testMode === true);
}

// --- 결제 키만 있으면 payment만 real, 나머지는 그대로 test여야 한다
// (예전 버그: 이 상황에서 결제 키가 있어도 GOOGLE_PLACES_API_KEY가
// 없다는 이유로 전체가 test로 묶여, 결제까지 조용히 가짜로 도는
// 사고가 났었다 — 재현하지 않는지 확인)
//
// 2026-09-10 재검토(3차) 갱신: 결제는 이제 토스페이먼츠 실 연동이라
// PAYMENT_PG_SECRET(서버 승인용 시크릿) 하나만으로는 real이 될 수
// 없다 — 결제창을 띄우는 TOSS_CLIENT_KEY도 함께 있어야 한다. 시크릿만
// 있고 클라이언트 키가 없는 상태는 여전히 test로 안전하게 남아야
// 한다(반쪽만 설정된 채 운영에서 결제창이 뜨지도 않는데 real로
// 보고되는 사고 방지). ---
{
  const c = buildConfig({ PAYMENT_PG_SECRET: 'fake-secret-for-test' });
  t('결제 시크릿만 있고 클라이언트 키가 없으면 payment는 여전히 test(반쪽 설정 방지)', c.services.payment === 'test');
  const c2 = buildConfig({ PAYMENT_PG_SECRET: 'fake-secret-for-test', TOSS_CLIENT_KEY: 'fake-client-key' });
  t('결제 시크릿+클라이언트 키가 모두 있으면 payment는 real', c2.services.payment === 'real');
  t('결제 키만 있음 — placeLookup은 여전히 test(다른 서비스 영향 안 받음)', c2.services.placeLookup === 'test');
  t('결제 키만 있음 — email도 여전히 test', c2.services.email === 'test');
  t('결제 키만 있음 — 전체 testMode 요약값은 false(하나라도 real이면 false)', c2.testMode === false);
}

// --- 장소 조회 키만 있으면 placeLookup만 real ---
{
  const c = buildConfig({ GOOGLE_PLACES_API_KEY: 'fake-key-for-test' });
  t('장소조회 키만 있음 — placeLookup은 real', c.services.placeLookup === 'real');
  t('장소조회 키만 있음 — payment는 test', c.services.payment === 'test');
  t('장소조회 키만 있음 — email은 test', c.services.email === 'test');
}

// --- 이메일 키만 있으면 email만 real ---
{
  const c = buildConfig({ EMAIL_API_KEY: 'fake-key-for-test' });
  t('이메일 키만 있음 — email은 real', c.services.email === 'real');
  t('이메일 키만 있음 — placeLookup·payment는 test', c.services.placeLookup === 'test' && c.services.payment === 'test');
}

// --- 넷 다 있으면 전부 real, testMode 요약값 false ---
{
  const c = buildConfig({ GOOGLE_PLACES_API_KEY: 'k', PAYMENT_PG_SECRET: 's', TOSS_CLIENT_KEY: 'ck', EMAIL_API_KEY: 'e' });
  t('넷 다 있음 — 전부 real', c.services.placeLookup === 'real' && c.services.payment === 'real' && c.services.email === 'real');
  t('넷 다 있음 — 전체 testMode 요약값 false', c.testMode === false);
}

// --- FORCE_TEST_MODE=true는 키가 있어도 전부 test로 강제한다(로컬
// 개발·테스트 실행 중 실수로 남은 실제 키를 안전하게 무시) ---
{
  const c = buildConfig({ GOOGLE_PLACES_API_KEY: 'k', PAYMENT_PG_SECRET: 's', TOSS_CLIENT_KEY: 'ck', EMAIL_API_KEY: 'e', FORCE_TEST_MODE: 'true' });
  t('FORCE_TEST_MODE — 키가 다 있어도 전부 test로 강제됨', c.services.placeLookup === 'test' && c.services.payment === 'test' && c.services.email === 'test');
}

// --- 어댑터 오버라이드로 명시적으로 test를 요청하면 키가 있어도 test
// (스테이징에서 일부러 가짜로 돌리고 싶을 때) ---
{
  const c = buildConfig({ GOOGLE_PLACES_API_KEY: 'k', PLACE_LOOKUP_ADAPTER: 'test' });
  t('명시적 어댑터 오버라이드 — 키가 있어도 test로 유지됨', c.services.placeLookup === 'test');
}

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
