'use strict';
/**
 * 토스페이먼츠 결제위젯 연동 — 실제 결제 어댑터.
 *
 * **중요한 한계 고지**: 이 세션은 네트워크 정책상
 * `docs.tosspayments.com`에 직접 접속하지 못했다(WebFetch가
 * EGRESS_BLOCKED로 거부됨 — 2026-09-10 재검토 4차에서도 다시 시도했지만
 * 여전히 막혀 있었다). 아래 엔드포인트·필드명·인증 방식은 학습된 지식을
 * 기준으로 작성한 것이지, 이 세션에서 공식 문서를 다시 대조해 확인한
 * 것이 아니다 — **실제 시크릿 키를 넣기 전에 반드시 사람이
 * docs.tosspayments.com에서 현재 문서와 한 줄씩 대조해야 한다.**
 *
 * 2026-09-10 재검토(4차) — ChatGPT가 지적한 문제와 이번에 고친 것:
 * 1. **취소 권한**: 예전엔 /api/payment/cancel이 로그인 여부만 확인하고
 *    accountId 대조 없이 취소를 진행했다 — 다른 계정의 주문을 취소할 수
 *    있었다. 이제 cancelPayment는 accountId를 반드시 받고, 주문
 *    소유자와 대조한 뒤에만 진행한다.
 * 2. **금액·통화 대조**: 승인 전 서버가 정한 금액과 클라이언트가 보낸
 *    금액을 대조하던 기존 로직에 더해, 통화(KRW)도 명시적으로 확인한다.
 * 3. **유실/타임아웃 시 무조건 실패 확정 금지**: confirm 호출이
 *    네트워크 오류로 실패하면 곧바로 실패로 단정하지 않고, 토스 조회
 *    API로 실제 상태를 한 번 더 확인한 뒤에만 최종 실패로 처리한다.
 * 4. **동시 요청 방지**: 같은 주문에 대한 confirm·cancel이 동시에 들어와도
 *    실제 토스 API 호출은 한 번만 나가게 order 단위 잠금을 건다
 *    (server/locks.mjs, generation_locks와 같은 패턴).
 * 5. **과거 주문 취소가 다른 유효 이용권을 안 건드림**: revokeEntitlement를
 *    직접 부르지 않고 revokeEntitlementIfCurrentOrder를 쓴다 — 계정이
 *    이미 재구매해 새 주문으로 넘어갔다면, 옛 주문을 취소해도 지금
 *    이용권은 그대로 둔다.
 * 6. **부분 취소 ≠ 전액 취소**: 부분 취소는 별도 상태
 *    (`partially_cancelled`)로 남기고, 자동으로 이용권을 회수하지
 *    않는다 — 부분 환불 시 이용권을 어떻게 조정할지는 확정된 정책이
 *    없다(BUSINESS_DECISIONS.md에 별도 보고). 소비자 화면에는 부분 취소
 *    기능 자체가 없다(완성되지 않은 기능을 완성된 것처럼 노출하지
 *    않는다는 지시 반영).
 * 7. **활성 이용권이 있으면 중복 구매 차단**: createOrder가 이용권이
 *    이미 유효한 계정의 새 주문 생성을 거부하고 만료일을 알려준다.
 * 8. **모든 토스 호출에 타임아웃 적용**: server/net.mjs의
 *    fetchWithTimeout을 쓴다.
 *
 * 2026-09-10 재검토(5차) — ChatGPT가 지적한 남은 경계를 고쳤다:
 * a. **paymentMatchesOrder 필드 누락 우회**: 필드가 없으면 그 검사를
 *    건너뛰던 것을 "없으면 불일치"로 바꾸고, paymentKey도 대조 대상에
 *    추가했다.
 * b. **여러 pending 주문으로 중복구매 차단 우회 방지**: createOrder
 *    시점 확인만으로는 거의 동시에 만든 주문 2개를 각각 confirm하는
 *    경로를 못 막는다 — confirmPayment도 "이 주문이 아닌 다른 주문"이
 *    부여한 활성 이용권이 있으면 토스를 부르기도 전에 거부한다.
 * c. **부분 취소 판정을 공급자 응답 기준으로**: 요청한 cancelAmount가
 *    아니라 응답의 status/balanceAmount/누적 cancels 금액으로 부분/전액
 *    을 가른다.
 * d. **결제 가능 여부 판정 확장**: 월간 한도가 "정확히 다 찼을 때"만
 *    보지 않고, 일일 한도·최소 코스 생성비 부족·운영에서 경로 API 키
 *    자체가 없는 상태까지 "신규 판매 불가"로 본다(새 주문 생성만 막고,
 *    이미 진행 중인 confirm은 건드리지 않는다).
 * e. 위 d의 신규판매 차단과, 이미 승인된 결제의 복구(재시도 confirm)는
 *    코드 경로 자체가 분리돼 있다 — order.status==='paid' 조기 반환이
 *    d/b의 어떤 검사보다 먼저 온다.
 */
