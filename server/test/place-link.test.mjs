'use strict';
/**
 * 2026-09-11 재검토(13차) 3절 — Google Maps 장소 링크 붙여넣기 검증:
 *  1) 전체 URL(/maps/place/이름/@lat,lng,...)에서 이름·좌표를 실제로
 *     뽑아냄.
 *  2) 축약 링크(maps.app.goo.gl)는 리다이렉트를 따라가 최종 URL에서
 *     뽑아냄(진짜 fetch 없이 테스트 전용 fetchImpl로 재현).
 *  3) Google Maps 도메인이 아니면 정직하게 unsupported-link로 거절함
 *     (조용한 성공 처리 금지).
 *  4) 축약 링크가 Google 밖의 호스트로 리다이렉트되면(SSRF 방어) 역시
 *     unsupported-link로 거절함.
 *  5) 이름·좌표 둘 다 못 뽑아내면(Google 도메인은 맞지만 정보 없음)
 *     명시적으로 실패를 돌려줌.
 *  6) 계정별 하루 호출 한도가 실제로 동작함.
 *
 * 실행: node server/test/place-link.test.mjs
 */
process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'development';
process.env.PLACE_LINK_RESOLVE_DAILY_LIMIT = '3';

const { openDb, uuid, nowIso } = await import('../db.mjs');
const { resolvePlaceLinkRoute } = await import('../routes/place-link.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

function directAccount(email) {
  const db = openDb();
  const id = uuid();
  db.prepare('INSERT INTO accounts (id, email, created_at, plan) VALUES (?, ?, ?, ?)').run(id, email, nowIso(), 'free');
  return id;
}

// =====================================================================
// 1) 전체 URL에서 이름·좌표를 실제로 뽑아냄.
// =====================================================================
{
  const acc = directAccount('link-full@example.com');
  const url = 'https://www.google.com/maps/place/%EC%B9%B4%ED%8E%98+%EB%AA%A8%EB%AA%A8/@35.6812,139.7671,17z/data=!3m1!4b1';
  const r = await resolvePlaceLinkRoute(acc, url);
  t('1) 전체 URL에서 이름을 실제로 뽑아냄', r.ok === true && r.name === '카페 모모');
  t('1) 좌표도 함께 뽑아냄', r.ok === true && Math.abs(r.lat - 35.6812) < 0.0001 && Math.abs(r.lng - 139.7671) < 0.0001);
  t('1) 축약 링크가 아니므로 리다이렉트를 따라가지 않음', r.followedShortLink === false);
}

// =====================================================================
// 2) 축약 링크 — 리다이렉트를 실제로 따라가 최종 URL에서 뽑아냄(진짜
//    네트워크 없이 테스트 전용 fetchImpl로 재현).
// =====================================================================
{
  const acc = directAccount('link-short@example.com');
  const finalUrl = 'https://www.google.com/maps/place/%EB%9D%BC%EB%A9%98+%EC%9D%B4%EC%B9%98%EB%9E%80/@34.6937,135.5023,17z';
  const fetchImpl = async (u) => {
    t('2) 리다이렉트를 따라가기 전 원본이 축약 링크임', u === 'https://maps.app.goo.gl/xYz123');
    return { url: finalUrl };
  };
  const r = await resolvePlaceLinkRoute(acc, 'https://maps.app.goo.gl/xYz123', { fetchImpl });
  t('2) 축약 링크 리다이렉트 이후 이름을 실제로 뽑아냄', r.ok === true && r.name === '라멘 이치란');
  t('2) followedShortLink가 실제로 true로 표시됨', r.followedShortLink === true);
}

// =====================================================================
// 3) Google Maps 도메인이 아니면 정직하게 거절함(조용한 성공 금지).
// =====================================================================
{
  const acc = directAccount('link-unsupported@example.com');
  const r = await resolvePlaceLinkRoute(acc, 'https://evil.example.com/maps/place/가짜장소/@0,0');
  t('3) Google Maps 도메인이 아니면 unsupported-link로 거절됨', r.ok === false && r.reason === 'unsupported-link');

  const r2 = await resolvePlaceLinkRoute(acc, 'not-a-url-at-all');
  t('3) URL 형식 자체가 아니면 invalid-url로 거절됨', r2.ok === false && r2.reason === 'invalid-url');
}

// =====================================================================
// 4) 축약 링크가 Google 밖의 호스트로 리다이렉트되면(SSRF 방어) 거절함.
// =====================================================================
{
  const acc = directAccount('link-ssrf@example.com');
  const fetchImpl = async () => ({ url: 'http://169.254.169.254/latest/meta-data/' }); // 내부망을 가리키는 리다이렉트를 흉내낸다.
  const r = await resolvePlaceLinkRoute(acc, 'https://maps.app.goo.gl/redirectToInternal', { fetchImpl });
  t('4) 축약 링크가 Google 밖으로 리다이렉트되면 거절됨(SSRF 방어)', r.ok === false && r.reason === 'unsupported-link');
}

// =====================================================================
// 5) Google 도메인은 맞지만 이름·좌표 둘 다 못 뽑아내면 명시적으로
//    실패를 돌려줌(빈 이름으로 조용히 성공 처리하지 않음).
// =====================================================================
{
  const acc = directAccount('link-noinfo@example.com');
  const r = await resolvePlaceLinkRoute(acc, 'https://www.google.com/maps/search/카페');
  t('5) 이름·좌표를 뽑을 근거가 없으면 no-place-info-found로 명시적 실패', r.ok === false && r.reason === 'no-place-info-found');
}

// =====================================================================
// 6) 계정별 하루 호출 한도가 실제로 동작함.
// =====================================================================
{
  const acc = directAccount('link-ratelimit@example.com');
  const url = 'https://www.google.com/maps/place/%EA%B0%80%EA%B2%8C/@35.0,135.0,17z';
  let lastOk = true;
  for (let i = 0; i < 3; i++) {
    const r = await resolvePlaceLinkRoute(acc, url);
    lastOk = r.ok;
  }
  t('6) 한도(3) 안에서는 계속 성공함', lastOk === true);
  const rOver = await resolvePlaceLinkRoute(acc, url);
  t('6) 한도를 넘으면 명시적으로 거절됨', rOver.ok === false && rOver.reason === 'place-link-resolve-daily-limit-reached');
}

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
