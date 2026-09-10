'use strict';
/**
 * 유료 이용권 확인 — 클라이언트는 표시만 하고, 실제 판정은 항상 서버가
 * 한다(코드 검토 ⑧). "결제했다"는 클라이언트 자기 신고를 신뢰하지
 * 않는다 — plan/plan_expires_at은 오직 결제 웹훅(webhook.mjs)이 실제
 * PG 승인을 확인한 뒤에만 바뀐다.
 */
import { openDb } from '../db.mjs';
import { config } from '../config.mjs';

// 2026-09-10 재검토(6차) — "구매 화면에 가격·기간·자동갱신 여부·포함
// 사용량을 간단히 표시하라"는 지시. 클라이언트에 숫자를 박지 않는다는
// 기존 원칙 그대로, 유료 이용권에 포함된 사용량(위치 확인·코스 생성
// 횟수)도 서버 설정값을 그대로 실어 보낸다.
function priceWithIncludedUsage() {
  return {
    ...config.price,
    includedPlaceLookups: config.entitlementUsage.paidPlaceLookupLimit,
    includedCourseGenerations: config.entitlementUsage.paidCourseLimit,
  };
}

export function checkEntitlement(accountId) {
  const db = openDb();
  const row = db.prepare('SELECT plan, plan_expires_at FROM accounts WHERE id = ?').get(accountId);
  if (!row) return { ok: false, reason: 'account-not-found' };
  const active = row.plan === 'paid' && (!row.plan_expires_at || new Date(row.plan_expires_at).getTime() > Date.now());
  return {
    ok: true,
    plan: active ? 'paid' : 'free',
    expiresAt: row.plan_expires_at,
    price: priceWithIncludedUsage(), // 가격은 항상 서버 설정값을 그대로 보여준다 — 클라이언트에 숫자를 박지 않는다.
  };
}

/* orderId를 넘기면(실제 토스 결제 승인 경로) 이 주문을 "지금 이용권을
   실제로 부여한 주문"으로 accounts.active_order_id에 기록해 둔다 —
   나중에 이 주문보다 옛날 주문이 취소돼도 지금의 이용권을 안 건드리게
   하기 위해서다(revokeEntitlementIfCurrentOrder 참고). orderId 없이
   부르는 기존 경로(개발용 웹훅 시뮬레이션)는 그대로 두어 기존 동작을
   안 건드린다. */
export function grantEntitlement(accountId, days, orderId) {
  const db = openDb();
  const expiresAt = new Date(Date.now() + (days || config.price.periodDays) * 86400000).toISOString();
  if (orderId) {
    db.prepare('UPDATE accounts SET plan = ?, plan_expires_at = ?, active_order_id = ? WHERE id = ?').run('paid', expiresAt, orderId, accountId);
  } else {
    db.prepare('UPDATE accounts SET plan = ?, plan_expires_at = ? WHERE id = ?').run('paid', expiresAt, accountId);
  }
  return { ok: true, expiresAt };
}

/* 무조건 회수 — 개발용 웹훅 시뮬레이션(webhook.mjs)이 쓰는 기존 경로.
   그 경로는 orders 테이블 개념이 없는 단일 계정 단위 시뮬레이션이라
   "여러 주문 중 어느 게 지금 유효한지" 구분이 필요 없다(하나의
   계정에는 항상 최대 하나의 활성 결제만 시뮬레이션한다는 전제). */
export function revokeEntitlement(accountId) {
  const db = openDb();
  db.prepare('UPDATE accounts SET plan = ?, plan_expires_at = NULL, active_order_id = NULL WHERE id = ?').run('free', accountId);
  return { ok: true };
}

/* 2026-09-10 재검토(4차) — "과거 주문 취소가 다른 유효 주문의 이용권을
   없애지 않도록"을 실제로 지키는 함수. 실제 토스 결제(payment-toss.mjs)
   의 취소·웹훅 경로는 반드시 이 함수를 써야 한다(revokeEntitlement를
   직접 부르면 안 됨) — 지금 이 계정의 이용권을 실제로 부여한 주문
   (accounts.active_order_id)이 지금 취소되는 그 주문과 같을 때만
   실제로 회수한다. 계정이 그 사이 재구매해 이미 새 주문으로 넘어갔다면
   (active_order_id가 다르면) 옛 주문을 취소해도 지금의 이용권은 그대로
   둔다 — skipped:true로 그 사실을 알린다(호출부가 이벤트로 남길 수
   있게). */
export function revokeEntitlementIfCurrentOrder(accountId, orderId) {
  const db = openDb();
  const row = db.prepare('SELECT active_order_id FROM accounts WHERE id = ?').get(accountId);
  if (!row) return { ok: false, reason: 'account-not-found' };
  if (row.active_order_id !== orderId) {
    return { ok: true, skipped: true, reason: 'superseded-by-newer-order' };
  }
  db.prepare('UPDATE accounts SET plan = ?, plan_expires_at = NULL, active_order_id = NULL WHERE id = ?').run('free', accountId);
  return { ok: true, skipped: false };
}
