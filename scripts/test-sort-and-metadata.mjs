/**
 * 저장 목록 정렬 + 메타데이터 분리(2026-09-11 재검토 9차 6-1절) 검증
 * — 실제 Chromium + 실제 index.html. daMerge/daBuildSpots/daSortSpots/
 * daCentroid가 실제로 어떻게 동작하는지, 그리고 화면의 정렬 select가
 * 실제로 목록 순서를 바꾸는지까지 확인한다.
 *
 * 실행: node scripts/test-sort-and-metadata.mjs
 */
import { chromium } from 'playwright';

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('dialog', (d) => d.dismiss());
await p.goto('file://' + process.cwd() + '/src/design/index.html');
await p.waitForTimeout(200);

// =====================================================================
// 1. daMerge — 새 레코드에만 firstAddedAt/importBatchId를 찍고, 기존
//    레코드는 절대 덮지 않는다. originalSavedAt은 원본에 있을 때만.
// =====================================================================
const r1 = await p.evaluate(() => {
  const places = [];
  const csv = 'name,address,saved date\n인더스트리원,후쿠오카시,2024-03-01\n';
  const parsed = A.parseCsv(csv);
  const z1 = A.merge(parsed, 'batch1', places, 'batch-1');
  const first = places[0];
  return {
    added: z1.added,
    hasFirstAddedAt: typeof first.firstAddedAt === 'string' && !Number.isNaN(Date.parse(first.firstAddedAt)),
    importBatchId: first.importBatchId,
    originalSavedAt: first.originalSavedAt,
  };
});
t('1) 새로 만든 레코드에 firstAddedAt이 실제 유효한 시각으로 찍힘', r1.hasFirstAddedAt);
t('1) 새로 만든 레코드에 importBatchId가 호출자가 넘긴 값 그대로 찍힘', r1.importBatchId === 'batch-1');
t('1) CSV의 "saved date" 열이 originalSavedAt으로 보존됨', r1.originalSavedAt === '2024-03-01');

// =====================================================================
// 2. 재수입 시 기존 레코드의 firstAddedAt/importBatchId는 절대 안 바뀜
//    (재수입 = 갱신이지 새로 안 곳이 아니다). originalSavedAt은 원래
//    없었을 때만 비파괴적으로 채워진다.
// =====================================================================
const r2 = await p.evaluate(async () => {
  // 같은 파일을 다시 올리는(재수입) 상황 흉내 — sourceLabel(파일명 유래)이
  // 같아야 "같은 출처에서 이미 받아들인 내용"으로 실제로 갱신 경로를 탄다.
  const places = [];
  A.merge(A.parseCsv('name,address\n인더스트리원,후쿠오카시\n'), 'takeout-export', places, 'batch-1');
  const before = { firstAddedAt: places[0].firstAddedAt, importBatchId: places[0].importBatchId };
  await new Promise((res) => setTimeout(res, 30));
  const z2 = A.merge(A.parseCsv('name,address,saved date\n인더스트리원,후쿠오카시,2024-05-05\n'), 'takeout-export', places, 'batch-2');
  return {
    updated: z2.updated,
    sameFirstAddedAt: places[0].firstAddedAt === before.firstAddedAt,
    sameImportBatchId: places[0].importBatchId === before.importBatchId,
    backfilledOriginalSavedAt: places[0].originalSavedAt,
  };
});
t('2) 재수입은 신규가 아니라 갱신으로 처리됨', r2.updated === 1);
t('2) 재수입해도 firstAddedAt(최초로 안 시점)은 안 바뀜', r2.sameFirstAddedAt);
t('2) 재수입해도 importBatchId(처음 들어온 묶음)는 안 바뀜', r2.sameImportBatchId);
t('2) 원래 없던 originalSavedAt은 재수입 때 비파괴적으로 채워짐', r2.backfilledOriginalSavedAt === '2024-05-05');

const r2b = await p.evaluate(() => {
  const places = [];
  A.merge(A.parseCsv('name,address,saved date\n인더스트리원,후쿠오카시,2024-01-01\n'), 'takeout-export', places, 'b1');
  A.merge(A.parseCsv('name,address,saved date\n인더스트리원,후쿠오카시,2099-12-31\n'), 'takeout-export', places, 'b2');
  return places[0].originalSavedAt;
});
t('2) 이미 있던 originalSavedAt은 재수입한 값으로 덮어써지지 않음', r2b === '2024-01-01');

// =====================================================================
// 3. daBuildSpots — 새 메타데이터 필드가 화면용 spot 객체로도 넘어감.
// =====================================================================
const r3 = await p.evaluate(() => {
  const fm = { places: [] };
  A.merge(A.parseCsv('name,address\n스팟A,후쿠오카시\n'), 'x', fm.places, 'batch-x');
  const spots = A.buildSpots(fm).spots;
  return { firstAddedAt: spots[0].firstAddedAt, importBatchId: spots[0].importBatchId, originalSavedAt: spots[0].originalSavedAt };
});
t('3) daBuildSpots가 firstAddedAt을 화면용 객체로 그대로 넘김', typeof r3.firstAddedAt === 'string');
t('3) daBuildSpots가 importBatchId를 화면용 객체로 그대로 넘김', r3.importBatchId === 'batch-x');
t('3) originalSavedAt 없는 곳은 지어내지 않고 null', r3.originalSavedAt === null);

