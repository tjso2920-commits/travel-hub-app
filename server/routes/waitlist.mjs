'use strict';
/**
 * 사전 신청(초기 사용자 명단) — 로드맵 ⑨의 "짧은 구매 흐름"과는 다른
 * 관심사다. 이건 아직 앱 계정이 아니라 "출시하면 알려 주세요·초기
 * 체험에 참여하고 싶어요"라는 관심 표시 하나만 모은다(로그인 코드
 * 발급 같은 건 없다 — 여기선 그럴 필요가 없다).
 *
 * 2026-09-09 코드 검토: "최소한의 필요한 신청 항목만 수집하고, 목적을
 * 분명히 표시한다." 이메일 하나만 받는다 — 이름·연락처·주소 등은
 * 전혀 묻지 않는다.
 */
import { openDb, uuid, nowIso } from '../db.mjs';

export function joinWaitlist({ email, channel }) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized || !normalized.includes('@')) return { ok: false, status: 400, reason: 'invalid-email' };
  const db = openDb();
  db.prepare(`
    INSERT INTO waitlist (id, email, channel, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(email) DO NOTHING
  `).run(uuid(), normalized, channel || null, nowIso());
  return { ok: true, status: 200 };
}

export function waitlistCountForTest() {
  const db = openDb();
  return db.prepare('SELECT COUNT(*) AS n FROM waitlist').get().n;
}