import { openDb, uuid, nowIso } from '../db.mjs';
import { config } from '../config.mjs';
import { fetchWithTimeout } from '../net.mjs';
import { acquireLock, releaseLock } from '../locks.mjs';
import { checkEntitlement, grantEntitlement, revokeEntitlementIfCurrentOrder } from '../routes/entitlement.mjs';
import { markVerified } from '../status.mjs';
import { usageSummary, periodCostMicros } from '../cost-ledger.mjs';

function authHeader() {
  return 'Basic ' + Buffer.from(`${config.toss.secretKey}:`).toString('base64');
}

export function orderName() {
  return `travel hub ${config.price.periodDays}일 이용권`;
}

/* 주문을 서버가 먼저 만들어 둔다 — 금액·orderId를 서버가 authoritative
   하게 쥐고 있어야, 나중에 confirm 단계에서 "클라이언트가 부른 금액"이
   아니라 "서버가 애초에 정한 금액"과 실제 승인 금액을 대조할 수 있다
   (클라이언트가 요청 본문의 amount를 조작해도 서버가 안 믿는다).

   **활성 이용권이 있으면 새 주문을 만들지 않는다**(중복 구매 방지 —
   2026-09-10 재검토 4차 신규 확정 사업 규칙 1절). 클라이언트 화면에서
   버튼을 막는 것만으로는 부족하다 — 서버가 유일한 판정 주체라는 이
   프로젝트 전체의 원칙과 같은 이유로, 여기서도 서버가 직접 막는다. */
/* 2026-09-10 재검토(4차) — "서비스 전체가 신규 코스 제공 불가 상태라면
   결제만 먼저 받는 흐름을 막으라." 이번 달 전체 API 비용 한도가 이미
   꽉 찼다면(장소조회·경로 계산이 사실상 전부 막힌 상태) 새 결제도 막는다
   — 그렇지 않으면 손님이 9,900원을 내고도 정작 코스를 하나도 못
   만드는 상황이 생긴다. */
