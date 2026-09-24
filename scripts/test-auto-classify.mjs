/**
 * 2026-09-24 자동 분류 개선 — 요청된 최소 확인 시나리오를 실제 화면(index.html,
 * 헤드리스 Chromium)과 테스트 모드 서버로 확인한다. 외부 공급자(Google 등)는
 * 전혀 부르지 않는다 — 공급자 업종은 "장소 확인에서 받은 값"을 흉내 낸 배열을
 * 확인 처리 함수(finishLookupConfirm, 화면 버튼이 부르는 것과 같은 함수)에 넘긴다.
 *
 * 실행: node scripts/test-auto-classify.mjs
 */
import { chromium } from 'playwright';

process.env.DB_PATH = ':memory:';
process.env.FORCE_TEST_MODE = 'true';
process.env.LOGIN_CODE_COOLDOWN_SECONDS = '0';
process.env.LOGIN_MAX_VERIFY_ATTEMPTS = '200';
const { createServer } = await import('../server/index.mjs');
const { sentEmailsForTest } = await import('../server/adapters/email.mjs');
const { openDb } = await import('../server/db.mjs');

let fail = 0; const t = (n, c, extra) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && extra ? ' — ' + extra : '')); if (!c) fail++; };

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const apiBase = `http://127.0.0.1:${server.address().port}`;
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errs = [];
const paidCalls = []; // 유료 외부 호출로 이어질 수 있는 우리 서버 경로
async function newPage(label) {
  const ctx = await b.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errs.push(`pageerror(${label}): ` + e.message));
  page.on('dialog', (d) => { page.__lastDialog = d.message(); d.accept(); });
  page.on('request', (r) => { const u = r.url(); if (/\/api\/(places\/(lookup|hours|classify)|course\/generate|routes)/.test(u)) paidCalls.push(label + ' ' + u); });
  await page.addInitScript((base) => { window.API_BASE = base; }, apiBase);
  await page.goto('file://' + process.cwd() + '/src/design/index.html');
  await page.waitForTimeout(200);
  return page;
}
async function login(page, email) {
  await page.evaluate(() => showLoginSheet(() => {}));
  await page.waitForTimeout(150);
  await page.fill('#loginEmail', email);
  await page.click('#loginSendBtn');
  await page.waitForTimeout(200);
  const code = sentEmailsForTest.filter((e) => e.to === email).pop().body.match(/(\d{6})/)[1];
  await page.fill('#loginCode', code);
  await page.click('#loginVerifyBtn');
  await page.waitForFunction(() => !!(foodMap.session && foodMap.session.token), { timeout: 5000 });
  await page.waitForTimeout(400);
  await page.evaluate(() => { const c = document.getElementById('close'); if (c) c.click(); });
}
// 가져오기: 목록 두 개("쇼핑", "여행 계획")에 식당·옷집·카페·관광지·근거 없는 곳을 섞어 저장.
const CSV_SHOP = 'name,address\nVintage 古着 Tokyo,東京都渋谷区\nCafe Kitsune Omotesando,東京都港区\nUNIQLO Ginza,東京都中央区\n';
const CSV_PLAN = 'name,address\n스시 다이코쿠,東京都中央区\n국립서양미술관,東京都台東区\nMorning Glory,東京都台東区\n';
async function importCsv(page, csv, listName) {
  return page.evaluate(({ csv, listName }) => {
    foodMap.places = foodMap.places || [];
    const r = A.merge(A.parseCsv(csv), listName, foodMap.places, 'batch-' + listName);
    const ok = A.saveFoodMap(foodMap);
    refreshFromStorage(); city = cities[0].name; updateCity(); render();
    return { added: r.added, ok };
  }, { csv, listName });
}
const byName = (page) => page.evaluate(() => Object.fromEntries((foodMap.places || []).map((p) => [p.name, { cat: p.cat, label: A.categoryLabel(p.cat), tags: p.tags, catConfirmed: !!p.catConfirmed, tagsConfirmed: !!p.tagsConfirmed, source: A.categorySource(p), sourceLists: p.sourceLists }])));

