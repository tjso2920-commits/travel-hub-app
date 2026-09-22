/**
 * 2026-09-22(18차) 5·6·7절 — 문서(docs/BUSINESS_DECISIONS.md 0절)에 적는
 * 원가·예산 숫자를 "사람이 손으로 계산"하지 않고 지금 코드 설정값
 * (server/config.mjs)에서 그대로 계산해 출력한다. 설정을 바꾸면 이
 * 스크립트를 다시 돌려 문서 숫자를 갱신한다.
 *
 * 전제(전부 미확인 — 문서에 그대로 표시):
 * - 단가: Text Search Pro $32/1,000, Routes Essentials $5/1,000,
 *   Routes Pro $10/1,000, Place Details Enterprise $20 또는 $35/1,000
 *   (검색 결과끼리 엇갈림 — 둘 다 계산), 환율 1,400원/USD(가정).
 * - 무료 구간(월, 결제계정·SKU별): Essentials 10,000 / Pro 5,000 /
 *   Enterprise 1,000건 — 검색 결과 교차 확인, 공식 문서 직접 확인 못 함.
 *
 * 실행: node scripts/cost-scenarios.mjs
 */
process.env.DB_PATH = process.env.DB_PATH || ':memory:';
const { config } = await import('../server/config.mjs');
const { planWorstCaseSkus } = await import('../server/route-segments.mjs');
const { skuCostMicros } = await import('../server/cost-ledger.mjs');

const won = (micros) => Math.round(micros / 1e6);
const fx = config.costFxKrwPerUsd;
const unit = {
  search: config.costEstimate.placesTextSearchMicros,
  routeEss: config.costEstimate.routesComputeMicros,
  routePro: config.costEstimate.routesComputeHighVolumeMicros,
  hours20: Math.round((20 / 1000) * fx * 1e6),
  hours35: Math.round((35 / 1000) * fx * 1e6),
};
const worstCourse = planWorstCaseSkus(config.maxPlacesPerGeneration + 1).reduce((s, k) => s + skuCostMicros(k), 0);
const cap = { free: config.costSafetyCap.freeAccountMicros, paid: config.costSafetyCap.paidEntitlementMicros };
const lim = config.entitlementUsage;
const out = [];
const line = (s) => out.push(s);

line('## 단가(원, 1건)');
line(`- 장소 위치 확인(Text Search Pro): ${won(unit.search)}원`);
line(`- 경로(경유지 10곳 이하, Essentials): ${won(unit.routeEss)}원 / (11~25곳, Pro): ${won(unit.routePro)}원`);
line(`- 코스 1회 최악 예약(경유지 최대 ${config.maxPlacesPerGeneration}곳 → ${planWorstCaseSkus(config.maxPlacesPerGeneration + 1).length}구간): ${won(worstCourse)}원`);
line(`- 영업시간(Place Details Enterprise): $20이면 ${won(unit.hours20)}원 / $35이면 ${won(unit.hours35)}원 (코드 기본값은 보수적으로 ${won(config.costEstimate.placesDetailsEnterpriseMicros)}원)`);

const headroom = (capMicros, remainingLookups, remainingCourses, spent) => capMicros - spent - (remainingLookups * unit.search + remainingCourses * worstCourse);
line('\n## 기존 약속을 먼저 떼고 남는 여유(영업시간에 쓸 수 있는 돈)');
const rows = [
  ['무료 — 시작 직후(10곳·코스1 남음)', headroom(cap.free, lim.freePlaceLookupLimit, lim.freeCourseLimit, 0)],
  ['무료 — 10곳 확인+코스1회(보통 7원) 쓴 뒤', headroom(cap.free, 0, 0, lim.freePlaceLookupLimit * unit.search + unit.routeEss)],
  ['유료 — 시작 직후(50곳·30회 남음)', headroom(cap.paid, lim.paidPlaceLookupLimit, lim.paidCourseLimit, 0)],
  ['유료 — 50곳 확인+코스 4회(보통 각 7원) 쓴 뒤', headroom(cap.paid, 0, lim.paidCourseLimit - 4, lim.paidPlaceLookupLimit * unit.search + 4 * unit.routeEss)],
  ['유료 — 최대 사용(50곳+30회 최악)', headroom(cap.paid, 0, 0, lim.paidPlaceLookupLimit * unit.search + lim.paidCourseLimit * worstCourse)],
];
line('| 상황 | 남는 여유 | 영업시간 가능 곳 수($20) | ($35) |');
line('|---|---|---|---|');
for (const [label, h] of rows) line(`| ${label} | ${won(h)}원 | ${Math.max(0, Math.floor(h / unit.hours20))}곳 | ${Math.max(0, Math.floor(h / unit.hours35))}곳 |`);

