/**
 * 2026-09-22(18차) 5·6·7절 — 문서(docs/BUSINESS_DECISIONS.md 0절)에 적는
 * 원가·예산 숫자를 "사람이 손으로 계산"하지 않고 지금 코드 설정값
 * (server/config.mjs)에서 그대로 계산해 출력한다. 설정을 바꾸면 이
 * 스크립트를 다시 돌려 문서 숫자를 갱신한다.
 *
 * 전제(18차 재검토에서 받은 공식 가격표 기준 —
 *   developers.google.com/maps/billing-and-pricing/pricing, .../place-details):
 * - 단가: Text Search Pro $32/1,000, Text Search Enterprise $35/1,000,
 *   Routes Essentials $5/1,000, Routes Pro $10/1,000,
 *   Place Details Enterprise(영업시간) **$20/1,000**, 환율 1,400원/USD(가정).
 * - 무료 구간(월, 결제계정·SKU별): Essentials 10,000 / Pro 5,000 /
 *   Enterprise 1,000건.
 * - 환율·요금 변동 여유는 단가와 따로(businessHours.costBufferRatio) 계산한다.
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
  hours: config.costEstimate.placesDetailsEnterpriseMicros, // 공식 $20 → 28원
  textSearchEnterprise: Math.round((35 / 1000) * fx * 1e6), // 검색에 영업시간을 같이 넣을 때의 검색 단가(비교용)
};
const buffer = config.businessHours.costBufferRatio;
unit.hoursBuffered = Math.ceil(unit.hours * (1 + buffer));
const worstCourse = planWorstCaseSkus(config.maxPlacesPerGeneration + 1).reduce((s, k) => s + skuCostMicros(k), 0);
const cap = { free: config.costSafetyCap.freeAccountMicros, paid: config.costSafetyCap.paidEntitlementMicros };
const lim = config.entitlementUsage;
const out = [];
const line = (s) => out.push(s);

line('## 단가(원, 1건)');
line(`- 장소 위치 확인(Text Search Pro): ${won(unit.search)}원`);
line(`- 경로(경유지 10곳 이하, Essentials): ${won(unit.routeEss)}원 / (11~25곳, Pro): ${won(unit.routePro)}원`);
line(`- 코스 1회 최악 예약(경유지 최대 ${config.maxPlacesPerGeneration}곳 → ${planWorstCaseSkus(config.maxPlacesPerGeneration + 1).length}구간): ${won(worstCourse)}원`);
line(`- 영업시간(Place Details Enterprise, 공식 $20/1,000): ${won(unit.hours)}원 · 여유 판정 때만 환율·요금 여유 ${Math.round(buffer * 100)}% 별도 → ${(unit.hoursBuffered / 1e6).toFixed(1)}원`);
line(`- (비교용) 검색에 영업시간을 같이 넣으면 검색이 Text Search Enterprise($35/1,000) → ${won(unit.textSearchEnterprise)}원`);

const headroom = (capMicros, remainingLookups, remainingCourses, spent) => capMicros - spent - (remainingLookups * unit.search + remainingCourses * worstCourse);
line('\n## 기존 약속을 먼저 떼고 남는 여유(영업시간에 쓸 수 있는 돈)');
const rows = [
  ['무료 — 시작 직후(10곳·코스1 남음)', headroom(cap.free, lim.freePlaceLookupLimit, lim.freeCourseLimit, 0)],
  ['무료 — 10곳 확인+코스1회(보통 7원) 쓴 뒤', headroom(cap.free, 0, 0, lim.freePlaceLookupLimit * unit.search + unit.routeEss)],
  ['유료 — 시작 직후(50곳·30회 남음)', headroom(cap.paid, lim.paidPlaceLookupLimit, lim.paidCourseLimit, 0)],
  ['유료 — 50곳 확인+코스 4회(보통 각 7원) 쓴 뒤', headroom(cap.paid, 0, lim.paidCourseLimit - 4, lim.paidPlaceLookupLimit * unit.search + 4 * unit.routeEss)],
  ['유료 — 최대 사용(50곳+30회 최악)', headroom(cap.paid, 0, 0, lim.paidPlaceLookupLimit * unit.search + lim.paidCourseLimit * worstCourse)],
];
line('| 상황 | 남는 여유 | 영업시간 가능 곳 수(28원) | 여유 포함 판정(실제 코드) |');
line('|---|---|---|---|');
for (const [label, h] of rows) line(`| ${label} | ${won(h)}원 | ${Math.max(0, Math.floor(h / unit.hours))}곳 | ${Math.max(0, Math.floor(h / unit.hoursBuffered))}곳 |`);

line('\n## 영업시간 시나리오 — 필요한 원가');
const scen = [
  ['무료 코스 1개 3곳', 3], ['무료 코스 1개 5곳', 5],
  ['3박4일 하루 5곳, 출발 전 1번만', 20], ['3박4일 하루 5곳, 출발 전+현지 재확인', 40],
  ['30일에 여행 2번(위 조건 ×2)', 80],
  ['위 40곳 + 실패·재시도 10%', 44],
];
line('| 시나리오 | 조회 수 | 원가(28원) | 여유 포함 |');
line('|---|---|---|---|');
for (const [label, n] of scen) line(`| ${label} | ${n}건 | ${won(n * unit.hours)}원 | ${won(n * unit.hoursBuffered)}원 |`);

// 18차 재검토 5절 — 무료5 / 유료20 / 유료40 안(제안, 적용 안 함)
const coreFree = lim.freePlaceLookupLimit * unit.search + lim.freeCourseLimit * worstCourse;
const corePaid = lim.paidPlaceLookupLimit * unit.search + lim.paidCourseLimit * worstCourse;
line('\n## 영업시간 제공 안 — 필요한 안전상한(제안, 운영 적용 안 함)');
line(`- 기존 약속 최대 예약: 무료 ${lim.freePlaceLookupLimit}×${(unit.search / 1e6).toFixed(1)} + ${lim.freeCourseLimit}×${won(worstCourse)} = ${won(coreFree)}원 / 유료 ${lim.paidPlaceLookupLimit}×${(unit.search / 1e6).toFixed(1)} + ${lim.paidCourseLimit}×${won(worstCourse)} = ${won(corePaid)}원`);
line('| 안 | 영업시간 | 기존 약속 | 원가 합계(28원) | 여유 포함 | 지금 상한 | 필요한 상한 | 매출 9,900원 대비 | 27,000원으로 동시 판매 |');
line('|---|---|---|---|---|---|---|---|---|');
const plans = [['무료 5곳', 5, coreFree, cap.free, false], ['유료 20곳', 20, corePaid, cap.paid, true], ['유료 40곳', 40, corePaid, cap.paid, true]];
for (const [label, n, core, nowCap, paid] of plans) {
  const total = core + n * unit.hours, totalB = core + n * unit.hoursBuffered;
  const need = Math.ceil(totalB / 1e8) * 1e8; // 100원 단위 올림
  const ok = totalB <= nowCap;
  line(`| ${label} | ${n}건 | ${won(core)}원 | ${won(total)}원 | ${won(totalB)}원 | ${won(nowCap)}원 | ${ok ? '지금 상한으로 됨' : won(need) + '원'} | ${paid ? Math.round((ok ? nowCap : need) / 9900e6 * 100) + '%' : '-'} | ${paid ? Math.floor(config.costBudget.globalMonthlyMicros / (ok ? nowCap : need)) + '개' : '-'} |`);
}

// 검색에 같이 넣기 vs 따로 조회 — 한계원가와 무료 구간을 같이 본다
line('\n## 검색에 영업시간을 같이 넣기(B) vs 따로 조회(A, 지금 방식) — 한 달 청구 비교(무료 구간 적용 가정)');
line('| 유료 사용자 수(모두 검색 50건·영업시간 20건) | A 한계원가 | A 무료구간 반영 청구 | B 한계원가 | B 무료구간 반영 청구 |');
line('|---|---|---|---|---|');
for (const n of [5, 20, 50, 100]) {
  const searches = n * lim.paidPlaceLookupLimit, hours = n * 20;
  const aMarg = searches * unit.search + hours * unit.hours;
  const aBill = Math.max(0, searches - 5000) * unit.search + Math.max(0, hours - 1000) * unit.hours;
  const bMarg = searches * unit.textSearchEnterprise;
  const bBill = Math.max(0, searches - 1000) * unit.textSearchEnterprise;
  line(`| ${n}명(검색 ${searches}, 영업시간 ${hours}) | ${won(aMarg)}원 | ${won(aBill)}원 | ${won(bMarg)}원 | ${won(bBill)}원 |`);
}

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
  const bill = Math.max(0, searches - 5000) * unit.search + Math.max(0, routes - 10000) * unit.routeEss + Math.max(0, hours - 1000) * unit.hours;
  line(`- 유료 ${n}명(모두 한도까지 사용): 검색 ${searches}건(무료 5,000) · 경로 ${routes}건(무료 10,000) · 영업시간 ${hours}건(무료 1,000) → 예상 청구 ${won(bill)}원`);
}
console.log(out.join('\n'));