const pA = await newPage('A');
await importCsv(pA, CSV_SHOP, '쇼핑');
await importCsv(pA, CSV_PLAN, '여행 계획');
let m = await byName(pA);
t('1) 주소의 동네 이름(港区의 港)으로 업종을 추정하지 않음', m['Cafe Kitsune Omotesando'].label !== '교통');

// 1) 한 목록에 섞인 식당·의류점·카페·관광지 — 근거대로
t('1) 옷집(古着) → 쇼핑 · 의류(이름 텍스트 근거)', m['Vintage 古着 Tokyo'].label === '쇼핑' && m['Vintage 古着 Tokyo'].tags.includes('의류'), JSON.stringify(m['Vintage 古着 Tokyo']));
t('1) "쇼핑" 목록에 있어도 카페는 카페·디저트(목록명은 업종 근거 아님)', m['Cafe Kitsune Omotesando'].label === '카페·디저트' && m['Cafe Kitsune Omotesando'].tags.includes('카페'), JSON.stringify(m['Cafe Kitsune Omotesando']));
t('1) 식당 → 식당 · 스시', m['스시 다이코쿠'].label === '식당' && m['스시 다이코쿠'].tags.includes('스시'), JSON.stringify(m['스시 다이코쿠']));
t('1) 미술관 → 관광·문화 · 미술관', m['국립서양미술관'].label === '관광·문화' && m['국립서양미술관'].tags.includes('미술관'), JSON.stringify(m['국립서양미술관']));
// 5) 근거 없는 장소는 억지로 분류하지 않음
t('5) 브랜드명만 있는 곳(UNIQLO)은 브랜드로 업종 단정 안 함 → 미분류', m['UNIQLO Ginza'].label === '미분류' && m['UNIQLO Ginza'].tags.length === 0 && m['UNIQLO Ginza'].source === 'none', JSON.stringify(m['UNIQLO Ginza']));
t('5) "여행 계획" 목록의 이름만 있는 곳 → 미분류(목록명으로 추정 안 함)', m['Morning Glory'].label === '미분류' && m['Morning Glory'].source === 'none', JSON.stringify(m['Morning Glory']));
t('1) 자동 분류는 확정값이 아님(catConfirmed=false)', !m['스시 다이코쿠'].catConfirmed && !m['Vintage 古着 Tokyo'].catConfirmed);

// 장소 확인에서 받은 업종으로 보완(화면의 "맞아요" 버튼이 부르는 함수) — 새 조회 없음
await pA.evaluate(() => {
  const id = (n) => foodMap.places.find((p) => p.name === n).id;
  // 구체 업종 + 포괄 업종이 함께: primaryType이 포괄(store)이어도 clothing_store가 이긴다
  finishLookupConfirm(id('UNIQLO Ginza'), 35.67, 139.76, 'ChIJ-test-u', ['store', 'clothing_store', 'point_of_interest', 'establishment'], 'store');
  // 포괄 업종만(업종을 말해 주지 않음) → 근거 부족 그대로
  finishLookupConfirm(id('Morning Glory'), 35.71, 139.77, 'ChIJ-test-m', ['point_of_interest', 'establishment'], '');
});
m = await byName(pA);
t('4) primaryType=store + clothing_store → 쇼핑 · 의류(구체 업종 우선)', m['UNIQLO Ginza'].label === '쇼핑' && m['UNIQLO Ginza'].tags.includes('의류') && m['UNIQLO Ginza'].source === 'provider', JSON.stringify(m['UNIQLO Ginza']));
t('4) establishment·point_of_interest뿐이면 미분류 유지', m['Morning Glory'].label === '미분류', JSON.stringify(m['Morning Glory']));

