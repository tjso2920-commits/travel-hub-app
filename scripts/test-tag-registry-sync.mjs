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

// =====================================================================
// 6) 2026-09-11 재검토(12차) — ChatGPT가 실제로 재현한 "태그 저장 중
//    수정 유실" 버그. 저장 요청이 나간 뒤(응답 대기 중) 같은 태그를
//    로컬에서 또 고치면, 예전 코드는 응답(=요청을 보낸 시점의 값)을
//    무조건 그대로 받아들여 방금 한 수정을 조용히 지웠다. 실제
//    네트워크 지연 응답으로 재현한다(지시대로 "지연 응답으로 재현").
// =====================================================================
{
  const email = 'tagreg-6@example.com';
  const city = '저장중수정도시';
  const pA = await newPage('A6');
  await loginViaUi(pA, email);
  await seedOnePlace(pA, city);
  const created = await pA.evaluate(() => {
    const r = A.createTag('old label');
    A.saveFoodMap(foodMap);
    return r.tag.id;
  });
  await pA.evaluate(() => daSyncPushSafe());
  await pA.waitForTimeout(300); // 첫 동기화(기준선 확립)가 실제로 끝날 때까지 기다린다.
  const tagIdAfterFirstSync = await pA.evaluate((tid) => (A.rawCustomTags.find((t) => t.id === tid) || {}).id, created);
  t('6) 준비 확인 — 첫 동기화로 태그가 실제로 서버에 저장됨(id 유지)', tagIdAfterFirstSync === created);

  // 다음 /api/tags 요청 응답을 일부러 늦춘다(진짜 네트워크 지연 재현).
  let delayedOnce = false;
  await pA.route('**/api/tags', async (route) => {
    if (route.request().method() === 'PUT' && !delayedOnce) {
      delayedOnce = true;
      await new Promise((r) => setTimeout(r, 500));
    }
    await route.continue();
  });
  // 저장 요청을 시작한다(이 순간의 로컬 내용 = 'old label'이 그대로 나감).
  await pA.evaluate(() => { window.__pushDone = daSyncPushSafe(); });
  await pA.waitForTimeout(80); // 요청이 실제로 나간 뒤, 응답이 오기 전.
  // 바로 그 사이(응답 대기 중) 같은 태그를 로컬에서 또 고친다.
  await pA.evaluate((tid) => {
    const tag = A.rawCustomTags.find((x) => x.id === tid);
    tag.label = 'new local label';
    A.saveFoodMap(foodMap);
  }, created);
  await pA.waitForTimeout(700); // 지연된 응답이 처리될 시간을 준다.
  const finalLabel = await pA.evaluate((tid) => (A.rawCustomTags.find((x) => x.id === tid) || {}).label, created);
  t('6) 응답 대기 중에 한 수정이 뒤늦게 온 응답에 지워지지 않고 그대로 남음', finalLabel === 'new local label');
  const hasSpuriousConflict = await pA.evaluate((tid) => {
    const tag = A.rawCustomTags.find((x) => x.id === tid);
    return !!(tag && tag._fieldConflicts && tag._fieldConflicts.label);
  }, created);
  t('6) 서버가 실제로 다르게 고친 적은 없으므로 불필요한 충돌 알림은 안 뜸', !hasSpuriousConflict);

  await pA.close();
}

