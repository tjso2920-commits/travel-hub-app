'use strict';
/**
 * 2026-09-22(18차) 6절 — 신규 판매 예약의 동시 주문 누락 검증.
 *
 * 재현하려는 결함: 신규 판매 가능 판정(isServiceUnavailableForNewSales)은
 * "이미 결제를 마친 활성 유료 계정"의 남은 몫만 약속으로 뺐다. 결제창을
 * 연(주문 생성) 뒤 아직 결제를 안 끝낸 사람은 약속에 안 들어가서, 예산이
 * 딱 1명분 남았을 때 두 사람이 연달아 주문을 만들면 둘 다 통과하고 둘 다
 * 결제할 수 있었다(이용권 1개분 초과 약속).
 *
 *  1) 1명분만 남았을 때 두 번째 사람의 주문은 막힌다(대기 주문도 예약).
 *  2) 같은 사람이 결제창을 다시 열면(자기 대기 주문) 자기 몫을 두 번 세지 않는다.
 *  3) 오래된(예약 시간 지난) 대기 주문은 예약에서 빠진다.
 *  4) 막힐 때 사람이 읽을 수 있는 안내(userMessage)와 "기존 이용자 영향
 *     없음" 표시가 함께 온다.
 *  5) 이미 결제된 주문의 이용권 복구(승인 재확인)는 판매 차단과 무관하다
 *     — confirmPayment는 createOrder 판정을 거치지 않는다(코드 경로 확인).
 *
 * 실행: node server/test/new-sale-pending-reservation.test.mjs
 */
process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'development';
process.env.COST_SAFETY_CAP_PAID_KRW_MICROS = String(3_500_000_000);
// 이번 달 전체 한도 6,999원 = 이용권 1개분(3,500원) + 3,499원 → 딱 1명분만 새로 받을 수 있다.
process.env.COST_GLOBAL_MONTHLY_KRW_MICROS = String(6_999_000_000);
process.env.COST_GLOBAL_DAILY_KRW_MICROS = String(6_999_000_000);

const fs = await import('node:fs');
const { openDb, uuid, nowIso } = await import('../db.mjs');
const { createOrder } = await import('../adapters/payment-toss.mjs');

let fail = 0; const t = (n, c, extra) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (extra && !c ? ' — ' + extra : '')); if (!c) fail++; };
function account(email) {
  const id = uuid();
  openDb().prepare('INSERT INTO accounts (id, email, created_at, plan) VALUES (?, ?, ?, ?)').run(id, email, nowIso(), 'free');
  return id;
}

const a = account('pending-a@example.test');
const b = account('pending-b@example.test');
const r1 = createOrder(a);
t('1) 첫 번째 사람 주문은 통과', r1.ok === true, JSON.stringify(r1));
const r2 = createOrder(b);
t('1) 1명분만 남았을 때 두 번째 사람 주문은 막힘(대기 주문도 예약)', r2.ok === false && r2.reason === 'service-unavailable-for-new-sales', JSON.stringify(r2));
const r1b = createOrder(a);
t('2) 같은 사람이 결제창을 다시 열면 자기 몫을 두 번 세지 않음', r1b.ok === true, JSON.stringify(r1b));

// 3) 예약 시간 지난 대기 주문은 빠진다
openDb().prepare("UPDATE orders SET created_at = ? WHERE account_id = ?").run(new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), a);
const r3 = createOrder(b);
t('3) 오래된 대기 주문은 예약에서 빠져 다음 사람이 살 수 있음', r3.ok === true, JSON.stringify(r3));

// 4) 안내 문구
const c = account('pending-c@example.test');
const r4 = createOrder(c);
t('4) 막힐 때 사람이 읽는 안내 포함', r4.ok === false && typeof r4.userMessage === 'string' && r4.userMessage.includes('결제는 되지 않았어요'), JSON.stringify(r4));
t('4) 기존 이용자 영향 없음 표시', r4.existingCustomersUnaffected === true);

// 5) 승인 재확인 경로는 판매 판정과 무관(코드 경로)
const src = fs.readFileSync(new URL('../adapters/payment-toss.mjs', import.meta.url), 'utf8');
const confirmBody = src.slice(src.indexOf('export async function confirmPayment'), src.indexOf('export async function confirmPayment') + 6000);
t('5) confirmPayment는 신규 판매 판정을 부르지 않음', !confirmBody.includes('isServiceUnavailableForNewSales'));

if (fail) { console.log(`\n${fail} FAIL`); process.exit(1); }
console.log('\nALL PASS');
