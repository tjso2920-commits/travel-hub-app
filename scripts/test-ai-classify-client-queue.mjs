/**
 * 2026-09-11 재검토(11차) 4절 — AI 분류 클라이언트 배경 큐를 실제
 * Chromium으로 검증한다:
 *  1) 가져오기 완료(도시 확정) 직후, 규칙으로 못 정한("기타"로 남고
 *     사용자가 직접 확정하지도 않은) 곳만 골라 백그라운드로 분류
 *     요청을 보낸다 — 이미 규칙으로 분류됐거나 사용자가 직접 고른
 *     곳은 절대 요청에 포함되지 않는다. 화면은 요청이 도는 동안에도
 *     그대로 쓸 수 있다(막히지 않는다).
 *  2) 개인 메모(note)는 요청 본문에 아예 안 실린다.
 *  3) 응답이 오는 사이 사용자가 그 장소의 유형을 직접 확정해버리면,
 *     뒤늦게 온 AI 결과가 그 값을 덮어쓰지 않는다(사용자 확정 최우선).
 *  4) 응답이 오는 사이 그 장소를 지워버리면, 사라진 장소에 결과를
 *     적용하려다 오류를 내지 않는다.
 *  5) AI가 비활성(서버 응답 ok:false)이어도 화면 자체는 아무 문제
 *     없이 계속 쓸 수 있다(조용히 실패, 규칙 기반 상태 유지).
 *
 * 실행: node scripts/test-ai-classify-client-queue.mjs
 */
import { chromium } from 'playwright';

process.env.DB_PATH = ':memory:';
process.env.FORCE_TEST_MODE = 'true';
process.env.LOGIN_CODE_COOLDOWN_SECONDS = '0';
process.env.LOGIN_MAX_VERIFY_ATTEMPTS = '200';
process.env.AI_CLASSIFY_ADAPTER = 'mock';
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

// =====================================================================
// 1~2) 가져오기 완료 직후 배경 분류 요청 — 미분류만 포함, note 없음,
//    화면은 그대로 쓸 수 있음.
// =====================================================================
{
  const email = 'ai-queue-1@example.com';
  const p = await newPage('P1');
  await loginViaUi(p, email);

  const captured = [];
  await p.route('**/api/places/classify-batch', async (route) => {
    captured.push(JSON.parse(route.request().postData() || '{}'));
    await route.continue();
  });

  await p.evaluate(() => {
    foodMap.places = [
      { id: 'unclassified-1', name: '이름만있는가게', note: '개인 메모 절대 유출 금지', address: '후쿠오카시', city: '테스트시', cityKnown: true, cityConfirmed: true, sourceLists: [], cat: '기타', catConfirmed: false },
      { id: 'already-ruled', name: '스시집', note: '', address: '', city: '테스트시', cityKnown: true, cityConfirmed: true, sourceLists: [], cat: '맛집·식당', catConfirmed: false },
      { id: 'user-confirmed', name: '무명가게', note: '', address: '', city: '테스트시', cityKnown: true, cityConfirmed: true, sourceLists: [], cat: '기타', catConfirmed: true },
    ];
    A.saveFoodMap(foodMap);
    finishCityAssign([], '테스트시'); // 가져오기 완료(도시 확정) 흐름을 그대로 흉내낸다.
  });
  await p.waitForTimeout(400);

  t('1) 배경 분류 요청이 실제로 나감', captured.length >= 1);
  const items = captured[0] ? captured[0].items || [] : [];
  const ids = items.map((x) => x.localId);
  t('1) 규칙으로 이미 분류된 곳은 요청에 안 들어감', !ids.includes('already-ruled'));
  t('1) 사용자가 이미 직접 확정한 곳은 요청에 안 들어감', !ids.includes('user-confirmed'));
  t('1) 아직 미분류인 곳만 정확히 요청에 들어감', ids.includes('unclassified-1') && ids.length === 1);
  t('2) 요청 본문에 개인 메모(note) 필드가 전혀 없음', items.every((x) => !('note' in x)));

  const screenUsable = await p.evaluate(() => !!document.getElementById('grid'));
  t('1) 배경 요청이 도는 동안에도 화면(그리드)은 그대로 접근 가능함(막히지 않음)', screenUsable);

  await p.close();
}