// =====================================================================
// 7) 진짜 같은 필드 양쪽 수정(다른 기기가 그 사이 서버에서 실제로 값을
//    바꿈) — 조용히 버려지지 않고 보존되며, 태그 편집 화면에서 직접
//    골라 해결할 수 있어야 한다("같은 필드 충돌은 조용히 버리지 말고
//    보존·해결 가능하게" 지시).
// =====================================================================
{
  const email = 'tagreg-7@example.com';
  const city = '같은필드충돌도시';
  const pA = await newPage('A7');
  await loginViaUi(pA, email);
  await seedOnePlace(pA, city);
  const created = await pA.evaluate(() => {
    const r = A.createTag('base label');
    foodMap.places.find((p) => p.id === 'p1').tags.push('base label'); // 이 태그를 실제 장소에 붙여 둔다(연결 유지 검증용).
    A.saveFoodMap(foodMap);
    return r.tag.id;
  });
  await pA.evaluate(() => daSyncPushSafe());
  await pA.waitForTimeout(300);
  const token = await pA.evaluate(() => foodMap.session.token);

  // "다른 기기"가 서버에서 곧바로 같은 태그의 label을 바꾼다(baseVersion=1 그대로 통과 — 이 기기가 아직 모르는 변경).
  const otherDeviceRes = await fetch(`${apiBase}/api/tags`, {
    method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags: [{ id: created, label: 'other device label', synonyms: [], source: 'user', version: 1 }], deletedIds: [] }),
  }).then((r) => r.json());
  t('7) 준비 확인 — 다른 기기의 수정이 실제로 서버에 반영됨', otherDeviceRes.ok && otherDeviceRes.tags.some((x) => x.id === created && x.label === 'other device label'));

  // 이 기기는(서버의 새 변경을 모른 채) 같은 태그의 label을 독립적으로
  // 고친다 — 실제 이름바꾸기 흐름과 같이 장소에 붙은 문자열도 함께 바꾼다.
  await pA.evaluate((tid) => {
    const tag = A.rawCustomTags.find((x) => x.id === tid);
    const oldLabel = tag.label;
    tag.label = 'my device label';
    const p1 = foodMap.places.find((p) => p.id === 'p1');
    const i = p1.tags.indexOf(oldLabel);
    if (i >= 0) p1.tags[i] = 'my device label';
    A.saveFoodMap(foodMap);
  }, created);
  await pA.evaluate(() => daSyncPushSafe());
  await pA.waitForTimeout(400);

  const afterConflict = await pA.evaluate((tid) => {
    const tag = A.rawCustomTags.find((x) => x.id === tid);
    return { label: tag && tag.label, conflict: tag && tag._fieldConflicts && tag._fieldConflicts.label };
  }, created);
  t('7) 같은 필드를 양쪽이 다르게 고치면 조용히 버리지 않고 내 값을 유지함', afterConflict.label === 'my device label');
  t('7) 다른 기기 값도 사라지지 않고 충돌로 보존됨(_fieldConflicts)', !!afterConflict.conflict && afterConflict.conflict.theirs === 'other device label');

  // 2026-09-11 재검토(13차) — ChatGPT 지적: hasUnresolvedConflicts가
  // places/courses/trips만 보고 customTags는 빠뜨려서, 태그 필드
  // 충돌이 이렇게 남아 있어도 fullySynced가 잘못 true였다. 지금 이
  // 시점(태그에 _fieldConflicts가 실제로 남아 있음)에 daSyncPush를
  // 다시 불러 반환값을 직접 확인한다.
  const pushResultWithTagConflict = await pA.evaluate((tok) => daSyncPush(tok), token);
  t('7) 태그에 미해결 필드 충돌이 남아 있으면 hasUnresolvedConflicts가 true(customTags 반영)', pushResultWithTagConflict.hasUnresolvedConflicts === true);
  t('7) fullySynced도 함께 false로 보고됨', pushResultWithTagConflict.fullySynced === false);

  // 태그 편집 화면에서 이 충돌이 실제로 보이고, 버튼으로 해결할 수 있음.
  await pA.evaluate((c) => { city = c; updateCity(); tagsEditSheet('p1'); }, city);
  await pA.waitForTimeout(150);
  await pA.selectOption('#tagManageSelect', 'my device label');
  await pA.waitForTimeout(100);
  const resolveBtnVisible = await pA.evaluate(() => !!document.querySelector('[data-tag-conflict-resolve]'));
  t('7) 태그 편집 화면에서 충돌 해결 버튼이 실제로 보임', resolveBtnVisible);
  await pA.click('[data-tag-conflict-resolve]');
  await pA.waitForTimeout(200);
  const afterResolve = await pA.evaluate((tid) => {
    const tag = A.rawCustomTags.find((x) => x.id === tid);
    return { label: tag && tag.label, hasConflict: !!(tag && tag._fieldConflicts) };
  }, created);
  t('7) 버튼을 누르면 다른 기기 값으로 실제로 바뀜', afterResolve.label === 'other device label');
  t('7) 해결하면 충돌 표시가 사라짐', !afterResolve.hasConflict);
  const placeTagsAfterResolve = await pA.evaluate(() => foodMap.places.find((p) => p.id === 'p1').tags);
  t('7) 장소에 붙어 있던 태그 문자열도 새 이름으로 함께 바뀜(연결 유지)', placeTagsAfterResolve.includes('other device label') && !placeTagsAfterResolve.includes('my device label'));

  await pA.close();
}