line('\n## 영업시간 시나리오 — 필요한 원가');
const scen = [
  ['무료 코스 1개 3곳', 3], ['무료 코스 1개 5곳', 5],
  ['3박4일 하루 5곳, 출발 전 1번만', 20], ['3박4일 하루 5곳, 출발 전+현지 재확인', 40],
  ['30일에 여행 2번(위 조건 ×2)', 80],
  ['위 40곳 + 실패·재시도 10%', 44],
];
line('| 시나리오 | 조회 수 | $20 기준 | $35 기준 |');
line('|---|---|---|---|');
for (const [label, n] of scen) line(`| ${label} | ${n}건 | ${won(n * unit.hours20)}원 | ${won(n * unit.hours35)}원 |`);

line('\n## 신규 판매 예산(①내부 보수 추정 — 무료 구간 없다고 가정)');
const monthly = config.costBudget.globalMonthlyMicros;
line(`- 이번 달 전체 한도: ${won(monthly)}원 · 이용권 1개당 예약: ${won(cap.paid)}원 → 사용 0인 상태에서 동시에 팔 수 있는 이용권 ${Math.floor(monthly / cap.paid)}개(${Math.floor(monthly / cap.paid) + 1}번째부터 판매 중지)`);
const freeTypical = lim.freePlaceLookupLimit * unit.search + unit.routeEss;
line(`- 무료 체험 1명 보통 사용: ${won(freeTypical)}원 / 최대: ${won(cap.free)}원`);
line('| 모집 20명 중 유료 전환 | 무료 사용(보통~최대) | 유료 약속분(3,500원×N) | 필요한 월 한도(보통~최대) | 27,000원으로 되나 |');
line('|---|---|---|---|---|');
for (const n of [5, 10, 20]) {
  const freeT = 20 * freeTypical, freeW = 20 * cap.free, paid = n * cap.paid;
  const needT = freeT + paid, needW = freeW + paid;
  line(`| ${n}명 | ${won(freeT)}~${won(freeW)}원 | ${won(paid)}원 | ${won(needT)}~${won(needW)}원 | ${needW <= monthly ? '예' : needT <= monthly ? '보통이면 예, 최대면 아니오' : '아니오'} |`);
}
line(`- 하루 한도: 전체 ${won(config.costBudget.globalDailyMicros)}원 — 유료 1명이 첫날 50곳을 한꺼번에 확인하면 ${won(50 * unit.search)}원이라, 같은 날 2명이 몰리면 두 번째 사람은 "잠시 후 다시" 안내를 받는다.`);

line('\n## ② 실제 Google 청구 예상(무료 구간이 이 결제계정에 그대로 적용된다는 조건부)');
for (const n of [5, 10, 20]) {
  const searches = 20 * lim.freePlaceLookupLimit + n * lim.paidPlaceLookupLimit;
  const routes = 20 * lim.freeCourseLimit + n * lim.paidCourseLimit;
  const hours = n * 40;
  const bill = Math.max(0, searches - 5000) * unit.search + Math.max(0, routes - 10000) * unit.routeEss + Math.max(0, hours - 1000) * unit.hours35;
  line(`- 유료 ${n}명(모두 한도까지 사용): 검색 ${searches}건(무료 5,000) · 경로 ${routes}건(무료 10,000) · 영업시간 ${hours}건(무료 1,000) → 예상 청구 ${won(bill)}원`);
}
console.log(out.join('\n'));
