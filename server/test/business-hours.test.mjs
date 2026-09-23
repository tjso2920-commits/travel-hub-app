'use strict';
/**
 * 2026-09-22(18차) 3·4·5절 — 영업시간 조회(POST /api/places/hours) 검증.
 *  1) 운영 기본값은 꺼짐(명시 스위치+키 둘 다 있어야 real) — 가짜 응답 없음.
 *  2) 위치가 확인되지 않은 placeId는 호출·과금하지 않는다(다른 지점·임의 ID 차단).
 *  3) 확인된 장소는 Place Details Enterprise SKU로 원장에 따로 기록된다.
 *  4) 응답(영업시간 내용)이 DB 어디에도 남지 않는다.
 *  5) 같은 장소 동시 요청은 호출·과금 1번(병합).
 *  6) 기존 약속(남은 위치확인·코스) 예산은 영업시간이 못 먹는다 — 여유를
 *     넘는 요청은 잘리고, 동시 요청끼리도 예약분을 못 넘는다. 그 뒤에도
 *     남은 위치확인 10곳 + 코스 1회 원가가 실제로 기록 가능하다.
 *  7) 실패는 자동 재시도하지 않고 실패로 돌려주며 비용은 0원 처리하지
 *     않는다. 바로 다시 누르면 'retry'로 따로 센다.
 *  8) 입력 검증(개수·형식).
 *
 * 실행: node server/test/business-hours.test.mjs
 */
process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'development';
process.env.ENTITLEMENT_FREE_PLACE_LOOKUP_LIMIT = '10';
process.env.ENTITLEMENT_FREE_COURSE_LIMIT = '1';
process.env.COST_SAFETY_CAP_FREE_KRW_MICROS = String(700_000_000);

const { config, buildConfig } = await import('../config.mjs');
const { openDb, uuid, nowIso } = await import('../db.mjs');
const { businessHoursRoute, _inFlightSizeForTest, admissionUnitMicros } = await import('../routes/business-hours.mjs');
const { currentPeriod, optionalFeatureHeadroomMicros } = await import('../entitlement-usage.mjs');
const { periodCostMicros, skuCostMicros, chargeCostBatch, serviceBreakdownSince } = await import('../cost-ledger.mjs');
const { planWorstCaseSkus } = await import('../route-segments.mjs');

let fail = 0; const t = (n, c, extra) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (extra ? ' — ' + extra : '')); if (!c) fail++; };

function account(email) {
  const db = openDb();
  const id = uuid();
  db.prepare('INSERT INTO accounts (id, email, created_at, plan) VALUES (?, ?, ?, ?)').run(id, email, nowIso(), 'free');
  return id;
}
function confirmPlaces(acc, ids) {
  const db = openDb();
  for (const id of ids) db.prepare('INSERT OR IGNORE INTO entitlement_place_confirmed (account_id, real_place_id, first_period_id, confirmed_at) VALUES (?, ?, ?, ?)').run(acc, id, 'free', nowIso());
}
function ledgerRows(acc) {
  return openDb().prepare("SELECT service, sku, count, estimated_cost_micros FROM cost_ledger WHERE account_id = ? AND service = 'business-hours'").all(acc);
}
const unit = skuCostMicros('places-details-enterprise');

// 1) 운영 기본값
{
  const prodNoFlag = buildConfig({ APP_ENV: 'production', GOOGLE_PLACES_API_KEY: 'k' });
  const prodFlagNoKey = buildConfig({ APP_ENV: 'production', BUSINESS_HOURS_ENABLE_REAL: 'true' });
  const prodBoth = buildConfig({ APP_ENV: 'production', BUSINESS_HOURS_ENABLE_REAL: 'true', GOOGLE_PLACES_API_KEY: 'k' });
  t('1) 운영 + 키만 있음 → disabled', prodNoFlag.services.businessHours === 'disabled');
  t('1) 운영 + 스위치만 있음 → disabled', prodFlagNoKey.services.businessHours === 'disabled');
  t('1) 운영 + 스위치+키 → real', prodBoth.services.businessHours === 'real');
  t('1) 개발 기본 → 합성 test', config.services.businessHours === 'test');
  t('1) 단가 기본값은 공식 단가($20/1,000 → 1,400원 가정 28원)', unit === 28_000_000, String(unit));
  t('1) 환율·요금 여유는 단가와 별도 값(여유 판정 단가 28×1.15=32.2원)', config.businessHours.costBufferRatio === 0.15 && admissionUnitMicros() === 32_200_000, String(admissionUnitMicros()));
}