// 2) 일본 외 국가 — 같은 업종 매핑
const intl = await pA.evaluate(() => {
  const mk = (name, address) => ({ id: 'x-' + name, name, address, note: '', cat: undefined, tags: [], catConfirmed: false, tagsConfirmed: false });
  const paris = mk('Maison ABC', 'Paris, France');
  A.applyConfirmedTypes(paris, ['clothing_store', 'store', 'point_of_interest'], 'clothing_store');
  const bkk = mk('Baan Somtum', 'Bangkok, Thailand');
  A.applyConfirmedTypes(bkk, ['thai_restaurant', 'restaurant', 'food'], 'thai_restaurant');
  const ny = mk('Joe Place', 'New York, USA');
  A.applyConfirmedTypes(ny, ['food', 'cafe', 'store'], 'food');
  const rome = mk('Galleria Nazionale', 'Roma, Italia');
  A.applyConfirmedTypes(rome, ['art_gallery', 'museum', 'tourist_attraction'], 'art_gallery');
  const seoul = mk('어느 미용실', '서울');
  A.applyConfirmedTypes(seoul, ['hair_care', 'beauty_salon'], 'beauty_salon');
  return [paris, bkk, ny, rome, seoul].map((p) => ({ n: p.name, label: A.categoryLabel(p.cat), tags: p.tags }));
});
t('2) 파리 옷가게(clothing_store) → 쇼핑 · 의류', intl[0].label === '쇼핑' && intl[0].tags.includes('의류'), JSON.stringify(intl[0]));
t('2) 방콕 thai_restaurant → 식당 · 타이음식', intl[1].label === '식당' && intl[1].tags.includes('타이음식'), JSON.stringify(intl[1]));
t('4) 뉴욕 primaryType=food(포괄) + cafe(구체) → 카페·디저트', intl[2].label === '카페·디저트' && intl[2].tags.includes('카페'), JSON.stringify(intl[2]));
t('2) 로마 art_gallery → 관광·문화 · 미술관·박물관', intl[3].label === '관광·문화' && intl[3].tags.includes('미술관'), JSON.stringify(intl[3]));
t('2) 서울 beauty_salon → 휴식·미용 · 미용실·네일', intl[4].label === '휴식·미용' && intl[4].tags.includes('미용실·네일'), JSON.stringify(intl[4]));

// 3) 쇼핑 → 의류: 옷집만, 원본은 그대로
await pA.evaluate(() => {
  // 식당에 잘못 붙은(자동) 의류 태그가 있어도 식당 필터에 섞이지 않는지 보기 위해 하나 심는다
  const s = foodMap.places.find((p) => p.name === '스시 다이코쿠'); s.tags = [...s.tags, '의류'];
  A.saveFoodMap(foodMap); refreshFromStorage(); updateCity(); render();
});
await pA.evaluate(() => sheet.close());
const totalBefore = await pA.evaluate(() => foodMap.places.length);
const catChips = await pA.$$eval('.filters [data-filter]', (els) => els.map((e) => e.textContent));
t('3) 큰 분류 칩은 표시명으로(식당·쇼핑·카페·디저트·관광·문화·미분류)', ['식당', '쇼핑', '카페·디저트', '관광·문화', '미분류'].every((x) => catChips.includes(x)), catChips.join(','));
await pA.click('.filters [data-filter="shopping"]');
await pA.waitForTimeout(100);
const shopTags = await pA.$$eval('#tagFilters [data-tagfilter]', (els) => els.map((e) => e.textContent));
t('3) 쇼핑을 고르면 쇼핑 세부(의류)만 칩으로', shopTags.includes('의류') && !shopTags.includes('스시') && !shopTags.includes('카페'), shopTags.join(','));
await pA.click('#tagFilters [data-tagfilter="의류"]');
await pA.waitForTimeout(100);
const shopClothes = await pA.$$eval('#grid .spot h3', (els) => els.map((e) => e.textContent).sort());
t('3) 쇼핑 → 의류: 옷집만 보임', JSON.stringify(shopClothes) === JSON.stringify(['UNIQLO Ginza', 'Vintage 古着 Tokyo'].sort()), shopClothes.join(','));
t('3) 필터는 표시만 바꾸고 원본 장소는 그대로(개수·목록 소속 유지)', (await pA.evaluate(() => foodMap.places.length)) === totalBefore && (await byName(pA))['Cafe Kitsune Omotesando'].sourceLists.includes('쇼핑'));
await pA.click('.filters [data-filter="restaurant"]');
await pA.waitForTimeout(100);
const foodTags = await pA.$$eval('#tagFilters [data-tagfilter]', (els) => els.map((e) => e.textContent));
t('3) 식당을 보는 중엔 의류 태그가 섞이지 않음', !foodTags.includes('의류') && foodTags.includes('스시'), foodTags.join(','));
await pA.click('.filters [data-filter="전체"]');

