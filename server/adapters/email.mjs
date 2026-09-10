'use strict';
/**
 * 이메일 발송 어댑터 — 로그인 코드(매직 코드) 전달용.
 *
 * 테스트 어댑터는 실제로 이메일을 보내지 않고, 이 프로세스 메모리 안의
 * 배열에 "보낼 내용"을 기록만 한다 — 서버 테스트가 그 배열을 읽어
 * "실제로 이 이메일 주소로 이 코드가 발송 시도됐는지"를 검증할 수 있다.
 * 실제 SMTP/이메일 API 전환은 smtpAdapter를 실제 발송 코드로 바꾸는
 * 것만 남는다.
 */
import { config } from '../config.mjs';

export const sentEmailsForTest = [];

function testAdapter({ to, subject, body }) {
  sentEmailsForTest.push({ to, subject, body, at: new Date().toISOString() });
  return { ok: true };
}

async function smtpAdapter({ to, subject, body }) {
  const apiKey = process.env.EMAIL_API_KEY;
  if (!apiKey) return { ok: false, reason: 'no-email-credentials-configured' };
  // 실제 서비스 전환 시 여기에 실제 이메일 API 호출을 넣는다(SendGrid 등).
  return { ok: false, reason: 'not-implemented' };
}

export async function sendEmail(params) {
  if (config.services.email !== 'real') return testAdapter(params);
  return smtpAdapter(params);
}