/* 2026-09-10 재검토(5차) — ChatGPT 지적: "월 5만원은 초기 전체 운영
   목표이지 전액 Google 예산이 아니다"와 별개로, 이 판정 자체는 "이번
   달 전체 한도가 정확히 다 찼는가"만 봤다 — 그러면: (1) 일일 한도가
   먼저 걸려도 안 걸리는 것처럼 취급되고, (2) 남은 예산이 코스 하나도
   못 만들 만큼 적어도(예: 100원 남았는데 조회+경로 비용이 51.8원이면
   1건은 되고 그 다음은 못 되는데) 새 결제를 계속 받고, (3) 운영인데
   경로 API 키 자체가 없어(services.routing !== 'real') 애초에 코스를
   못 만드는 상태에서도 결제만 먼저 받을 수 있었다. 이제 이 세 가지를
   전부 "신규 판매를 막아야 하는 상태"로 본다.

   **이미 결제를 마친 손님의 이용권 부여(복구 포함)는 이 함수와 완전히
   분리돼 있다** — 이 함수는 createOrder(신규 주문 생성)에서만 부르고,
   confirmPayment의 "이미 승인된 주문 재확인"(order.status==='paid')
   경로는 이 함수를 아예 거치지 않는다.

   **2026-09-10 재검토(6차) — "전체 서비스 예산과 기존 유료 고객에게
   제공해야 할 잔여 사용량을 고려해 신규 판매 가능 여부를 판단하라"**:
   예전(5차)엔 "이번 달 남은 예산이 코스 딱 하나(최소 원가)는 되는가"
   만 봤다 — 이미 활성인 다른 유료 손님들이 아직 다 안 쓴 만큼(최악의
   경우 이용권 하나당 원가 안전상한까지 전부 쓸 수 있다고 가정한
   "약속된 몫")을 전혀 안 뺐다. 그러면 활성 유료 손님이 여러 명일 때,
   그들 몫을 다 주고 나면 예산이 바닥날 상황에서도 새 손님을 계속
   받을 수 있었다 — 신규 손님은 결제만 하고 정작 서비스를 못 받거나,
   기존 손님 몫을 침범하는 결과로 이어질 수 있다. 이제 "이번 달 남은
   예산에서 기존 활성 유료 손님들의 약속된 잔여 몫을 먼저 뺀 뒤에도,
   새 손님 한 명의 최악의 경우(이용권 하나 전체 안전상한)를 감당할
   여유가 남는지"를 확인한다. */
function totalCommittedRemainingMicros() {
  const db = openDb();
  const rows = db.prepare("SELECT id, active_order_id FROM accounts WHERE plan = 'paid' AND (plan_expires_at IS NULL OR plan_expires_at > ?)").all(nowIso());
  let total = 0;
  for (const row of rows) {
    if (!row.active_order_id) continue;
    const spent = periodCostMicros(row.id, row.active_order_id);
    total += Math.max(0, config.costSafetyCap.paidEntitlementMicros - spent);
  }
  return total;
}

function isServiceUnavailableForNewSales() {
  if (config.isProd && config.services.routing !== 'real') return true;
  const usage = usageSummary(null);
  const caps = usage.caps;
  const minCourseCostMicros = config.costEstimate.placesTextSearchMicros + config.costEstimate.routesComputeMicros;
  if (caps.globalMonthlyMicros > 0 && usage.globalMonthlyMicros >= caps.globalMonthlyMicros) return true;
  if (caps.globalDailyMicros > 0 && usage.globalDailyMicros >= caps.globalDailyMicros) return true;
  if (caps.globalMonthlyMicros > 0 && (caps.globalMonthlyMicros - usage.globalMonthlyMicros) < minCourseCostMicros) return true;
  if (caps.globalDailyMicros > 0 && (caps.globalDailyMicros - usage.globalDailyMicros) < minCourseCostMicros) return true;

  if (caps.globalMonthlyMicros > 0) {
    const committed = totalCommittedRemainingMicros();
    const remainingAfterCommitments = (caps.globalMonthlyMicros - usage.globalMonthlyMicros) - committed;
    if (remainingAfterCommitments < config.costSafetyCap.paidEntitlementMicros) return true;
  }
  return false;
}

