'use strict';
/**
 * 이메일 발송 어댑터 — 로그인 코드(매직 코드) 전달용.
 *
 * 테스트 어댑터는 실제로 이메일을 보내지 않고, 이 프로세스 메모리 안의
 * 배열에 "보낼 내용"을 기록만 한다.
 *
 * 2026-09-10 재검토(3차) — 실제 이메일 발송 코드(Resend) 구현. **이
 * 세션은 네트워크 정책상 resend.com 공식 문서에 직접 접속하지 못했다**
 * (docs.tosspayments.com·resend.com·developers.google.com 전부
 * EGRESS_BLOCKED로 막혀 있었다 — 시도 기록은 커밋 메시지·RELEASE_STATUS
 * 참고). 아래 요청 형식(엔드포인트·인증 헤더·필드명)은 학습된 지식
 * 기준으로 작성했고, **실제 키를 넣기 전에 반드시 현재 공식 문서와
 * 대조해야 한다** — 특히 응답 필드명·오류 코드는 서비스 쪽에서 바뀌었을
 * 수 있다. 요청/응답을 다루는 구조(재시도 없음, 실패 시 발급된 코드
 * 무효화, 발신 주소는 도메인 인증 필요)는 문서가 조금 바뀌어도 코드
 * 전체를 다시 쓸 필요 없이 URL·필드명 몇 개만 맞추면 되게 짰다.
 */
import { config } from '../config.mjs';
import { markVerified } from '../status.mjs';

export const sentEmailsForTest = [];

function testAdapter({ to, subject, body }) {
  sentEmailsForTest.push({ to, subject, body, at: new Date().toISOString() });
  return { ok: true };
}

/* Resend 실제 발송 — POST https://api.resend.com/emails, Authorization:
   Bearer <RESEND_API_KEY>, 본문 {from, to, subject, html, text}. 성공 시
   {id: "..."}. 실패 시 4xx/5xx + 오류 본문(정확한 필드명은 문서 재확인
   필요 — 아래는 statusCode/message가 온다고 가정하고 방어적으로 파싱).
   `from` 주소는 Resend에 도메인 인증이 안 돼 있으면 발송이 거부된다 —
   테스트/개발 단계에서는 Resend가 제공하는 발신 전용 샌드박스 주소
   (onboarding@resend.dev)로 실제 발송을 확인할 수 있다고 알려져 있다
   (이 값도 실제 사용 전 문서 재확인 대상). */
async function resendAdapter({ to, subject, body }) {
  const apiKey = config.resend.apiKey;
  if (!apiKey) return { ok: false, reason: 'no-email-credentials-configured' };
  try {
    const res = await fetch(`${config.resend.apiBase}/emails`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: config.resend.from,
        to: [to],
        subject,
        text: body,
        html: `<p>${String(body).replace(/</g, '&lt;')}</p>`,
      }),
    });
    let json = null;
    try { json = await res.json(); } catch (e) { /* 본문 없음 */ }
    if (!res.ok) {
      return { ok: false, reason: 'resend-error', status: res.status, detail: json && (json.message || json.name) };
    }
    markVerified('email');
    return { ok: true, id: json && json.id };
  } catch (e) {
    return { ok: false, reason: 'network-error', detail: String(e && e.message) };
  }
}

export async function sendEmail(params) {
  if (config.services.email !== 'real') {
    // 운영인데 이메일 서비스가 unavailable이면 조용히 test로 넘어가지
    // 않는다 — 정직하게 실패를 알린다(2026-09-10: "가짜 장소·모의 결제·
    // 테스트 이메일을 운영에서 반환하지 마세요").
    if (config.isProd) return { ok: false, reason: 'email-service-unavailable' };
    return testAdapter(params);
  }
  return resendAdapter(params);
}