// 상세: 분류 근거 표시 + 몇 번 만에 고치기
await pA.evaluate(() => detail(foodMap.places.find((p) => p.name === 'Morning Glory').id));
await pA.waitForTimeout(100);
const detailCat = await pA.textContent('#sheetContent .category');
t('상세) 근거 부족이면 "미분류(근거 부족)"로 표시 — 정확도 %는 없음', /미분류\(근거 부족\)/.test(detailCat) && !/%/.test(detailCat), detailCat);
await pA.click('[data-cat-edit]');
await pA.waitForTimeout(100);
await pA.click('[data-assign-cat="카페·디저트"]');
await pA.waitForTimeout(150);
m = await byName(pA);
t('상세) 분류 수정 2번 누름으로 확정(카페·디저트, 사용자 확정)', m['Morning Glory'].label === '카페·디저트' && m['Morning Glory'].catConfirmed && m['Morning Glory'].source === 'user', JSON.stringify(m['Morning Glory']));
await pA.evaluate(() => detail(foodMap.places.find((p) => p.name === 'Morning Glory').id));
await pA.waitForTimeout(80);
await pA.click('[data-tags-edit]');
await pA.waitForTimeout(80);
const firstChips = await pA.$$eval('#tagEditChipsFrequent [data-tag-toggle]', (els) => els.slice(0, 2).map((e) => e.textContent));
t('상세) 세부 태그 편집은 이 분류의 세부(카페·베이커리)부터', firstChips.includes('카페') && firstChips.includes('베이커리·디저트'), firstChips.join(','));
await pA.click('#tagEditChipsFrequent [data-tag-toggle="베이커리·디저트"]');
await pA.click('#tagsSaveBtn');
await pA.waitForTimeout(150);
// 사용자가 일부러 태그를 비운 곳
await pA.evaluate(() => { A.setTags(foodMap.places, foodMap.places.find((p) => p.name === '국립서양미술관').id, []); A.saveFoodMap(foodMap); });

// 6) 재가져오기·새로고침으로 사용자 수정이 유지되고, 비운 태그가 되살아나지 않음
await pA.evaluate(() => sheet.close());
await importCsv(pA, CSV_PLAN, '여행 계획');
await importCsv(pA, CSV_SHOP, '쇼핑');
await pA.reload(); await pA.waitForTimeout(300);
m = await byName(pA);
t('6) 재가져오기+새로고침 후에도 사용자 분류·태그 유지', m['Morning Glory'].label === '카페·디저트' && m['Morning Glory'].catConfirmed && JSON.stringify(m['Morning Glory'].tags) === JSON.stringify(['베이커리·디저트']) && m['Morning Glory'].tagsConfirmed, JSON.stringify(m['Morning Glory']));
t('6) 일부러 비운 태그는 자동으로 되살아나지 않음', m['국립서양미술관'].tags.length === 0 && m['국립서양미술관'].tagsConfirmed);
t('6) 장소 확인으로 받은 업종 분류는 재가져오기(텍스트 추정)로 덮이지 않음', m['UNIQLO Ginza'].label === '쇼핑' && m['UNIQLO Ginza'].source === 'provider', JSON.stringify(m['UNIQLO Ginza']));
t('6) 재가져오기로 장소가 늘지 않음(같은 곳 갱신)', (await pA.evaluate(() => foodMap.places.length)) === totalBefore);
t('6) 확인된 업종은 새 필드 없이 기존 confirmedTypes에만(primaryType 맨 앞)', await pA.evaluate(() => { const p = foodMap.places.find((x) => x.name === 'UNIQLO Ginza'); return p.confirmedTypes[0] === 'store' && !('primaryType' in p) && !('catSource' in p); }));