// 2) 미확인 placeId
{
  const acc = account('bh2@example.test');
  const r = await businessHoursRoute(acc, { placeIds: ['ChIJ-not-mine', 'test-hours-lunch'] });
  t('2) 미확인 장소는 unverified-place', r.ok && r.results.every((x) => x.status === 'unverified-place'));
  t('2) 미확인 장소는 원장 기록 0건', ledgerRows(acc).length === 0);
}

// 3) 확인된 장소 → 원장 분리 기록 + 4) 저장 없음
{
  const acc = account('bh3@example.test');
  confirmPlaces(acc, ['test-hours-lunch', 'test-hours-break']);
  const r = await businessHoursRoute(acc, { placeIds: ['test-hours-lunch', 'test-hours-break'] });
  const okAll = r.ok && r.results.every((x) => x.status === 'ok' && x.source === 'test-adapter' && x.fetchedAt);
  t('3) 확인된 장소는 영업시간 결과(합성 표시 포함)', okAll);
  const rows = ledgerRows(acc);
  t('3) 원장: service=business-hours, sku=places-details-enterprise, 2건', rows.length === 1 && rows[0].sku === 'places-details-enterprise' && rows[0].count === 2 && rows[0].estimated_cost_micros === 2 * unit, JSON.stringify(rows));
  const brk = r.results.find((x) => x.placeId === 'test-hours-break');
  t('3) 브레이크타임(하루 2구간) 그대로 전달', brk && brk.regular.periods.filter((p) => p.open.day === 3).length === 2);
  t('3) 응답에 저장 안 함 표시', r.storage === 'not-stored');

  // 4) DB 어디에도 응답 내용이 없어야 한다.
  const db = openDb();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((x) => x.name);
  let leaked = [];
  for (const name of tables) {
    const rowsAll = db.prepare(`SELECT * FROM "${name}"`).all();
    const text = JSON.stringify(rowsAll);
    if (text.includes('합성 테스트 장소') || text.includes('weekdayDescriptions') || text.includes('"periods"') || text.includes('regularOpeningHours')) leaked.push(name);
  }
  t('4) 영업시간 응답 내용이 어느 DB 표에도 남지 않음', leaked.length === 0, leaked.join(','));
}

// 5) 동시 요청 병합
{
  const acc = account('bh5@example.test');
  confirmPlaces(acc, ['test-hours-evening']);
  const [a, b] = await Promise.all([
    businessHoursRoute(acc, { placeIds: ['test-hours-evening'] }),
    businessHoursRoute(acc, { placeIds: ['test-hours-evening'] }),
  ]);
  t('5) 두 요청 모두 결과를 받음', a.results[0].status === 'ok' && b.results[0].status === 'ok');
  const total = ledgerRows(acc).reduce((s, x) => s + x.count, 0);
  t('5) 같은 장소 동시 요청은 1건만 과금', total === 1, String(total));
  t('5) 진행 중 호출 표는 비워짐(결과를 쌓아 두지 않음)', _inFlightSizeForTest() === 0);
}

