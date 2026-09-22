'use strict';
/**
 * 2026-09-22(18차) 7절 — "기존 구매자의 기간·제공량·주문 시점 가격을
 * 보존하라." 재현하려는 결함: 주문에는 금액·기간만 남고, 제공량(위치 확인
 * 50곳·코스 30회)과 원가 안전상한(3,500원)은 매번 "지금 설정값"을 읽었다.
 * 나중에 상품 조건(환경변수)을 바꾸면 이미 산 사람의 남은 제공량도 같이
 * 바뀌었다.
 *
 *  1) 주문을 만들 때 그 시점의 제공량·원가 상한이 주문에 저장된다.
 *  2) 설정이 바뀐 뒤에도 기존 구매자의 이번 이용권 한도는 주문 당시 값.
 *  3) 설정이 바뀐 뒤 새로 산 사람은 새 조건.
 *  4) 조건이 저장되기 전(예전) 주문은 지금 설정값으로 동작(기존 동작 유지).
 *
 * 실행: node server/test/order-terms-snapshot.test.mjs
 */
process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'development';

const { config } = await import('../config.mjs');
const { openDb, uuid, nowIso } = await import('../db.mjs');
const { createOrder } = await import('../adapters/payment-toss.mjs');
const { grantEntitlement } = await import('../routes/entitlement.mjs');
const { currentPeriod, usageSummaryForAccount } = await import('../entitlement-usage.mjs');

let fail = 0; const t = (n, c, extra) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (extra && !c ? ' — ' + extra : '')); if (!c) fail++; };
function account(email) {
  const id = uuid();
  openDb().prepare('INSERT INTO accounts (id, email, created_at, plan) VALUES (?, ?, ?, ?)').run(id, email, nowIso(), 'free');
  return id;
}
function buy(acc) {
  const o = createOrder(acc);
  openDb().prepare("UPDATE orders SET status = 'paid', paid_at = ? WHERE order_id = ?").run(nowIso(), o.orderId);
  grantEntitlement(acc, 30, o.orderId);
  return o.orderId;
}

const a = account('terms-a@example.test');
const orderA = buy(a);
const row = openDb().prepare('SELECT * FROM orders WHERE order_id = ?').get(orderA);
t('1) 주문에 당시 제공량·원가 상한 저장', row.place_lookup_limit === 50 && row.course_limit === 30 && row.cost_cap_micros === 3_500_000_000, JSON.stringify(row));

// 상품 조건 변경(예: 가격 인상과 함께 제공량 변경)
config.entitlementUsage.paidPlaceLookupLimit = 80;
config.entitlementUsage.paidCourseLimit = 40;
config.costSafetyCap.paidEntitlementMicros = 5_000_000_000;

const pa = currentPeriod(a);
t('2) 설정이 바뀌어도 기존 구매자 한도는 주문 당시 값(50곳·30회·3,500원)', pa.placeLookupLimit === 50 && pa.courseLimit === 30 && pa.costCapMicros === 3_500_000_000, JSON.stringify(pa));
const ua = usageSummaryForAccount(a);
t('2) 계정 화면 표시도 주문 당시 값', ua.placeLookups.limit === 50 && ua.courseGenerations.limit === 30);

const b = account('terms-b@example.test');
buy(b);
const pb = currentPeriod(b);
t('3) 조건 변경 뒤 새 구매자는 새 조건(80곳·40회·5,000원)', pb.placeLookupLimit === 80 && pb.courseLimit === 40 && pb.costCapMicros === 5_000_000_000, JSON.stringify(pb));

// 예전 주문(조건 컬럼 없음) — 지금 설정값으로 동작
const c = account('terms-c@example.test');
const legacyOrder = 'order_' + uuid();
openDb().prepare('INSERT INTO orders (order_id, account_id, amount, status, entitlement_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(legacyOrder, c, 9900, 'paid', 30, nowIso(), nowIso());
grantEntitlement(c, 30, legacyOrder);
const pc = currentPeriod(c);
t('4) 조건이 저장되기 전 주문은 지금 설정값으로 동작', pc.placeLookupLimit === 80 && pc.courseLimit === 40);

if (fail) { console.log(`\n${fail} FAIL`); process.exit(1); }
console.log('\nALL PASS');
