'use strict';
/**
 * 유입~구매 측정 이벤트 — 클라이언트 쪽.
 *
 * 2026-09-09 코드 검토: "장소명·메모·GPS·원본 파일 내용을 이벤트에
 * 절대 넣지 않는다." 서버(server/routes/events.mjs)가 화이트리스트로
 * 한 번 더 막지만, 클라이언트에서도 똑같은 화이트리스트로 먼저
 * 걸러낸다 — 실수로 자유 텍스트를 넣는 코드를 짜더라도 네트워크에
 * 나가기 전에 여기서 막힌다(심층 방어).
 *
 * 측정이 실패해도(서버가 아직 없거나 네트워크 문제여도) 앱 동작 자체는
 * 절대 안 막는다 — daTrack은 항상 조용히 성공/실패하고 예외를 던지지
 * 않는다.
 */
const EVENT_SCHEMA = {
  channel_inflow: { props: ['channel'] },
  import_start: { props: ['source_kind'] },
  import_result: { props: ['result', 'imported_count'] },
  course_generated: { props: ['routed_real', 'stop_count'] },
  paywall_viewed: { props: ['trigger'] },
  payment_started: { props: ['amount_krw', 'period_days'] },
  payment_result: { props: ['result'] },
  waitlist_signup: { props: ['channel'] },
  affiliate_click: { props: ['offer_type'] },
  // 2026-09-11 재검토(9차) 6-4절 — 가입→가져오기→코스완성→실사용→피드백 퍼널.
  signup_completed: { props: [] },
  place_visited: { props: [] },
  feedback_submitted: { props: ['type'] },
  survey_submitted: { props: ['actually_traveled'] },
};

function validate(name, props) {
  const schema = EVENT_SCHEMA[name];
  if (!schema) return false;
  const p = props || {};
  return Object.keys(p).every((k) => schema.props.includes(k));
}

/* window.API_BASE가 아예 설정 안 된 상태("이 페이지에 서버 자체가 아직
   안 붙었다")와, 같은 출처 API를 쓰려고 일부러 빈 문자열로 설정한
   상태를 구분해야 한다 — 그래서 존재 여부(!== undefined)로 "서버가
   연결됐는지"를 판단하고, 실제 기지 URL 값 자체는 그 문자열 그대로
   쓴다(빈 문자열이면 같은 출처). */
function isServerConfigured() {
  return typeof window !== 'undefined' && window.API_BASE !== undefined;
}
function apiBase() {
  return (typeof window !== 'undefined' && window.API_BASE) || '';
}

function authHeaders() {
  const token = typeof window !== 'undefined' && window.daSessionToken && window.daSessionToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function daTrack(name, props) {
  if (!validate(name, props)) {
    // 개발 중 실수를 바로 알아차리게 콘솔에는 남기되(운영에선 조용히),
    // 절대 예외를 던지거나 화면 동작을 막지 않는다.
    if (typeof console !== 'undefined') console.warn('daTrack: 허용되지 않은 이벤트/속성 — 전송 안 함', name, props);
    return { ok: false, reason: 'invalid' };
  }
  /* 2026-09-09 코드 검토(2차) 재현된 문제: window.API_BASE를 아무도 안
     정해 준 상태(지금 이 정적 페이지엔 아직 서버가 실제로 안 붙어
     있다 — DESIGN_INTEGRATION_REPORT.md 1-B-8 참고)에서 무작정
     fetch('/api/events')를 시도하면, file:// 페이지 기준으로는
     브라우저가 그 요청 자체를 CORS 위반으로 거부하면서 catch로 잡히는
     예외와는 별개로 콘솔에 오류를 그대로 남긴다("측정이 실패해도 화면
     오류가 하나도 없어야 한다"는 걸 실제로 검증하는 테스트에서 이걸
     재현했다). 서버 주소가 실제로 설정된 경우에만 보낸다 — 설정 안
     됐으면 조용히 아무것도 안 한다(측정 자체가 아직 연결 안 된
     상태이지 "실패"가 아니다). */
  if (!isServerConfigured()) return { ok: false, reason: 'no-server-configured' };
  try {
    const res = await fetch(apiBase() + '/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ name, props: props || {} }),
    });
    return { ok: res.ok };
  } catch (e) {
    return { ok: false, reason: 'network' }; // 서버가 아직 없거나 오프라인이어도 조용히 넘어간다.
  }
}

/* referrer/쿼리스트링만 보고 짧은 분류값 하나로 접는다 — 원본 URL
   전체나 UTM 캠페인 문구 같은 자유 텍스트는 절대 이벤트에 안 싣는다
   (허용된 값은 채널 다섯 가지뿐 — events.mjs의 ALLOWED_CHANNELS와
   반드시 같게 유지한다). */
function daClassifyChannel() {
  try {
    const params = new URLSearchParams(window.location.search);
    const ref = (params.get('ref') || '').toLowerCase();
    if (ref === 'threads' || ref === 'instagram') return ref;
    const referrer = String(document.referrer || '').toLowerCase();
    if (referrer.includes('threads.net')) return 'threads';
    if (referrer.includes('instagram.com')) return 'instagram';
    if (!referrer) return 'direct';
    return 'referral';
  } catch (e) {
    return 'unknown';
  }
}

window.Analytics = { track: daTrack, classifyChannel: daClassifyChannel };