// 6) 기존 약속 예산 보호
{
  const acc = account('bh6@example.test');
  const ids = ['test-hours-lunch-1', 'test-hours-lunch-2', 'test-hours-lunch-3', 'test-hours-lunch-4', 'test-hours-lunch-5', 'test-hours-lunch-6'];
  confirmPlaces(acc, ids);
  const period = currentPeriod(acc);
  const h = optionalFeatureHeadroomMicros(acc, period);
  // 18차 재검토 5절 — 단가 $20(28원)+여유 15%(32.2원)로 바로잡은 뒤에는 여유(217원 → 6곳)보다
  // 무료 기간 상한(5곳)이 먼저 걸린다. 둘 중 작은 값이 실제로 허용되는 수다.
  const budgetAffordable = Math.floor(h.headroomMicros / admissionUnitMicros());
  const expectAffordable = Math.min(budgetAffordable, config.businessHours.freePeriodPlaceCap);
  // 동시 요청 두 개(3곳 + 3곳)가 같은 여유를 두고 경쟁
  const [r1, r2] = await Promise.all([
    businessHoursRoute(acc, { placeIds: ids.slice(0, 3) }),
    businessHoursRoute(acc, { placeIds: ids.slice(3, 6) }),
  ]);
  const okCount = [...r1.results, ...r2.results].filter((x) => x.status === 'ok').length;
  const cut = [...r1.results, ...r2.results].filter((x) => x.status === 'not-requested');
  t('6) 무료 기본값 여유 = 700원 − (10곳×44.8 + 코스 예약) → 여유로는 ' + budgetAffordable + '곳, 무료 상한 5곳 → 실제 ' + expectAffordable + '곳', budgetAffordable >= 5 && expectAffordable === 5, `headroom=${h.headroomMicros / 1e6}원 reserved=${h.reservedForCoreMicros / 1e6}원`);
  t('6) 동시 요청 합계가 여유를 넘지 않음', okCount === expectAffordable, `ok=${okCount}`);
  t('6) 넘친 요청은 예약분 보호 사유로 잘림', cut.length === 6 - expectAffordable && cut.every((x) => x.reason === 'business-hours-budget-reserved-for-core' || x.reason === 'business-hours-period-cap-reached'), JSON.stringify(cut.map((x) => x.reason)));
  // 남은 약속(위치확인 10곳 + 코스 1회 최악 경우)이 실제로 기록 가능한지
  const coreCharges = [{ sku: 'places-text-search', count: 10 }, ...planWorstCaseSkus(config.maxPlacesPerGeneration + 1).map((sku) => ({ sku }))];
  const core = chargeCostBatch({ accountId: acc, service: 'core-check', charges: coreCharges, periodId: period.periodId, periodCapMicros: period.costCapMicros });
  t('6) 영업시간을 다 쓴 뒤에도 약속한 위치확인 10곳+코스 1회 원가가 상한 안에 들어감', core.ok, core.reason || '');
  t('6) 계정 누적 원가 ≤ 700원', periodCostMicros(acc, period.periodId) <= period.costCapMicros);
}

// 7) 실패 — 자동 재시도 없음, 비용 기록 유지, 재시도 건수 분리
{
  const acc = account('bh7@example.test');
  confirmPlaces(acc, ['test-hours-fail']);
  const r = await businessHoursRoute(acc, { placeIds: ['test-hours-fail'] });
  t('7) 실패는 failed로 돌려줌', r.results[0].status === 'failed');
  t('7) 실패 호출도 원가 기록(0원 처리 안 함)', ledgerRows(acc).reduce((s, x) => s + x.count, 0) === 1);
  await businessHoursRoute(acc, { placeIds: ['test-hours-fail'] });
  const stats = serviceBreakdownSince(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');
  const get = (o) => (stats.outcomes.find((x) => x.service === 'business-hours' && x.outcome === o) || {}).count || 0;
  t('7) 결과 건수 분리 집계(fail/retry)', get('fail') >= 2 && get('retry') >= 1, JSON.stringify(stats.outcomes.filter((x) => x.service === 'business-hours')));
  t('7) 원가 집계가 검색·경로와 분리됨', stats.costs.some((c) => c.service === 'business-hours' && c.sku === 'places-details-enterprise'));
}

// 8) 입력 검증
{
  const acc = account('bh8@example.test');
  const many = Array.from({ length: config.businessHours.maxPlacesPerCall + 1 }, (_, i) => 'test-hours-lunch-' + i);
  t('8) 개수 초과 400', (await businessHoursRoute(acc, { placeIds: many })).status === 400);
  t('8) 형식 오류 400', (await businessHoursRoute(acc, { placeIds: ['../etc'] })).status === 400);
  t('8) 빈 목록 400', (await businessHoursRoute(acc, { placeIds: [] })).status === 400);
}

// 9) (최종검수 재현) 만료된 장소 검색 결과가 DB에 무기한 남던 문제
{
  const { lookupPlaceRoute } = await import('../routes/places.mjs');
  const acc = account('bh9@example.test');
  await lookupPlaceRoute(acc, '하카타역', '후쿠오카', 'local-a');
  const db = openDb();
  const before = db.prepare('SELECT COUNT(*) AS n FROM lookup_cache').get().n;
  db.prepare('UPDATE lookup_cache SET created_at = ?').run(new Date(Date.now() - 11 * 60 * 1000).toISOString());
  await lookupPlaceRoute(acc, '텐진역', '후쿠오카', 'local-b');
  const rows = db.prepare('SELECT query_key FROM lookup_cache').all().map((x) => x.query_key);
  t('9) 10분 지난 검색 결과는 DB에서 삭제됨', before >= 1 && !rows.some((k) => k.startsWith('하카타역')), JSON.stringify(rows));
}

if (fail) { console.log(`\n${fail} FAIL`); process.exit(1); }
console.log('\nALL PASS');
