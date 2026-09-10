'use strict';
/**
 * 유입~구매 측정 이벤트 저장 — "장소명·메모·GPS·원본 파일 내용을 이벤트에
 * 절대 넣지 않는다"(코드 검토 지시사항)는 원칙을 클라이언트 쪽 검증
 * (src/design/analytics.mjs)만 믿지 않고 서버에서도 한 번 더 강제한다
 * (심층 방어 — 클라이언트 코드는 사용자가 직접 열어볼 수 있고 우회할
 * 수도 있다).
 *
 * 이벤트 이름과 그 이벤트가 가질 수 있는 속성(prop) 키를 화이트리스트로
 * 못 박아 둔다 — 목록에 없는 이벤트 이름이나, 목록에 없는 속성 키가
 * 오면 그 자리에서 거부한다(자유 텍스트 필드 자체가 없다 — "혹시
 * 몰라서 만든 note 필드"에 실수로 장소명이 새어 들어가는 사고를
 * 원천적으로 막는다).
 */
import { openDb, uuid, nowIso } from '../db.mjs';

/* 유입~구매 퍼널 이벤트 6종(코드 검토에서 요청한 그대로) + 값이 허용된
   속성. 값 자체도 "미리 정한 몇 가지 중 하나"만 허용하는 이벤트는
   enum으로 제한한다(예: import_result는 'success'|'failure'만). */
const EVENT_SCHEMA = {
  channel_inflow: { props: ['channel'] }, // channel: 'threads'|'instagram'|'direct'|'referral'|'unknown' 등 짧은 분류값만
  import_start: { props: ['source_kind'] }, // 'zip'|'csv'|'json' — 파일명·내용 아님
  import_result: { props: ['result', 'imported_count'] }, // result: 'success'|'failure', imported_count: 숫자
  course_generated: { props: ['routed_real', 'stop_count'] }, // 장소명 없이 개수·성공 여부만
  paywall_viewed: { props: ['trigger'] }, // 'second_course'|'manual' 등 짧은 분류값
  payment_started: { props: ['amount_krw', 'period_days'] },
  payment_result: { props: ['result'] }, // 'success'|'failure'|'cancelled'
  waitlist_signup: { props: ['channel'] }, // 소개 페이지 사전 신청 완료(로드맵 ⑪)
};

const ALLOWED_CHANNELS = new Set(['threads', 'instagram', 'direct', 'referral', 'unknown']);
const ALLOWED_SOURCE_KINDS = new Set(['zip', 'csv', 'json']);
const ALLOWED_RESULTS = new Set(['success', 'failure']);
const ALLOWED_PAYMENT_RESULTS = new Set(['success', 'failure', 'cancelled']);
const ALLOWED_TRIGGERS = new Set(['second_course', 'new_day', 'manual', 'time_budget_exceeded']);

function validateProps(name, props) {
  const schema = EVENT_SCHEMA[name];
  if (!schema) return { ok: false, reason: 'unknown-event' };
  const p = props || {};
  const extraKeys = Object.keys(p).filter((k) => !schema.props.includes(k));
  if (extraKeys.length) return { ok: false, reason: 'unexpected-props: ' + extraKeys.join(',') };

  if (name === 'channel_inflow' && !ALLOWED_CHANNELS.has(p.channel)) return { ok: false, reason: 'invalid-channel' };
  if (name === 'import_start' && !ALLOWED_SOURCE_KINDS.has(p.source_kind)) return { ok: false, reason: 'invalid-source-kind' };
  if (name === 'import_result') {
    if (!ALLOWED_RESULTS.has(p.result)) return { ok: false, reason: 'invalid-result' };
    if (p.imported_count !== undefined && (!Number.isInteger(p.imported_count) || p.imported_count < 0)) return { ok: false, reason: 'invalid-imported-count' };
  }
  if (name === 'course_generated') {
    if (typeof p.routed_real !== 'boolean') return { ok: false, reason: 'invalid-routed-real' };
    if (!Number.isInteger(p.stop_count) || p.stop_count < 0) return { ok: false, reason: 'invalid-stop-count' };
  }
  if (name === 'paywall_viewed' && !ALLOWED_TRIGGERS.has(p.trigger)) return { ok: false, reason: 'invalid-trigger' };
  if (name === 'payment_started') {
    if (!Number.isFinite(p.amount_krw) || p.amount_krw < 0) return { ok: false, reason: 'invalid-amount' };
    if (!Number.isInteger(p.period_days) || p.period_days <= 0) return { ok: false, reason: 'invalid-period' };
  }
  if (name === 'payment_result' && !ALLOWED_PAYMENT_RESULTS.has(p.result)) return { ok: false, reason: 'invalid-result' };
  if (name === 'waitlist_signup' && !ALLOWED_CHANNELS.has(p.channel)) return { ok: false, reason: 'invalid-channel' };

  // 값 하나하나가 너무 긴 자유 텍스트가 아닌지도 본다(숫자·불리언·허용된
  // 열거값 외에는 전부 여기서 걸린다 — 위 개별 검사를 통과한 값들은
  // 이미 숫자/불리언/열거값 중 하나이므로 이 시점엔 자유 텍스트가 없다).
  return { ok: true };
}

export function recordEvent({ name, props, accountId }) {
  const check = validateProps(name, props);
  if (!check.ok) return { ok: false, status: 400, reason: check.reason };
  const db = openDb();
  db.prepare('INSERT INTO events (id, name, props, account_id, occurred_at) VALUES (?, ?, ?, ?, ?)')
    .run(uuid(), name, JSON.stringify(props || {}), accountId || null, nowIso());
  return { ok: true, status: 200 };
}

export const eventSchemaForTest = EVENT_SCHEMA;
