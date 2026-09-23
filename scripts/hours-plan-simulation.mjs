/**
 * 2026-09-23(18차 재검토 2차) 4절 — "유료 영업시간 40회" 안을 문서에 적기 전에,
 * 사람 손계산이 아니라 **지금 서버 코드**(비용 원장·이용권 상한·영업시간 라우트의
 * 여유 판정·횟수 상한)를 그대로 돌려 결과를 확인한다. 영업시간은 테스트 어댑터
 * (합성 데이터)만 쓴다 — 실제 Google 호출 없음, 비용 0원.
 *
 * 각 시나리오는 별도 프로세스(메모리 DB)로 돌려 전체 하루 누적이 섞이지 않게 한다.
 * 실행: node scripts/hours-plan-simulation.mjs
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCENARIOS = {
  // 여러 날에 나눠 쓰는 경우(하루 횟수·전체 하루 비용 한도는 끔) — 기간 상한만 본다.
  'A-지금상한3500-영업40': { cap: 3500, spread: true, hours: 40, fails: 0 },
  'B-상한4600-영업40': { cap: 4600, spread: true, hours: 40, fails: 0 },
  'C-상한4600-영업40중실패4-재시도4': { cap: 4600, spread: true, hours: 40, fails: 4, retry: 4 },
  'D-상한4800-기간상한44-실패4-재시도4': { cap: 4800, spread: true, hours: 40, fails: 4, retry: 4, periodCap: 44 },
  // 하루에 몰아 쓰는 경우 — 출고 기본 하루 한도(계정당 영업시간 30회, 전체 하루 3,000원) 그대로.
  'E-상한4600-하루에-위치50+코스30(최악)+영업40': { cap: 4600, spread: false, hours: 40, fails: 0, coreFirst: true },
  'F-상한4600-하루에-위치50+코스2+영업40': { cap: 4600, spread: false, hours: 40, fails: 0, coreFirst: true, courses: 2 },
};

if (process.env.SIM_CHILD) {
  const sc = JSON.parse(process.env.SIM_CHILD);
  process.env.DB_PATH = ':memory:';
  process.env.APP_ENV = 'development';
  process.env.COST_SAFETY_CAP_PAID_KRW_MICROS = String(sc.cap * 1_000_000);
  process.env.BUSINESS_HOURS_PAID_PERIOD_PLACE_CAP = String(sc.periodCap || 40);
  if (sc.spread) {
    process.env.BUSINESS_HOURS_PER_ACCOUNT_DAILY_LIMIT = '0';
    process.env.COST_GLOBAL_DAILY_KRW_MICROS = '0';
  }
  const { openDb, uuid, nowIso } = await import('../server/db.mjs');
  const { grantEntitlement } = await import('../server/routes/entitlement.mjs');
  const { businessHoursRoute } = await import('../server/routes/business-hours.mjs');
  const { chargeCostBatch, periodCostMicros } = await import('../server/cost-ledger.mjs');
  const { currentPeriod } = await import('../server/entitlement-usage.mjs');
  const { planWorstCaseSkus } = await import('../server/route-segments.mjs');
  const { config } = await import('../server/config.mjs');
  const db = openDb();
  const acc = uuid();
  db.prepare('INSERT INTO accounts (id, email, created_at, plan) VALUES (?, ?, ?, ?)').run(acc, 'sim@example.test', nowIso(), 'free');
  const orderId = 'order_' + uuid();
  db.prepare('INSERT INTO orders (order_id, account_id, amount, status, entitlement_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(orderId, acc, 9900, 'paid', 30, nowIso(), nowIso());
  grantEntitlement(acc, 30, orderId);
  const ids = [];
  for (let i = 1; i <= sc.hours - sc.fails; i++) ids.push('test-hours-lunch-' + i);
  for (let i = 1; i <= sc.fails; i++) ids.push('test-hours-fail-' + i);
  for (const id of ids) db.prepare('INSERT OR IGNORE INTO entitlement_place_confirmed (account_id, real_place_id, first_period_id, confirmed_at) VALUES (?, ?, ?, ?)').run(acc, id, 'sim', nowIso());
  const period = currentPeriod(acc);
  const core = () => {
    // 위치확인 50곳 + 코스 30회(최악 예약 구간 수) — 실제 라우트 대신 같은 원장 함수로 기록
    // 비용 원장과 함께 이용권 사용 횟수(entitlement_usage)도 실제 라우트처럼 올린다 —
    // 그래야 "남은 약속 예약분"이 실제 코드와 똑같이 줄어든다.
    const bump = (col) => db.prepare(`INSERT INTO entitlement_usage (account_id, period_id, place_lookups_used, course_successes_used, updated_at) VALUES (?, ?, 0, 0, ?) ON CONFLICT(account_id, period_id) DO UPDATE SET ${col} = ${col} + 1, updated_at = excluded.updated_at`).run(acc, period.periodId, nowIso());
    let lookups = 0, lookupsReason = '';
    for (let i = 0; i < config.entitlementUsage.paidPlaceLookupLimit; i++) {
      const r = chargeCostBatch({ accountId: acc, service: 'place-lookup', charges: [{ sku: 'places-text-search', count: 1 }], periodId: period.periodId, periodCapMicros: period.costCapMicros });
      if (r.ok) { lookups++; bump('place_lookups_used'); } else lookupsReason = r.reason;
    }
    let courses = 0, coursesReason = '';
    for (let i = 0; i < (sc.courses != null ? sc.courses : config.entitlementUsage.paidCourseLimit); i++) {
      const r = chargeCostBatch({ accountId: acc, service: 'course', charges: planWorstCaseSkus(config.maxPlacesPerGeneration + 1).map((sku) => ({ sku })), periodId: period.periodId, periodCapMicros: period.costCapMicros });
      if (r.ok) { courses++; bump('course_successes_used'); } else coursesReason = r.reason;
    }
    return { lookupsOk: lookups, lookupsReason, courses, coursesReason };
  };
  const hoursRun = async (list) => {
    const out = { ok: 0, failed: 0, notRequested: 0, reasons: {} };
    for (let i = 0; i < list.length; i += 10) {
      const r = await businessHoursRoute(acc, { placeIds: list.slice(i, i + 10) });
      for (const x of r.results || []) {
        if (x.status === 'ok') out.ok++;
        else if (x.status === 'failed') out.failed++;
        else { out.notRequested++; out.reasons[x.reason] = (out.reasons[x.reason] || 0) + 1; }
      }
    }
    return out;
  };
  let coreRes, hours, retry;
  if (sc.coreFirst) { coreRes = core(); hours = await hoursRun(ids); }
  else { hours = await hoursRun(ids); coreRes = core(); }
  if (sc.retry) retry = await hoursRun(ids.filter((x) => x.includes('fail')).map((x) => x.replace('fail', 'lunch-retry')).map((x) => { db.prepare('INSERT OR IGNORE INTO entitlement_place_confirmed (account_id, real_place_id, first_period_id, confirmed_at) VALUES (?, ?, ?, ?)').run(acc, x, 'sim', nowIso()); return x; }));
  const hoursLedger = db.prepare("SELECT COALESCE(SUM(count),0) AS n, COALESCE(SUM(estimated_cost_micros),0) AS m FROM cost_ledger WHERE account_id = ? AND service = 'business-hours'").get(acc);
  console.log(JSON.stringify({ hours, retry, core: coreRes, hoursCalls: hoursLedger.n, hoursCost: Math.round(hoursLedger.m / 1e6), totalCost: Math.round(periodCostMicros(acc, period.periodId) / 1e6), cap: sc.cap }));
  process.exit(0);
}

const self = fileURLToPath(import.meta.url);
for (const [name, sc] of Object.entries(SCENARIOS)) {
  const r = spawnSync(process.execPath, [self], { env: { ...process.env, SIM_CHILD: JSON.stringify(sc) }, encoding: 'utf8' });
  const line = (r.stdout || '').trim().split('\n').pop();
  console.log(name + ' → ' + (line || r.stderr.slice(0, 400)));
}