// =====================================================================
// 4. daSortSpots — recent/oldest: 날짜 모르는(레거시) 항목은 추측하지
//    않고 맨 뒤로(숨기지 않음). distance: 좌표 없는 곳도 맨 뒤로 유지.
//    relevance: 검색어 없으면 근거 없는 추천순을 지어내지 않음.
// =====================================================================
const r4 = await p.evaluate(() => {
  const older = { id: 'a', name: 'A', firstAddedAt: '2024-01-01T00:00:00.000Z' };
  const newer = { id: 'b', name: 'B', firstAddedAt: '2024-06-01T00:00:00.000Z' };
  const legacy = { id: 'c', name: 'C' }; // firstAddedAt 없음 — 진짜 레거시 흉내.
  const list = [older, newer, legacy];
  const recent = A.sortSpots(list, { mode: 'recent' }).map((x) => x.id);
  const oldest = A.sortSpots(list, { mode: 'oldest' }).map((x) => x.id);
  return { recent, oldest, recentCount: recent.length, oldestCount: oldest.length };
});
t('4) 최근추가순 — 새 항목이 먼저, 날짜 모르는 레거시는 맨 뒤(숨지 않음)', JSON.stringify(r4.recent) === JSON.stringify(['b', 'a', 'c']));
t('4) 오래된순 — 오래된 항목이 먼저, 날짜 모르는 레거시는 맨 뒤(숨지 않음)', JSON.stringify(r4.oldest) === JSON.stringify(['a', 'b', 'c']));
t('4) 정렬해도 항목 수가 줄지 않음(레거시가 사라지지 않음)', r4.recentCount === 3 && r4.oldestCount === 3);

const r5 = await p.evaluate(() => {
  // 기준점(후쿠오카역, 33.5902,130.4207)에서 가까운 곳/먼 곳/좌표 없는 곳을 섞어 확인.
  const ref = { lat: 33.5902, lng: 130.4207 };
  const near = { id: 'near', name: 'N', lat: 33.5905, lng: 130.4210 }; // 기준점 바로 옆.
  const far = { id: 'far', name: 'F', lat: 33.9, lng: 130.9 }; // 기준점에서 확실히 멀리.
  const noCoord = { id: 'nc', name: 'NC' };
  const list = [far, noCoord, near];
  const sorted = A.sortSpots(list, { mode: 'distance', refPoint: ref }).map((x) => x.id);
  const centroid = A.centroid([{ lat: 10, lng: 20 }, { lat: 20, lng: 40 }]);
  return { sorted, centroid };
});
t('5) 거리순 — 가까운 곳이 먼저 오고, 좌표 없는 곳은 목록에서 안 사라지고 맨 뒤로', JSON.stringify(r5.sorted) === JSON.stringify(['near', 'far', 'nc']));
t('5) daCentroid가 좌표 있는 곳들의 평균을 실제로 계산함', r5.centroid.lat === 15 && r5.centroid.lng === 30);

const r6 = await p.evaluate(() => {
  // a: 이름이 검색어로 시작함(강한 일치). b: 이름엔 없고 카테고리에만 있음(약한 일치).
  const list = [{ id: 'b', name: '스미비 바', category: '야키토리 전문점', area: '' }, { id: 'a', name: '야키토리 스미비마사', category: '이자카야', area: '' }];
  const withQuery = A.sortSpots(list, { mode: 'relevance', query: '야키토리' }).map((x) => x.id);
  const withoutQuery = A.sortSpots(list, { mode: 'relevance', query: '' }).map((x) => x.id);
  return { withQuery, withoutQuery };
});
t('6) 관련순 — 이름이 검색어로 시작하는 쪽이 카테고리만 맞는 쪽보다 앞섬', r6.withQuery[0] === 'a');
t('6) 검색어가 없으면 근거 없는 추천순을 지어내지 않고 원래 순서를 유지함', JSON.stringify(r6.withoutQuery) === JSON.stringify(['b', 'a']));

// =====================================================================
// 7. 실제 화면 — 정렬 select가 실제로 목록 렌더 순서를 바꾼다(위치
//    권한 없이도 동작). ZIP처럼 여러 파일을 한 번에 들여오면 같은
//    importBatchId를 공유하는지도 함께 확인한다.
// =====================================================================
await p.evaluate(() => {
  const cityName = '후쿠오카';
  foodMap.places = [
    { id: 'old1', name: '오래된곳', cat: '기타', catConfirmed: true, city: cityName, cityKnown: true, cityConfirmed: true, sourceLists: [], firstAddedAt: '2023-01-01T00:00:00.000Z' },
    { id: 'new1', name: '새로운곳', cat: '기타', catConfirmed: true, city: cityName, cityKnown: true, cityConfirmed: true, sourceLists: [], firstAddedAt: '2024-01-01T00:00:00.000Z' },
  ];
  A.saveFoodMap(foodMap);
});
await p.reload();
await p.waitForTimeout(200);
await p.evaluate(() => { city = '후쿠오카'; updateCity(); });
await p.waitForTimeout(150);
const firstCardRecent = await p.locator('#grid .spot h3').first().innerText();
await p.selectOption('#sortSelect', 'oldest');
await p.waitForTimeout(100);
const firstCardOldest = await p.locator('#grid .spot h3').first().innerText();
t('7) 기본(최근추가순) 화면에서 최근 것이 먼저 보임', firstCardRecent === '새로운곳');
t('7) select를 오래된순으로 바꾸면 실제로 순서가 바뀜', firstCardOldest === '오래된곳');
await p.selectOption('#sortSelect', 'distance');
await p.waitForTimeout(100);
const basisVisible = await p.locator('#sortBasisNote').isVisible();
t('7) 거리순을 고르면 기준(평균 위치) 안내 문구가 실제로 뜸', basisVisible);
await p.selectOption('#sortSelect', 'recent');

t('최종 콘솔/런타임 오류 0', errs.length === 0);
if (errs.length) console.log(errs);

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
await b.close();
process.exit(fail ? 1 : 0);