// 기존 사용자 데이터(예전 저장값·예전 태그·개인 태그·목록·코스 연결) 보존 — 불러오기 때 보완만
const legacy = await pA.evaluate(() => {
  const old = { id: 'legacy1', name: '해변 온천 료칸', address: '別府', cat: '사우나·온천', catConfirmed: false, tags: ['꼭 가기', '주류샵'], tagsConfirmed: false, sourceLists: ['옛 목록'], confirmedTypes: ['spa'] };
  foodMap.places.push(old);
  foodMap.courses = [{ city: '도쿄', date: '2026-10-01', stops: [{ id: 'legacy1', name: old.name }] }];
  A.saveFoodMap(foodMap);
  const re = A.loadFoodMap();
  const p = re.places.find((x) => x.id === 'legacy1');
  return { cat: p.cat, label: A.categoryLabel(p.cat), tags: p.tags, lists: p.sourceLists, course: re.courses[0].stops[0].id };
});
t('보존) 예전 저장값(사우나·온천)은 그대로 두고 "휴식·미용"으로 묶어 보임', legacy.cat === '사우나·온천' && legacy.label === '휴식·미용', JSON.stringify(legacy));
t('보존) 개인 태그·예전 자동 태그·목록 소속·코스 연결 유지, 보유 근거(spa)로 스파·온천 보완', legacy.tags.includes('꼭 가기') && legacy.tags.includes('주류샵') && legacy.tags.includes('스파·온천') && legacy.lists[0] === '옛 목록' && legacy.course === 'legacy1', JSON.stringify(legacy));

// 8) 저장 실패 시 성공으로 표시하지 않음
const failRes = await pA.evaluate(() => {
  const id = foodMap.places.find((p) => p.name === 'Vintage 古着 Tokyo').id;
  detail(id); catAssignSheet(id);
  const orig = A.saveFoodMap; A.saveFoodMap = () => false;
  document.querySelector('[data-assign-cat="맛집·식당"]').click();
  A.saveFoodMap = orig;
  const p = A.loadFoodMap().places.find((x) => x.id === id);
  return { storedCat: p.cat, confirmed: !!p.catConfirmed };
});
t('8) 저장 실패하면 실패 안내가 뜨고 저장된 분류는 그대로', /저장에 실패/.test(pA.__lastDialog || '') && failRes.storedCat === '쇼핑' && !failRes.confirmed, JSON.stringify(failRes) + ' ' + pA.__lastDialog);

// 7) 가져오기·필터 조작만으로 유료 호출 없음(로그인 전 단계 전체)
t('7) 가져오기·필터·화면 열기만으로 장소 확인·영업시간·경로·AI 분류 요청 0건', paidCalls.length === 0, paidCalls.join(' | '));

// 동기화(PC·모바일): 사용자 수정이 다른 기기로 그대로
await login(pA, 'classify@example.com');
await pA.evaluate(() => daSyncPush(A.sessionToken(foodMap)));
const pB = await newPage('B');
await login(pB, 'classify@example.com');
await pB.waitForTimeout(300);
const mB = await byName(pB);
t('동기화) 다른 기기에 사용자 확정 분류·태그가 그대로', mB['Morning Glory'] && mB['Morning Glory'].label === '카페·디저트' && mB['Morning Glory'].catConfirmed && JSON.stringify(mB['Morning Glory'].tags) === JSON.stringify(['베이커리·디저트']), JSON.stringify(mB['Morning Glory']));
t('동기화) 다른 기기에서도 비운 태그는 비어 있음', mB['국립서양미술관'] && mB['국립서양미술관'].tags.length === 0);
await importCsv(pB, CSV_PLAN, '여행 계획');
await pB.evaluate(() => daSyncPush(A.sessionToken(foodMap)));
const mB2 = await byName(pB);
t('동기화) 다른 기기에서 재가져오기해도 확정값 유지', mB2['Morning Glory'].label === '카페·디저트' && mB2['Morning Glory'].catConfirmed);
const ledger = openDb().prepare('SELECT COUNT(*) AS n FROM cost_ledger').get().n;
t('7) 로그인·동기화·재가져오기까지 비용 원장 기록 0건(외부 유료 호출 없음)', ledger === 0 && paidCalls.filter((u) => !/classify/.test(u)).length === 0, `ledger=${ledger} calls=${paidCalls.join(' | ')}`);

t('페이지 오류 없음', errs.length === 0, errs.join(' | '));
await b.close();
server.close();
if (fail) { console.log(`\n${fail} FAIL`); process.exit(1); }
console.log('\nALL PASS');