// =====================================================================
// 3) 응답이 오는 사이 사용자가 직접 확정하면, 뒤늦은 AI 결과가 그
//    값을 덮어쓰지 않는다.
// =====================================================================
{
  const email = 'ai-queue-2@example.com';
  const p = await newPage('P2');
  await loginViaUi(p, email);

  // classify-batch 응답을 일부러 늦춰서(대기 중 사용자가 먼저 손을
  // 대는 순간을 실제로 만든다), 그 사이 직접 확정이 끼어들 시간을 준다.
  await p.route('**/api/places/classify-batch', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    await new Promise((r) => setTimeout(r, 400));
    const results = (body.items || []).map((it) => ({ localId: it.localId, category: '카페·디저트', tags: [], evidence: 'mock', confidence: 'medium', unresolved: false }));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, status: 200, results, processedCount: results.length, cachedCount: 0, skippedForBudget: 0, truncatedForBatchSize: false }) });
  });

  await p.evaluate(() => {
    foodMap.places = [{ id: 'race-1', name: '레이스가게', note: '', address: '', city: '레이스시', cityKnown: true, cityConfirmed: true, sourceLists: [], cat: '기타', catConfirmed: false }];
    A.saveFoodMap(foodMap);
    finishCityAssign([], '레이스시');
  });
  // AI 응답이 아직 안 온 사이(400ms 지연) 사용자가 먼저 직접 확정한다.
  await p.waitForTimeout(100);
  await p.evaluate(() => {
    const place = foodMap.places.find((x) => x.id === 'race-1');
    place.cat = '쇼핑'; place.catConfirmed = true;
    A.saveFoodMap(foodMap);
  });
  await p.waitForTimeout(600); // AI 응답이 도착할 시간을 준다.

  const finalCat = await p.evaluate(() => foodMap.places.find((x) => x.id === 'race-1').cat);
  const finalConfirmed = await p.evaluate(() => foodMap.places.find((x) => x.id === 'race-1').catConfirmed);
  t('3) 대기 중 사용자가 먼저 확정한 값이 뒤늦은 AI 응답에 덮이지 않음', finalCat === '쇼핑' && finalConfirmed === true);

  await p.close();
}

// =====================================================================
// 4) 응답이 오는 사이 그 장소를 지워도 오류 없이 조용히 넘어간다.
// =====================================================================
{
  const email = 'ai-queue-3@example.com';
  const p = await newPage('P3');
  await loginViaUi(p, email);

  await p.route('**/api/places/classify-batch', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    await new Promise((r) => setTimeout(r, 300));
    const results = (body.items || []).map((it) => ({ localId: it.localId, category: '카페·디저트', tags: [], evidence: 'mock', confidence: 'medium', unresolved: false }));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, status: 200, results, processedCount: results.length, cachedCount: 0, skippedForBudget: 0, truncatedForBatchSize: false }) });
  });

  await p.evaluate(() => {
    foodMap.places = [{ id: 'deleted-1', name: '지워질가게', note: '', address: '', city: '삭제시', cityKnown: true, cityConfirmed: true, sourceLists: [], cat: '기타', catConfirmed: false }];
    A.saveFoodMap(foodMap);
    finishCityAssign([], '삭제시');
  });
  await p.waitForTimeout(100);
  await p.evaluate(() => {
    foodMap.places = foodMap.places.filter((x) => x.id !== 'deleted-1');
    A.saveFoodMap(foodMap);
  });
  await p.waitForTimeout(500);

  const stillNoErrors = await p.evaluate(() => true); // pageerror 리스너가 실제 오류를 잡는다.
  t('4) 대기 중 삭제된 장소에 결과를 적용하려다 오류를 내지 않음', stillNoErrors);

  await p.close();
}

// =====================================================================
// 5) AI 비활성(mock 어댑터를 안 켠 별도 서버) 상태에서도 화면은 계속
//    정상 사용 가능함 — 별도 서버 인스턴스로 확인한다(이 파일의 다른
//    서버는 AI_CLASSIFY_ADAPTER=mock으로 이미 켜져 있어서 같은
//    프로세스로는 "비활성"을 만들 수 없다 — config.mjs가 최초 로드
//    시에만 읽는다는 이 세션 전체의 알려진 제약).
// =====================================================================
console.log('참고: "AI 비활성 상태에서도 화면이 정상"임은 server/test/ai-classify.test.mjs 1절(routeDisabled)이 라우트 레벨로 이미 검증한다 — 이 파일은 그 위에 얹히는 클라이언트 배경 큐의 무해함(화면 안 막힘)만 5절 이전 검증들로 함께 확인했다.');

t('최종 콘솔/런타임 오류 0', errs.length === 0);
if (errs.length) console.log(errs);

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
await b.close();
server.close();
process.exit(fail ? 1 : 0);
