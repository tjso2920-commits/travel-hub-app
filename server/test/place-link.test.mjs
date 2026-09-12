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
 * 2026-09-11 재검토(14차) 3절 — 추가:
 *  7) ChatGPT 재현 — "@lat,lng"는 지도 중심(뷰포트)일 뿐 장소의 확정
 *     좌표가 아니므로, !3d!4d 데이터 블록 없이 @만 있는 링크는 절대
 *     확정 좌표로 반환되지 않음(needsLookup 큐로 넘어가야 함).
 *  8) !3d!4d(진짜 장소 데이터 블록)가 있는 링크는 그 좌표를 확정
 *     좌표로 실제로 반환함.
 *  9) 이름 없이 좌표(확정/중심 어느 쪽이든)만 있으면 nameRequired로
 *     클라이언트에 이름 입력을 요구함(조용히 무명 장소를 만들지 않음).
 *  10) 리다이렉트 홉을 하나하나 검사함 — 중간 홉이 허용 밖이면(마지막
 *      호스트가 아니라 중간에서) 거절되고, 홉 상한을 넘는 리다이렉트
 *      체인도 거절됨.
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
// 1) 전체 URL에서 이름을 실제로 뽑아냄 — 14차 3절 재현: "@lat,lng"만
//    있고 !3d!4d 데이터 블록이 없으면(지도 중심/뷰포트일 뿐 장소의
//    확정 좌표라는 근거가 없음) 좌표는 절대 확정으로 반환하지 않는다
//    (needsLookup 큐로 넘어가야 함 — 예전엔 이 @ 값을 그대로 확정
//    좌표로 돌려줬었다).
// =====================================================================
{
  const acc = directAccount('link-full@example.com');
  const url = 'https://www.google.com/maps/place/%EC%B9%B4%ED%8E%98+%EB%AA%A8%EB%AA%A8/@35.6812,139.7671,17z/data=!3m1!4b1';
  const r = await resolvePlaceLinkRoute(acc, url);
  t('1) 전체 URL에서 이름을 실제로 뽑아냄', r.ok === true && r.name === '카페 모모');
  t('1) @만 있고 !3d!4d가 없으면 좌표를 확정으로 반환하지 않음(중심좌표 오인 재현 차단)', r.ok === true && r.lat === null && r.lng === null);
  t('1) 이름이 있으므로 이름 입력을 요구하지 않음', r.nameRequired === false);
  t('1) 축약 링크가 아니므로 리다이렉트를 따라가지 않음', r.followedShortLink === false);
}

// =====================================================================
// 2) 축약 링크 — 리다이렉트를 실제로 따라가 최종 URL에서 뽑아냄(진짜
//    네트워크 없이, 매 홉을 검사하는 테스트 전용 fetchImpl로 재현).
//    본문을 받을 필요가 없으므로 HEAD로만 요청해야 한다.
// =====================================================================
{
  const acc = directAccount('link-short@example.com');
  const finalUrl = 'https://www.google.com/maps/place/%EB%9D%BC%EB%A9%98+%EC%9D%B4%EC%B9%98%EB%9E%80/@34.6937,135.5023,17z';
  const fetchImpl = async (u, reqOpts) => {
    t('2) 매 홉을 HEAD로만 요청함(본문 다운로드 없음)', reqOpts && reqOpts.method === 'HEAD' && reqOpts.redirect === 'manual');
    if (u === 'https://maps.app.goo.gl/xYz123') {
      return { status: 302, headers: { get: (h) => (String(h).toLowerCase() === 'location' ? finalUrl : null) } };
    }
    if (u === finalUrl) {
      return { status: 200, headers: { get: () => null } };
    }
    throw new Error('예상 밖의 홉: ' + u);
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
// 4) 축약 링크가 Google 밖의 호스트로 리다이렉트되면(SSRF 방어) 거절함
//    — 마지막 호스트가 아니라 "그 홉 자체"에서 걸려야 한다.
// =====================================================================
{
  const acc = directAccount('link-ssrf@example.com');
  const fetchImpl = async (u) => {
    if (u === 'https://maps.app.goo.gl/redirectToInternal') {
      // 내부망을 가리키는 리다이렉트를 흉내낸다(평문 http이기도 함 —
      // 홉은 https만 허용하므로 이중으로 걸려야 정상).
      return { status: 302, headers: { get: (h) => (String(h).toLowerCase() === 'location' ? 'http://169.254.169.254/latest/meta-data/' : null) } };
    }
    throw new Error('내부망 홉 이후로는 절대 요청이 나가면 안 됨: ' + u);
  };
  const r = await resolvePlaceLinkRoute(acc, 'https://maps.app.goo.gl/redirectToInternal', { fetchImpl });
  t('4) 축약 링크가 Google 밖으로 리다이렉트되면 거절됨(SSRF 방어)', r.ok === false && r.reason === 'unsupported-link');
}

// =====================================================================
// 7) !3d!4d(진짜 장소 데이터 블록)가 있으면 그 좌표를 확정 좌표로
//    실제로 반환함 — @ 뷰포트 값(다른 숫자로 일부러 다르게 둠)과
//    섞이지 않고 정확히 !3d!4d 값만 쓰임을 확인한다.
// =====================================================================
{
  const acc = directAccount('link-confirmed-coord@example.com');
  // @는 뷰포트(35.0,139.0), !3d!4d는 실제 장소 데이터 블록(35.6812,139.7671) — 일부러 다르게 둠.
  const url = 'https://www.google.com/maps/place/%EC%B9%B4%ED%8E%98+%EB%AA%A8%EB%AA%A8/@35.0,139.0,17z/data=!4m6!3m5!1s0x0:0x0!8m2!3d35.6812!4d139.7671!16s%2Fg%2F11abc';
  const r = await resolvePlaceLinkRoute(acc, url);
  t('7) !3d!4d 값을 확정 좌표로 반환함(뷰포트 @ 값과 다름)', r.ok === true && Math.abs(r.lat - 35.6812) < 0.0001 && Math.abs(r.lng - 139.7671) < 0.0001);
}

// =====================================================================
// 8) 이름 없이 좌표(중심좌표)만 있으면 조용히 무명 장소를 만들지 않고
//    nameRequired로 클라이언트에 이름 입력을 요구함.
// =====================================================================
{
  const acc = directAccount('link-name-required@example.com');
  const url = 'https://www.google.com/maps/@35.6812,139.7671,17z'; // 장소가 아니라 지도 화면 자체를 공유한 링크(순수 뷰포트).
  const r = await resolvePlaceLinkRoute(acc, url);
  t('8) 이름을 못 찾으면 nameRequired=true를 돌려줌', r.ok === true && r.name === null && r.nameRequired === true);
  t('8) 확정 안 된 좌표이므로 lat/lng는 null임', r.lat === null && r.lng === null);
}

// =====================================================================
// 9) 리다이렉트 홉이 상한(5)을 넘으면(비정상적으로 긴 체인·순환) 거절함.
// =====================================================================
{
  const acc = directAccount('link-toomanyhops@example.com');
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { status: 302, headers: { get: (h) => (String(h).toLowerCase() === 'location' ? `https://maps.app.goo.gl/hop${calls}` : null) } };
  };
  const r = await resolvePlaceLinkRoute(acc, 'https://maps.app.goo.gl/hop0', { fetchImpl });
  t('9) 홉 상한을 넘는 리다이렉트 체인은 거절됨', r.ok === false && r.reason === 'link-resolve-failed');
  t('9) 상한만큼만 실제로 요청함(무한 루프 아님)', calls <= 5);
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