// =====================================================================
// 8) 2026-09-11 재검토(13차) — ChatGPT가 지시한 재현: 태그 저장 요청을
//    보낸 뒤(응답 대기 중) 그 태그를 로컬에서 삭제하면, 늦게 온 응답의
//    "mine 없음" 처리가 "다른 기기가 만든 낯선 태그"로 오인해 삭제한
//    태그를 부활시켰다(deletedTagIds엔 여전히 삭제됐다고 남아 있는데
//    목록엔 다시 보이는 모순). 실제 네트워크 지연 응답으로 재현한다.
// =====================================================================
{
  const email = 'tagreg-8@example.com';
  const city = '삭제중되살아남도시';
  const pA = await newPage('A8');
  await loginViaUi(pA, email);
  await seedOnePlace(pA, city);
  // 주의: 이 태그를 장소에는 붙이지 않는다 — 붙이면 daDeleteCustomTag가
  // 그 장소의 tags 배열도 함께 바꾸는데, 그러면 "저장 중 장소가 또
  // 바뀜" 보호 로직(changedDuringFlight)이 별도로 반응해 즉시 재시도
  // 푸시를 스스로 발동시켜(daScheduleConflictRetry) 이 시나리오가 노리는
  // "느리게 돌아온 응답"을 새 재시도가 앞질러 버린다 — 태그 레지스트리
  // 자체의 되살리기 버그만 순수하게 재현하려면 장소 연결 없이 만든다.
  const created = await pA.evaluate(() => {
    const r = A.createTag('지울태그');
    A.saveFoodMap(foodMap);
    return r.tag.id;
  });
  await pA.evaluate(() => daSyncPushSafe());
  await pA.waitForTimeout(300); // 첫 동기화(기준선 확립)가 실제로 끝날 때까지 기다린다.
  const idAfterFirstSync = await pA.evaluate((tid) => (A.rawCustomTags.find((t) => t.id === tid) || {}).id, created);
  t('8) 준비 확인 — 첫 동기화로 태그가 실제로 서버에 저장됨', idAfterFirstSync === created);

  // 다음 /api/tags 요청 응답을 일부러 늦춘다(진짜 네트워크 지연 재현).
  let delayedOnce = false;
  await pA.route('**/api/tags', async (route) => {
    if (route.request().method() === 'PUT' && !delayedOnce) {
      delayedOnce = true;
      await new Promise((r) => setTimeout(r, 500));
    }
    await route.continue();
  });
  // 저장 요청을 시작한다(이 순간의 로컬 내용 = '지울태그'가 여전히 존재하는 채로 나감).
  await pA.evaluate(() => { window.__pushDone8 = daSyncPushSafe(); });
  await pA.waitForTimeout(80); // 요청이 실제로 나간 뒤, 응답이 오기 전.
  // 바로 그 사이(응답 대기 중) 이 태그를 로컬에서 지운다(실제 삭제 흐름 그대로).
  await pA.evaluate((tid) => {
    const tag = A.rawCustomTags.find((x) => x.id === tid);
    A.deleteCustomTag(tid, foodMap.places);
    A.saveFoodMap(foodMap);
  }, created);
  const rightAfterDelete = await pA.evaluate((tid) => ({
    stillInRegistry: A.rawCustomTags.some((x) => x.id === tid),
  }), created);
  t('8) 삭제 직후 — 태그 레지스트리에서 즉시 빠짐', !rightAfterDelete.stillInRegistry);

  await pA.waitForTimeout(700); // 지연된 응답이 처리될 시간을 준다.
  const afterDelayedResponse = await pA.evaluate((tid) => ({
    revivedInRegistry: A.rawCustomTags.some((x) => x.id === tid),
    stillMarkedDeleted: (A.deletedTagIds || []).some((d) => d.id === tid),
  }), created);
  t('8) 늦게 온 저장 응답이 삭제한 태그를 레지스트리에 되살리지 않음', !afterDelayedResponse.revivedInRegistry);
  t('8) deletedTagIds에는 여전히 삭제된 것으로 남아 다음 push에서 재시도됨(모순 상태 없음)', afterDelayedResponse.stillMarkedDeleted);

  // 이어지는 daSyncPushSafe(재시도)까지 실제로 끝난 뒤 서버 쪽도 정말
  // 삭제됐는지(부활한 채로 서버에 반영되지 않았는지) 확인한다.
  await pA.evaluate(() => daSyncPushSafe());
  await pA.waitForTimeout(300);
  const token8 = await pA.evaluate(() => foodMap.session.token);
  const serverTags8 = await fetch(`${apiBase}/api/tags`, { headers: { Authorization: `Bearer ${token8}` } }).then((r) => r.json());
  t('8) 서버에도 최종적으로 삭제가 실제로 반영됨', !serverTags8.tags.some((x) => x.id === created));

  await pA.close();
}

t('최종 콘솔/런타임 오류 0', errs.length === 0);
if (errs.length) console.log(errs);

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
await b.close();
server.close();
process.exit(fail ? 1 : 0);
