/**
 * 세계 공통 상위분류 유지 + 세부 다중 태그(2026-09-11 재검토 9차 6-2절)
 * 검증 — 실제 Chromium + 실제 index.html.
 *
 * 실행: node scripts/test-tags-and-category.mjs
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
// 1. 기존 상위분류(category) 단일 필터는 그대로 유지되고, 새로 들어온
//    장소는 이름만으로 다중 태그가 자동 추정된다(불확실하면 빈 배열).
// =====================================================================
const r1 = await p.evaluate(() => {
  const places = [];
  A.merge(A.parseCsv('name,address\n스미비 야키토리 이자카야,후쿠오카시\n'), 'x', places, 'b1');
  A.merge(A.parseCsv('name,address\n이름만있는가게,후쿠오카시\n'), 'x', places, 'b1');
  return {
    category: places[0].cat,
    tags: places[0].tags,
    tagsConfirmed: places[0].tagsConfirmed,
    unclearTags: places[1].tags,
  };
});
t('1) 상위분류(category)는 기존 방식 그대로 추정됨(맛집·식당 계열)', r1.category === '바·이자카야' || r1.category === '맛집·식당');
t('1) 이름에 야키토리+이자카야가 함께 있으면 두 태그가 동시에 붙음(다중 태그)', r1.tags.includes('야키토리') && r1.tags.includes('이자카야'));
t('1) 자동 추정된 태그는 아직 확정(tagsConfirmed) 상태가 아님', r1.tagsConfirmed === false);
t('1) 근거 없는 이름은 태그를 억지로 안 붙이고 빈 배열로 정직하게 남김', Array.isArray(r1.unclearTags) && r1.unclearTags.length === 0);

// =====================================================================
// 2. 동의어 통합 — "주판점/리커샵/주류샵"이 하나의 캐노니컬 태그로 합쳐짐.
// =====================================================================
const r2 = await p.evaluate(() => {
  const places = [];
  A.merge(A.parseCsv('name\n동네 주판점\n'), 'a', places, 'b1');
  A.merge(A.parseCsv('name\n역앞 리커샵\n'), 'b', places, 'b1');
  A.merge(A.parseCsv('name\n단골 주류샵\n'), 'c', places, 'b1');
  return places.map((x) => x.tags);
});
t('2) 서로 다른 표기(주판점/리커샵/주류샵)가 전부 같은 캐노니컬 태그로 통합됨', r2.every((tags) => tags.includes('주류샵')));

// =====================================================================
// 3. 사용자가 직접 확정한 태그는 재수입해도 절대 안 덮인다(catConfirmed와
//    동일한 보호 규칙).
// =====================================================================
const r3 = await p.evaluate(() => {
  const places = [];
  A.merge(A.parseCsv('name,address\n애매한이름집,후쿠오카시\n'), 'takeout', places, 'b1');
  A.setTags(places, places[0].id, ['스시', '이자카야']);
  // 같은 파일을 다시 올려도(재수입) 사람이 고른 태그는 그대로.
  A.merge(A.parseCsv('name,address\n애매한이름집,후쿠오카시\n'), 'takeout', places, 'b2');
  return { tags: places[0].tags, tagsConfirmed: places[0].tagsConfirmed };
});
t('3) 사용자가 확정한 태그는 재수입해도 그대로 유지됨', JSON.stringify(r3.tags.slice().sort()) === JSON.stringify(['스시', '이자카야'].sort()));
t('3) 확정 표시(tagsConfirmed)도 계속 true로 유지됨', r3.tagsConfirmed === true);

// =====================================================================
// 4. daBuildSpots가 tags/tagsConfirmed를 화면용 객체로 그대로 넘긴다.
// =====================================================================
const r4 = await p.evaluate(() => {
  const fm = { places: [] };
  A.merge(A.parseCsv('name,address\n스미비 야키토리,후쿠오카시\n'), 'x', fm.places, 'b1');
  return A.buildSpots(fm).spots[0].tags;
});
t('4) daBuildSpots가 tags를 화면용 객체로 넘김', Array.isArray(r4) && r4.includes('야키토리'));

// =====================================================================
// 5. 예전에 tags 필드 자체가 없던 레거시 장소(예: 마이그레이션 이전
//    ~160곳)를 불러오면 1회성으로 채워진다(지어내지 않고 이름 기반
//    추정만, 확정 상태로 만들지 않음 — 사람이 나중에 또 고칠 수 있게).
// =====================================================================
const r5 = await p.evaluate(() => {
  const legacyFoodMap = { places: [{ id: 'legacy1', name: '오래된 스시집', cat: '맛집·식당', catConfirmed: true, city: '후쿠오카', version: 3, updatedAt: '2020-01-01T00:00:00.000Z' }] };
  localStorage.setItem('cp1_foodmap_v1', JSON.stringify(legacyFoodMap));
  const loaded = A.loadFoodMap();
  return { tags: loaded.places[0].tags, tagsConfirmed: loaded.places[0].tagsConfirmed };
});
t('5) tags 필드가 없던 레거시 장소도 불러오는 순간 이름 기반으로 채워짐', Array.isArray(r5.tags) && r5.tags.includes('스시'));
t('5) 마이그레이션으로 채운 태그는 사용자가 확정한 게 아니므로 tagsConfirmed가 참이 아님', !r5.tagsConfirmed);

// =====================================================================
// 6. 실제 화면 — 태그 칩은 "지금 보유한 장소 중 실제 존재하는 것"만
//    보여주고(버튼 과잉 방지), 클릭하면 목록이 실제로 좁혀진다. 상위
//    분류(category) 단일 필터는 계속 그대로 동작한다.
// =====================================================================
await p.evaluate(() => {
  localStorage.clear();
  const cityName = '후쿠오카';
  foodMap.places = [
    { id: 'yaki1', name: '스미비 야키토리', cat: '바·이자카야', catConfirmed: true, city: cityName, cityKnown: true, cityConfirmed: true, sourceLists: [], tags: ['야키토리', '이자카야'], tagsConfirmed: true, firstAddedAt: '2024-01-01T00:00:00.000Z' },
    { id: 'sushi1', name: '스시 마사', cat: '맛집·식당', catConfirmed: true, city: cityName, cityKnown: true, cityConfirmed: true, sourceLists: [], tags: ['스시'], tagsConfirmed: true, firstAddedAt: '2024-01-02T00:00:00.000Z' },
    { id: 'plain1', name: '이름만있는곳', cat: '기타', catConfirmed: false, city: cityName, cityKnown: true, cityConfirmed: true, sourceLists: [], tags: [], tagsConfirmed: false, firstAddedAt: '2024-01-03T00:00:00.000Z' },
  ];
  A.saveFoodMap(foodMap);
});
await p.reload();
await p.waitForTimeout(200);
await p.evaluate(() => { city = '후쿠오카'; updateCity(); });
await p.waitForTimeout(150);
const tagChipTexts = await p.locator('#tagFilters button').allInnerTexts();
t('6) 태그 칩이 실제로 보유한 태그(야키토리/이자카야/스시)만 보여줌', tagChipTexts.sort().join(',') === ['야키토리', '이자카야', '스시'].sort().join(','));
const countBefore = await p.locator('#count').innerText();
await p.click('#tagFilters button:has-text("야키토리")');
await p.waitForTimeout(100);
const countAfterYakitori = await p.locator('#count').innerText();
const cardsAfterYakitori = await p.locator('#grid .spot h3').allInnerTexts();
t('6) 야키토리 태그를 누르면 목록이 실제로 좁혀짐', countBefore === '3' && countAfterYakitori === '1' && cardsAfterYakitori[0] === '스미비 야키토리');
await p.click('#tagFilters button:has-text("야키토리")'); // 해제.
await p.waitForTimeout(100);
const countAfterToggleOff = await p.locator('#count').innerText();
t('6) 다시 누르면 태그 필터가 해제되고 전체가 돌아옴', countAfterToggleOff === '3');
// 상위분류(category) 단일 필터는 여전히 그대로 동작해야 한다.
await p.click('.filters button:has-text("바·이자카야")');
await p.waitForTimeout(100);
const cardsAfterCat = await p.locator('#grid .spot h3').allInnerTexts();
t('6) 기존 상위분류 단일 필터도 그대로 동작함(제거되지 않음)', cardsAfterCat.length === 1 && cardsAfterCat[0] === '스미비 야키토리');

// =====================================================================
// 7. 상세 화면에서 세부 태그를 직접 고쳐 저장하면 실제로 반영된다.
// =====================================================================
await p.click('.filters button:has-text("전체")');
await p.waitForTimeout(100);
await p.click('#grid .spot:has-text("이름만있는곳") .spot-open');
await p.waitForTimeout(100);
await p.click('[data-tags-edit]');
await p.waitForTimeout(100);
// 2026-09-11 재검토(10차) 4절 — "자주 쓰는 태그"만 먼저 보이고 나머지는
// "더 보기"로 접혀 있다(카페는 아직 아무 장소에도 안 붙어 있어 더
// 보기 쪽에 있다).
await p.click('#tagsMoreBtn');
await p.click('#tagEditChipsMore button:has-text("카페")');
await p.click('#tagsSaveBtn');
await p.waitForTimeout(150);
const savedTags = await p.evaluate(() => foodMap.places.find((x) => x.id === 'plain1').tags);
const savedConfirmed = await p.evaluate(() => foodMap.places.find((x) => x.id === 'plain1').tagsConfirmed);
t('7) 상세 화면에서 고른 태그가 실제로 저장됨', Array.isArray(savedTags) && savedTags.includes('카페'));
t('7) 사람이 직접 고르면 tagsConfirmed=true로 확정됨', savedConfirmed === true);

t('최종 콘솔/런타임 오류 0', errs.length === 0);
if (errs.length) console.log(errs);

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
await b.close();
process.exit(fail ? 1 : 0);
