/**
 * 2026-09-11 재검토(11차) 3절 — "태그 기능은 실제 화면과 계정 저장까지
 * 완성해." 실제 Chromium 화면으로 다음을 검증한다:
 *  1) 태그 편집 화면에서 이름 변경·커스텀 태그 삭제가 실제로 동작함.
 *  2) 기본 태그 이름을 바꿔도 전역 배열이 오염되지 않고(다른 계정에
 *     안 새어 나감), 계정별 override로만 저장됨.
 *  3) 계정 A가 만든/바꾼 태그가 로그아웃 → 재로그인 → 다른 기기에서
 *     그대로 복원되고, 계정 B에는 전혀 안 보임(계정 격리).
 *  4) 다른 기기에서 받은(레지스트리엔 없지만 장소엔 이미 붙어 있는)
 *     "알 수 없는" 태그도 편집 화면에서 빠지지 않고 보임.
 *  5) 다중 선택 → 태그 일괄 편집이 실제로 여러 곳에 한 번에 반영됨.
 *
 * 실행: node scripts/test-tag-registry-sync.mjs
 */
import { chromium } from 'playwright';

process.env.DB_PATH = ':memory:';
process.env.FORCE_TEST_MODE = 'true';
process.env.LOGIN_CODE_COOLDOWN_SECONDS = '0';
process.env.LOGIN_MAX_VERIFY_ATTEMPTS = '200';
const { createServer } = await import('../server/index.mjs');
const { sentEmailsForTest } = await import('../server/adapters/email.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const apiBase = `http://127.0.0.1:${port}`;

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errs = [];
async function newPage(label) {
  const page = await b.newPage();
  page.on('pageerror', (e) => errs.push(`pageerror(${label}): ` + e.message));
  page.on('dialog', (d) => d.dismiss());
  await page.addInitScript((base) => { window.API_BASE = base; }, apiBase);
  await page.goto('file://' + process.cwd() + '/src/design/index.html');
  await page.waitForTimeout(200);
  return page;
}
async function loginViaUi(page, email) {
  await page.evaluate(() => showLoginSheet(() => {}));
  await page.waitForTimeout(150);
  await page.fill('#loginEmail', email);
  await page.click('#loginSendBtn');
  await page.waitForTimeout(200);
  const sent = sentEmailsForTest.filter((e) => e.to === email).pop();
  const code = sent.body.match(/(\d{6})/)[1];
  await page.fill('#loginCode', code);
  await page.click('#loginVerifyBtn');
  await page.waitForFunction(() => !!(foodMap.session && foodMap.session.token), { timeout: 5000 });
  await page.waitForTimeout(250);
  await page.evaluate(() => { const c = document.getElementById('close'); if (c) c.click(); });
}
async function seedOnePlace(page, cityName) {
  await page.evaluate((c) => {
    foodMap.places = [{ id: 'p1', name: '테스트 가게', cat: '기타', catConfirmed: true, city: c, cityKnown: true, cityConfirmed: true, sourceLists: [], tags: [], tagsConfirmed: false }];
    A.saveFoodMap(foodMap);
  }, cityName);
  await page.reload();
  await page.waitForTimeout(200);
}

// =====================================================================
// 1) 태그 편집 화면 안에서 이름 변경·커스텀 태그 삭제가 실제로 동작.
// =====================================================================
{
  const email = 'tagreg-1@example.com';
  const city = '태그편집도시';
  const pA = await newPage('A1');
  await loginViaUi(pA, email);
  await seedOnePlace(pA, city);
  await pA.evaluate(() => { city = '태그편집도시'; updateCity(); tagsEditSheet('p1'); });
  await pA.waitForTimeout(150);
  // 새 커스텀 태그를 만들고 붙인다.
  await pA.fill('#tagsNewInput', '나만의태그');
  await pA.click('#tagsNewBtn');
  await pA.waitForTimeout(100);
  await pA.click('#tagsSaveBtn');
  await pA.waitForTimeout(150);
  const afterCreate = await pA.evaluate(() => foodMap.places.find((p) => p.id === 'p1').tags);
  t('1) 새 커스텀 태그가 실제로 장소에 붙음', afterCreate.includes('나만의태그'));

  // 편집 화면을 다시 열어 이름을 바꾼다.
  await pA.evaluate(() => tagsEditSheet('p1'));
  await pA.waitForTimeout(150);
  await pA.selectOption('#tagManageSelect', '나만의태그');
  await pA.fill('#tagRenameInput', '바뀐태그이름');
  await pA.click('#tagRenameBtn');
  await pA.waitForTimeout(200);
  const afterRename = await pA.evaluate(() => foodMap.places.find((p) => p.id === 'p1').tags);
  t('1) 이름을 바꾸면 장소에 붙어 있던 태그 문자열도 함께 바뀜', afterRename.includes('바뀐태그이름') && !afterRename.includes('나만의태그'));

  // 삭제한다.
  await pA.selectOption('#tagManageSelect', '바뀐태그이름');
  const deleteBtnVisible = await pA.evaluate(() => !document.getElementById('tagDeleteBtn').hidden);
  t('1) 내가 만든 태그를 고르면 삭제 버튼이 보임', deleteBtnVisible);
  await pA.click('#tagDeleteBtn');
  await pA.waitForTimeout(200);
  const afterDelete = await pA.evaluate(() => foodMap.places.find((p) => p.id === 'p1').tags);
  t('1) 삭제하면 장소에서 연결이 끊김(장소 자체는 그대로)', !afterDelete.includes('바뀐태그이름'));
  const placeStillThere = await pA.evaluate(() => !!foodMap.places.find((p) => p.id === 'p1'));
  t('1) 장소 자체는 절대 안 지워짐', placeStillThere);

  await pA.close();
}

// =====================================================================
// 2) 기본 태그 이름 변경 — 계정별 override로만 저장되고, 다른 계정
//    (또는 재로그인 없이 다른 세션)엔 전혀 안 새어 나감. 실제 서버
//    저장 확인까지 포함한다.
// =====================================================================
{
  const emailA = 'tagreg-2a@example.com';
  const emailB = 'tagreg-2b@example.com';
  const city = '기본태그도시';
  const pA = await newPage('A2');
  await loginViaUi(pA, emailA);
  await seedOnePlace(pA, city);
  await pA.evaluate(() => { city = '기본태그도시'; updateCity(); tagsEditSheet('p1'); });
  await pA.waitForTimeout(150);
  await pA.selectOption('#tagManageSelect', '카페');
  await pA.fill('#tagRenameInput', '커피숍');
  await pA.click('#tagRenameBtn');
  await pA.waitForTimeout(300);
  const knownAfterRename = await pA.evaluate(() => A.knownTags);
  t('2) 기본 태그 이름을 바꾸면 목록에 새 이름이 나타남', knownAfterRename.includes('커피숍') && !knownAfterRename.includes('카페'));

  await pA.waitForTimeout(300); // 서버 반영 대기.
  const tokenA = await pA.evaluate(() => foodMap.session.token);
  const serverTagsA = await fetch(`${apiBase}/api/tags`, { headers: { Authorization: `Bearer ${tokenA}` } }).then((r) => r.json());
  t('2) 서버에도 override가 실제로 저장됨(source: builtin-override)', serverTagsA.tags.some((x) => x.id === 'cafe' && x.label === '커피숍'));

  // 완전히 다른 계정(B) — 기본 태그 이름이 원래대로(카페)여야 한다.
  const pB = await newPage('B2');
  await loginViaUi(pB, emailB);
  await pB.waitForTimeout(300);
  const knownB = await pB.evaluate(() => A.knownTags);
  t('2) 다른 계정에는 이름 변경이 절대 안 새어 나감(전역 배열 오염 없음)', knownB.includes('카페') && !knownB.includes('커피숍'));

  await pA.close(); await pB.close();
}

// =====================================================================
// 3) 로그아웃 → 재로그인 → 다른 기기에서도 태그 레지스트리가 그대로
//    복원됨(계정 데이터가 사라지는 게 아니라 서버에 남아 있다가
//    돌아온다).
// =====================================================================
{
  const email = 'tagreg-3@example.com';
  const city = '복원도시';
  const pA = await newPage('A3');
  await loginViaUi(pA, email);
  await seedOnePlace(pA, city);
  await pA.evaluate(() => {
    const r = A.createTag('영구태그');
    A.saveFoodMap(foodMap);
    daSyncPushSafe();
  });
  await pA.waitForTimeout(300);
  await pA.evaluate(() => daLogout());
  await pA.waitForTimeout(200);

  await loginViaUi(pA, email); // 같은 계정으로 재로그인(같은 "기기").
  await pA.waitForTimeout(300);
  const afterRelogin = await pA.evaluate(() => A.knownTags);
  t('3) 로그아웃 후 재로그인해도 만든 태그가 그대로 복원됨', afterRelogin.includes('영구태그'));

  // 완전히 새 기기(같은 계정)에서도 복원돼야 한다.
  const pC = await newPage('C3');
  await loginViaUi(pC, email);
  await pC.waitForTimeout(300);
  const onNewDevice = await pC.evaluate(() => A.knownTags);
  t('3) 처음 로그인하는 다른 기기에서도 서버에서 태그를 받아 옴', onNewDevice.includes('영구태그'));

  await pA.close(); await pC.close();
}

// =====================================================================
// 4) 다른 기기에서 받은 "알 수 없는" 태그(레지스트리엔 없지만 장소엔
//    이미 붙어 있는 라벨)도 편집 화면에서 빠지지 않고 토글 칩으로
//    보임.
// =====================================================================
{
  const email = 'tagreg-4@example.com';
  const city = '미확인태그도시';
  const pA = await newPage('A4');
  await loginViaUi(pA, email);
  await pA.evaluate((c) => {
    // customTags 레지스트리에는 등록 안 된 채로 장소에만 라벨이
    // 붙어 있는 상황을 흉내낸다(예: 태그 레지스트리 동기화가 아직
    // 안 됐거나, 삭제된 뒤에도 남아 있던 문자열).
    foodMap.places = [{ id: 'p1', name: '테스트 가게', cat: '기타', catConfirmed: true, city: c, cityKnown: true, cityConfirmed: true, sourceLists: [], tags: ['미등록태그'], tagsConfirmed: true }];
    A.saveFoodMap(foodMap);
  }, city);
  await pA.reload();
  await pA.waitForTimeout(200);
  await pA.evaluate((c) => { city = c; updateCity(); tagsEditSheet('p1'); }, city);
  await pA.waitForTimeout(150);
  const chipVisible = await pA.evaluate(() => !!document.querySelector('[data-tag-toggle="미등록태그"]'));
  t('4) 레지스트리에 없는 태그도 이미 장소에 붙어 있으면 편집 화면에서 안 빠짐', chipVisible);
  const chipActive = await pA.evaluate(() => document.querySelector('[data-tag-toggle="미등록태그"]').classList.contains('active'));
  t('4) 그 칩은 이미 선택된 상태로 보임(연결 상태 그대로 반영)', chipActive);

  await pA.close();
}

// =====================================================================
// 5) 다중 선택 → 태그 일괄 편집이 실제로 여러 곳에 한 번에 반영됨.
// =====================================================================
{
  const email = 'tagreg-5@example.com';
  const city = '일괄편집도시';
  const pA = await newPage('A5');
  await loginViaUi(pA, email);
  await pA.evaluate((c) => {
    foodMap.places = [
      { id: 'p1', name: '가게1', cat: '기타', catConfirmed: true, city: c, cityKnown: true, cityConfirmed: true, sourceLists: [], tags: [] },
      { id: 'p2', name: '가게2', cat: '기타', catConfirmed: true, city: c, cityKnown: true, cityConfirmed: true, sourceLists: [], tags: [] },
      { id: 'p3', name: '가게3', cat: '기타', catConfirmed: true, city: c, cityKnown: true, cityConfirmed: true, sourceLists: [], tags: [] },
    ];
    A.saveFoodMap(foodMap);
  }, city);
  await pA.reload();
  await pA.waitForTimeout(200);
  await pA.evaluate((c) => { city = c; updateCity(); selecting = true; toggle('p1'); toggle('p2'); render(); }, city);
  await pA.waitForTimeout(100);
  await pA.click('#bulkTagEdit');
  await pA.waitForTimeout(150);
  await pA.fill('#bulkTagNewInput', '단체지정');
  await pA.click('#bulkTagNewBtn');
  await pA.waitForTimeout(100);
  await pA.click('#bulkTagAddBtn');
  await pA.waitForTimeout(200);
  const afterBulk = await pA.evaluate(() => foodMap.places.map((p) => ({ id: p.id, tags: p.tags })));
  t('5) 선택한 두 곳에만 일괄 태그가 붙음', afterBulk.find((p) => p.id === 'p1').tags.includes('단체지정') && afterBulk.find((p) => p.id === 'p2').tags.includes('단체지정'));
  t('5) 선택 안 한 곳은 그대로임', !afterBulk.find((p) => p.id === 'p3').tags.includes('단체지정'));

  await pA.close();
}

t('최종 콘솔/런타임 오류 0', errs.length === 0);
if (errs.length) console.log(errs);

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
await b.close();
server.close();
process.exit(fail ? 1 : 0);