export function createOrder(accountId) {
  if (isServiceUnavailableForNewSales()) {
    return { ok: false, status: 503, reason: 'service-unavailable-for-new-sales' };
  }
  const ent = checkEntitlement(accountId);
  if (ent.ok && ent.plan === 'paid') {
    return { ok: false, status: 409, reason: 'already-has-active-entitlement', expiresAt: ent.expiresAt };
  }
  const db = openDb();
  const orderId = 'order_' + uuid();
  const amount = config.price.amountKrw;
  const now = nowIso();
  db.prepare('INSERT INTO orders (order_id, account_id, amount, status, entitlement_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(orderId, accountId, amount, 'pending', config.price.periodDays, now, now);
  return { ok: true, orderId, amount, orderName: orderName() };
}

function getOrder(orderId) {
  const db = openDb();
  return db.prepare('SELECT * FROM orders WHERE order_id = ?').get(orderId);
}

async function tossFetch(pathname, init) {
  const res = await fetchWithTimeout(`${config.toss.apiBase}${pathname}`, {
    ...init,
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json', ...(init && init.headers) },
  }, config.externalRequestTimeoutMs);
  let json = null;
  try { json = await res.json(); } catch (e) { /* 본문 없음 */ }
  return { ok: res.ok, status: res.status, json };
}

export async function queryPayment(paymentKey) {
  if (config.services.payment !== 'real') return { ok: false, reason: 'payment-service-not-real' };
  try {
    return await tossFetch(`/v1/payments/${encodeURIComponent(paymentKey)}`, { method: 'GET' });
  } catch (e) {
    return { ok: false, reason: 'network-error', detail: String(e && e.message) };
  }
}

/* 승인 응답(또는 재조회 응답)이 실제로 우리 주문과 같은 결제인지 —
   주문번호·금액·통화를 전부 대조한다(2026-09-10 재검토 4차: "주문번호,
   결제키, 금액, 통화를 서버 주문과 대조하라"). 하나라도 안 맞으면
   위조·오배선 가능성이 있다고 보고 신뢰하지 않는다. */
/* 2026-09-10 재검토(5차) — ChatGPT 지적: 예전엔 필드가 "없으면" 그 검사를
   통째로 건너뛰었다(누락 = 통과 취급) — 응답이 불완전하거나 위조된
   경우도 놓칠 수 있었다. 이제 필수 필드(주문번호·금액·통화)는 값 자체가
   없어도 불일치로 본다. 또한 `paymentKey`도 대조 대상에 추가한다(호출부가
   자신이 확인하려는 paymentKey를 `expectedPaymentKey`로 넘긴다) —
   금액·주문번호가 우연히 같아도 실제로는 다른 결제 건이 섞여 들어오는
   경우까지 막는다. */
function paymentMatchesOrder(payment, order, expectedPaymentKey) {
  if (!payment) return false;
  if (!payment.orderId || payment.orderId !== order.order_id) return false;
  const amount = payment.totalAmount != null ? payment.totalAmount : payment.amount;
  if (amount == null || Number(amount) !== order.amount) return false;
  if (!payment.currency || payment.currency !== config.expectedCurrency) return false;
  if (expectedPaymentKey != null && (!payment.paymentKey || payment.paymentKey !== expectedPaymentKey)) return false;
  return true;
}

/* 승인 — accountId는 반드시 세션 토큰에서 뽑은 값을 넘겨야 한다(요청
   본문의 값을 신뢰하지 않는다는 이 서버 전체의 원칙과 동일). 주문의
   소유자가 그 계정이 맞는지, 금액이 서버가 애초에 정한 값과 같은지
   전부 여기서 확인한 뒤에만 실제 토스 API를 부른다.

   동시 confirm 요청은 order 단위 잠금으로 하나만 실제 토스 승인 호출을
   내보내게 막는다. 네트워크 오류·타임아웃으로 confirm 자체가 실패해도
   곧바로 실패로 단정하지 않고 조회 API로 실제 상태를 한 번 더 확인한다
   (2026-09-10 재검토 4차 — "승인 응답 유실·타임아웃 시 무조건 실패
   확정하지 말 것"). */
export async function confirmPayment({ accountId, orderId, paymentKey, amount, currency }) {
  if (config.services.payment !== 'real') return { ok: false, status: 503, reason: 'payment-service-unavailable' };
  const order = getOrder(orderId);
  if (!order) return { ok: false, status: 404, reason: 'order-not-found' };
  if (order.account_id !== accountId) return { ok: false, status: 403, reason: 'order-account-mismatch' };
  if (Number(amount) !== order.amount) return { ok: false, status: 400, reason: 'amount-mismatch' };
  if (currency && currency !== config.expectedCurrency) return { ok: false, status: 400, reason: 'currency-mismatch' };
  if (order.status === 'paid') return { ok: true, status: 200, alreadyProcessed: true };

  // 2026-09-10 재검토(5차) — ChatGPT 지적: "여러 개의 pending 주문을
  // 만들고 각각 개별적으로 confirm하면 활성 이용권 중복구매 차단을
  // 우회할 수 있는지" 확인 지시. createOrder 시점 확인만으로는 두 주문을
  // 거의 동시에 만든 경쟁 상황(둘 다 아직 미승인이라 그때는 이용권이
  // 없었음)을 못 막는다 — 지금 이 계정에 "이 주문이 아닌 다른 주문"이
  // 부여한 활성 이용권이 이미 있으면, 실제 토스 승인 호출을 부르기도
  // 전에 거부한다(위젯 승인만 됐지 confirm 전이라 아직 실제 청구는
  // 안 나간 상태 — 거부하면 그 인증은 토스 쪽에서 그냥 만료된다).
  // 바로 위의 "alreadyProcessed" 조기 반환(이 주문 자신의 재확인/복구)은
  // 이 검사보다 먼저 걸러지므로 서로 안 겹친다(항목 (e) — 이미 승인된
  // 결제의 복구는 이 신규판매 차단과 분리해서 처리).
  const acctRow = openDb().prepare('SELECT active_order_id, plan, plan_expires_at FROM accounts WHERE id = ?').get(accountId);
  const hasOtherActiveEntitlement = acctRow && acctRow.plan === 'paid'
    && (!acctRow.plan_expires_at || new Date(acctRow.plan_expires_at).getTime() > Date.now())
    && acctRow.active_order_id && acctRow.active_order_id !== orderId;
  if (hasOtherActiveEntitlement) {
    return { ok: false, status: 409, reason: 'already-has-active-entitlement', expiresAt: acctRow.plan_expires_at };
  }

  const jobId = acquireLock('payment_locks', 'order_id', orderId, config.paymentLockTimeoutSeconds);
  if (!jobId) return { ok: false, status: 409, reason: 'confirm-in-progress' };

  try {
    let confirmed = null; // 최종적으로 "실제 승인됐다"고 확신하면 여기에 결제 객체를 담는다.
    let hardFailure = null; // 재조회로도 못 살릴, 확정적인 실패.

    let res;
    try {
      res = await tossFetch('/v1/payments/confirm', {
        method: 'POST',
        body: JSON.stringify({ paymentKey, orderId, amount: order.amount }),
      });
    } catch (e) {
      res = null; // 네트워크 오류/타임아웃 — 아래에서 조회로 실제 상태를 확인한다.
    }

    if (res && res.ok && res.json && res.json.status === 'DONE' && paymentMatchesOrder(res.json, order, paymentKey)) {
      confirmed = res.json;
    } else if (res && res.ok && res.json && res.json.status === 'DONE') {
      // 승인은 됐다는데 우리 주문과 금액/통화/결제키가 안 맞는다 — 절대
      // 이용권을 주지 않는다(위조·오배선 의심, 사람이 직접 봐야 하는 상황).
      hardFailure = { reason: 'confirmed-but-mismatch', detail: res.json };
    } else {
      // confirm 자체가 실패(네트워크 오류/4xx/5xx/응답 없음)했거나 상태가
      // DONE이 아니다 — 곧바로 실패로 단정하지 않고 조회 API로 다시
      // 확인한다(재시도·유실 대응).
      const query = await queryPayment(paymentKey);
      if (query.ok && query.json && query.json.status === 'DONE' && paymentMatchesOrder(query.json, order, paymentKey)) {
        confirmed = query.json;
      } else if (!res) {
        hardFailure = { reason: 'network-error-unconfirmed', detail: query.ok ? query.json : query.reason };
      } else {
        hardFailure = { reason: 'toss-confirm-failed', detail: res.json };
      }
    }

    const db = openDb();
    if (confirmed) {
      const now = nowIso();
      db.exec('BEGIN');
      try {
        db.prepare('UPDATE orders SET status = ?, payment_key = ?, paid_at = ?, updated_at = ? WHERE order_id = ?')
          .run('paid', paymentKey, now, now, orderId);
        grantEntitlement(accountId, order.entitlement_days || config.price.periodDays, orderId);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        return { ok: false, status: 500, reason: 'entitlement-storage-failed' };
      }
      markVerified('payment');
      return { ok: true, status: 200 };
    }

    // 확정적인 실패만 주문 상태를 'failed'로 남긴다 — "모르겠다"인 채로
    // 남겨두면(예: 조회 자체도 실패) 다음 재시도 confirm에서 다시 시도할
    // 수 있게 status를 'pending'인 채로 둔다(성급하게 failed로 낙인
    // 찍지 않는다 — 나중에 진짜 DONE으로 밝혀질 여지를 남긴다).
    if (hardFailure && hardFailure.reason !== 'network-error-unconfirmed') {
      db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE order_id = ?').run('failed', nowIso(), orderId);
      return { ok: false, status: 502, reason: hardFailure.reason, detail: hardFailure.detail };
    }
    return { ok: false, status: 502, reason: 'confirm-status-unknown-retry-later', detail: hardFailure && hardFailure.detail };
  } finally {
    releaseLock('payment_locks', 'order_id', orderId, jobId);
  }
}

/* 취소 — accountId(세션에서 뽑은 값)로 주문 소유자를 반드시 대조한다
   (2026-09-10 재검토 4차 핵심 수정: 예전엔 로그인 여부만 확인하고 이
   대조가 없어 다른 계정의 주문도 취소할 수 있었다). cancelAmount가
   주문 금액보다 작으면 부분 취소로 보고 이용권을 건드리지 않는다(정책
   미확정 — BUSINESS_DECISIONS.md에 보고). 전액 취소일 때만
   revokeEntitlementIfCurrentOrder로 "지금도 이 주문이 유효 이용권의
   근거일 때만" 회수한다. */
export async function cancelPayment({ accountId, paymentKey, cancelReason, cancelAmount }) {
  if (config.services.payment !== 'real') return { ok: false, status: 503, reason: 'payment-service-unavailable' };
  const db = openDb();
  const order = db.prepare('SELECT * FROM orders WHERE payment_key = ?').get(paymentKey);
  if (!order) return { ok: false, status: 404, reason: 'order-not-found' };
  if (!accountId || order.account_id !== accountId) return { ok: false, status: 403, reason: 'order-account-mismatch' };
  if (order.status !== 'paid' && order.status !== 'partially_cancelled') {
    return { ok: false, status: 400, reason: 'order-not-cancellable', currentStatus: order.status };
  }

  const jobId = acquireLock('payment_locks', 'order_id', order.order_id, config.paymentLockTimeoutSeconds);
  if (!jobId) return { ok: false, status: 409, reason: 'cancel-in-progress' };

  try {
    let res;
    try {
      res = await tossFetch(`/v1/payments/${encodeURIComponent(paymentKey)}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ cancelReason: cancelReason || '사용자 요청', ...(cancelAmount ? { cancelAmount } : {}) }),
      });
    } catch (e) {
      // 취소도 승인과 같은 이유로 조회 API로 실제 상태를 확인한다.
      const query = await queryPayment(paymentKey);
      const cancelledOnProvider = query.ok && query.json && (query.json.status === 'CANCELED' || query.json.status === 'PARTIAL_CANCELED');
      if (!cancelledOnProvider) return { ok: false, status: 502, reason: 'cancel-status-unknown-retry-later' };
      res = { ok: true, json: query.json };
    }
    if (!res.ok) return { ok: false, status: res.status, reason: 'toss-cancel-failed', detail: res.json };

    // 2026-09-10 재검토(5차) — ChatGPT 지적: "부분 취소 여부는 우리가
    // 요청한 cancelAmount가 아니라 공급자의 실제 상태·잔액·누적 취소
    // 금액으로 판단하라." 예전엔 클라이언트가 보낸 cancelAmount 값만
    // 보고 부분/전액을 결정했다 — 실제로 토스가 무슨 이유로든 다르게
    // 처리했으면(예: 이미 부분 취소된 결제라 나머지 잔액이 요청보다
    // 적게 남아 사실상 전액이 됨) 우리 쪽 기록이 틀어질 수 있었다. 이제
    // 응답의 status 필드(CANCELED/PARTIAL_CANCELED)를 1순위 근거로,
    // balanceAmount(잔액)·cancels 배열의 누적 취소액을 보조 근거로 쓴다.
    const p = res.json || {};
    const cancelsSum = Array.isArray(p.cancels) ? p.cancels.reduce((sum, c) => sum + (Number(c.cancelAmount) || 0), 0) : null;
    const balanceAmount = p.balanceAmount != null ? Number(p.balanceAmount) : null;
    const isFull = p.status === 'CANCELED'
      || balanceAmount === 0
      || (cancelsSum != null && cancelsSum >= order.amount);
    const isPartial = !isFull && (
      p.status === 'PARTIAL_CANCELED'
      || (balanceAmount != null && balanceAmount > 0)
      || (cancelsSum != null && cancelsSum > 0 && cancelsSum < order.amount)
      // 공급자 응답이 이 필드들을 하나도 안 줄 만큼 부실하면(테스트
      // 이중처럼), 마지막 수단으로만 우리가 요청한 금액을 근거로 삼는다.
      || (p.status == null && balanceAmount == null && cancelsSum == null && typeof cancelAmount === 'number' && cancelAmount > 0 && cancelAmount < order.amount)
    );
    const actualCancelledAmount = cancelsSum != null ? cancelsSum : (isFull ? order.amount : cancelAmount);

    if (isPartial) {
      // 부분 취소 — 전액 취소와 다르게 다룬다. 이용권 조정 정책이 아직
      // 없으므로 여기서는 자동으로 회수하지 않는다(문서에 별도 보고).
      db.prepare('UPDATE orders SET status = ?, cancelled_amount = ?, updated_at = ? WHERE order_id = ?')
        .run('partially_cancelled', actualCancelledAmount, nowIso(), order.order_id);
      return { ok: true, status: 200, partial: true, entitlementUnchanged: true };
    }

    db.prepare('UPDATE orders SET status = ?, cancelled_amount = ?, updated_at = ? WHERE order_id = ?')
      .run('cancelled', actualCancelledAmount, nowIso(), order.order_id);
    const revoke = revokeEntitlementIfCurrentOrder(order.account_id, order.order_id);
    return { ok: true, status: 200, entitlementRevoked: !revoke.skipped };
  } finally {
    releaseLock('payment_locks', 'order_id', order.order_id, jobId);
  }
}

/* 웹훅 — 페이로드 자체(서명이든 필드값이든)를 신뢰하지 않는다. 페이로드
   에서 paymentKey로 추정되는 값을 뽑아 반드시 조회 API로 실제 상태를
   다시 확인한 뒤에만 반영한다. 실제 토스 웹훅 페이로드 모양을 이
   세션에서 확인 못 했으므로 흔히 쓰이는 후보 필드 경로 몇 가지를
   방어적으로 시도한다 — 실제 페이로드를 받아 보면 이 목록을 정확히
   좁혀야 한다.

   2026-09-10 재검토(4차): 중복·지연 웹훅으로 이용권이 다시 지급되거나
   잘못 취소되지 않게 order 단위 잠금 + 상태 전이 가드를 추가했다.
   과거 주문 취소 웹훅이 다른(더 최근) 유효 주문의 이용권을 건드리지
   않도록 revokeEntitlementIfCurrentOrder를 쓴다. */
export async function handleTossWebhookEvent(body) {
  const paymentKey = body.paymentKey || (body.data && body.data.paymentKey) || null;
  if (!paymentKey) return { ok: false, status: 400, reason: 'missing-payment-key' };

  const result = await queryPayment(paymentKey);
  if (!result.ok || !result.json) return { ok: false, status: 502, reason: 'toss-query-failed' };
  const payment = result.json;
  const orderId = payment.orderId;
  const db = openDb();
  const order = orderId ? db.prepare('SELECT * FROM orders WHERE order_id = ?').get(orderId) : null;
  if (!order) return { ok: false, status: 404, reason: 'order-not-found' };
  if (!paymentMatchesOrder(payment, order, paymentKey)) return { ok: false, status: 400, reason: 'payment-order-mismatch' };

  const jobId = acquireLock('payment_locks', 'order_id', orderId, config.paymentLockTimeoutSeconds);
  if (!jobId) return { ok: true, status: 200, reason: 'concurrent-webhook-ignored' }; // 동시에 처리 중 — 재시도해도 안전(멱등)하므로 200으로 응답해 PG 재시도를 멈추게 한다.

  try {
    // 중복·지연 웹훅 방어: 상태 전이를 "그 상태로 이미 가 있으면 아무것도
    // 안 한다"로 멱등하게 만든다(재요청이 두 번째로 도착해도 부작용 없음).
    if (payment.status === 'DONE' && order.status !== 'paid') {
      db.exec('BEGIN');
      try {
        db.prepare('UPDATE orders SET status = ?, payment_key = ?, paid_at = ?, updated_at = ? WHERE order_id = ?')
          .run('paid', paymentKey, nowIso(), nowIso(), orderId);
        grantEntitlement(order.account_id, order.entitlement_days || config.price.periodDays, orderId);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        return { ok: false, status: 500, reason: 'entitlement-storage-failed' };
      }
    } else if (payment.status === 'CANCELED' && order.status !== 'cancelled') {
      // 2026-09-10 재검토(5차): 전액 취소도 요청 시점 예상값이 아니라
      // 공급자가 실제로 밝힌 누적 취소액을 우선 쓴다(cancelPayment와
      // 같은 원칙) — 없으면 주문 금액으로 대체한다.
      const cancelsSum = Array.isArray(payment.cancels) ? payment.cancels.reduce((sum, c) => sum + (Number(c.cancelAmount) || 0), 0) : null;
      db.prepare('UPDATE orders SET status = ?, cancelled_amount = ?, updated_at = ? WHERE order_id = ?')
        .run('cancelled', cancelsSum || order.amount, nowIso(), orderId);
      revokeEntitlementIfCurrentOrder(order.account_id, orderId);
    } else if (payment.status === 'PARTIAL_CANCELED' && order.status !== 'partially_cancelled' && order.status !== 'cancelled') {
      const cancelsSum = Array.isArray(payment.cancels) ? payment.cancels.reduce((sum, c) => sum + (Number(c.cancelAmount) || 0), 0) : null;
      db.prepare('UPDATE orders SET status = ?, cancelled_amount = ?, updated_at = ? WHERE order_id = ?')
        .run('partially_cancelled', cancelsSum || null, nowIso(), orderId);
      // 부분 취소는 이용권을 건드리지 않는다 — cancelPayment와 동일한 이유.
    }
    return { ok: true, status: 200 };
  } finally {
    releaseLock('payment_locks', 'order_id', orderId, jobId);
  }
}
