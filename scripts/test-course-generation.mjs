/**
 * 실제 코스 생성 검증 — 실제 Chromium + 실제 서버(임시 포트).
 *
 * 2026-09-10 재검토(3차): 개인화 코스 생성이 브라우저 계산에서 서버
 * 집행(POST /api/course/generate)으로 옮겨갔고, 실제 데이터로 코스를
 * 만들려면 이제 로그인이 항상 필요하다(샘플만 예외). 라우팅 계산
 * 자체가 서버 쪽(server/adapters/routing.mjs)에서 일어나므로
 * `ROUTING_TEST_FORCE` 환경변수로 성공/실패를 결정론적으로 고정해
 * 확인한다. 이 값은 config.mjs가 프로세스 시작 시점에 한 번만 읽으므로
 * (config.test.mjs·generation-trial-charging-*.test.mjs와 같은 이유),
 * 시나리오마다 실제로 별도 자식 프로세스를 띄운다 — 이 파일이 인자
 * 없이 실행되면 부모로서 시나리오별 자식을 순서대로 실행하고 결과를
 * 모은다.
 *
 * 실행: node scripts/test-course-generation.mjs
 */
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCENARIO = process.argv.find((a) => a.startsWith('--scenario='));

if (!SCENARIO) {
  // --- 부모 프로세스: 시나리오별 자식을 순서대로 실행 ---
  const here = fileURLToPath(import.meta.url);
  const scenarios = ['success', 'failure', 'budget'];
  let fail = 0;
  for (const s of scenarios) {
    console.log(`\n=== 시나리오: ${s} ===`);
    const r = spawnSync('node', [here, `--scenario=${s}`], { stdio: 'inherit' });
    if (r.status !== 0) fail++;
  }
  console.log(fail ? `\n${fail}개 시나리오 실패` : '\n전체 시나리오 통과');
  process.exit(fail ? 1 : 0);
}

// --- 자식 프로세스: 시나리오 하나 실행 ---
const scenario = SCENARIO.split('=')[1];
process.env.DB_PATH = ':memory:';
process.env.FORCE_TEST_MODE = 'true';
process.env.ROUTING_TEST_FORCE = scenario === 'budget' ? 'success' : scenario;

const { chromium } = await import('playwright');
const { createServer } = await import('../server/index.mjs');
const { sentEmailsForTest } = await import('../server/adapters/email.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const apiBase = `http://127.0.0.1:${port}`;

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage({ viewport: { width: 390, height: 844 } });
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('dialog', (d) => d.dismiss());
await p.addInitScript((base) => { window.API_BASE = base; }, apiBase);
await p.goto('file://' + process.cwd() + '/src/design/index.html');
await p.waitForTimeout(300);

/* 서버 API만 직접 부르는 게 아니라, 실제 UI 로그인 흐름과 똑같이
   foodMap.session도 채워 저장한다 — 안 그러면 A.sessionToken(foodMap)
   이 계속 비어 있어 로그인 게이트를 통과 못 한다(실제 화면에서는
   showLoginCodeSheet의 verify 핸들러가 이 일을 한다). */
async function login(email) {
  await p.evaluate((em) => A.api('/api/auth/request-code', { method: 'POST', body: { email: em } }), email);
  await p.waitForTimeout(100);
  const code = sentEmailsForTest.filter((e) => e.to === email).pop().body.match(/(\d{6})/)[1];
  const r = await p.evaluate(({ em, c }) => A.api('/api/auth/verify-code', { method: 'POST', body: { email: em, code: c } }), { em: email, c: code });
  if (r.ok && r.json && r.json.token) {
    await p.evaluate(({ em, tok }) => { foodMap.session = { token: tok, email: em }; A.saveFoodMap(foodMap); }, { em: email, tok: r.json.token });
  }
  return r;
}
async function seedPlaces() {
  await p.evaluate(() => {
    foodMap.places = [
      { id: 'c1', name: '커피집', lat: 33.590, lng: 130.400, cat: '카페·디저트', catConfirmed: true, sourceLists: [] },
      { id: 'c2', name: '라멘집', lat: 33.591, lng: 130.402, cat: '맛집·식당', catConfirmed: true, sourceLists: [] },
      { id: 'c3', name: '전망대', lat: 33.593, lng: 130.405, cat: '관광·명소', catConfirmed: true, sourceLists: [] },
      { id: 'c4', name: '좌표없는가게', lat: null, lng: null, cat: '기타', sourceLists: [] },
    ];
    delete foodMap.course; delete foodMap.courses;
    A.saveFoodMap(foodMap);
  });
  await p.reload();
  await p.waitForTimeout(300);
}

if (scenario === 'success') {
  await seedPlaces();
  const acc = await login('course-real-success@example.com');
  t('로그인 성공', acc.ok === true && !!(acc.json && acc.json.token));
  await p.evaluate(() => { ['c1', 'c2', 'c3', 'c4'].forEach((id) => route.add(id)); });
  await p.evaluate(() => showRoute());
  await p.waitForTimeout(150);
  await p.click('[data-build-course]');
  await p.waitForTimeout(150);
  const firstTitle = await p.textContent('#sheetLabel');
  t('로그인된 상태로 코스 만들기를 누르면 곧바로 출발지 화면', firstTitle === '출발지 정하기');
  await p.click('[data-start-pick="c1"]');
  await p.waitForTimeout(800);
  const detailReal = await p.textContent('#sheetContent');
  t('실제 경로 성공 시 "실제 도보 경로 기준"으로 정직하게 표시', detailReal.includes('실제 도보 경로 기준'));
  t('직선거리 추정이라고 잘못 표시하지 않음', !detailReal.includes('직선거리 기준으로 추정'));
  t('좌표 없는 곳은 조용히 안 빠지고 이유와 함께 보여짐', detailReal.includes('좌표없는가게') && detailReal.includes('빠진 곳'));
  const savedCourse1 = await p.evaluate(() => foodMap.course);
  t('routedReal=true로 저장됨', savedCourse1.routedReal === true);
  t('출발지로 고른 곳은 코스의 정거장 목록에서 빠짐(출발지 자체는 목적지가 아님)', !savedCourse1.stops.some((s) => s.id === 'c1'));
  t('좌표 있는 나머지 2곳은 정거장으로 들어감', savedCourse1.stops.length === 2);
  await p.evaluate(() => document.getElementById('close').click());
  await p.waitForTimeout(150);

  await p.reload();
  await p.waitForTimeout(300);
  await p.evaluate(() => showRoute());
  await p.waitForTimeout(150);
  const afterReload = await p.textContent('#sheetContent');
  t('새로고침 후에도 저장된 코스가 다시 보임(재생성 안 해도 됨)', afterReload.includes('실제 도보 경로 기준'));
  await p.evaluate(() => document.getElementById('close').click());
}

if (scenario === 'failure') {
  await seedPlaces();
  await login('course-fallback@example.com');
  await p.evaluate(() => { ['c1', 'c2', 'c3'].forEach((id) => route.add(id)); });
  await p.evaluate(() => showRoute());
  await p.waitForTimeout(150);
  await p.click('[data-build-course]');
  await p.waitForTimeout(200);
  await p.click('[data-start-pick="c1"]');
  await p.waitForTimeout(800);
  const detailFallback = await p.textContent('#sheetContent');
  t('실제 경로 연결 실패 시 직선거리 추정이라고 정직하게 표시', detailFallback.includes('직선거리 기준으로 추정'));
  const savedCourse2 = await p.evaluate(() => foodMap.course);
  t('routedReal=false로 저장됨(성공한 척 안 함)', savedCourse2.routedReal === false);
  t('실패해도 방문 순서 자체는 만들어짐(원래 순서 그대로 방치 안 함)', savedCourse2.stops.length === 2);
  await p.evaluate(() => document.getElementById('close').click());

  // 추정(실패) 결과는 무료체험을 안 쓰므로, 같은 계정으로 GPS 출발
  // 코스를 다시 만들어도 계속 무료로 통과된다(회계 처리는
  // generation-trial-charging-*.test.mjs에서 별도로 더 자세히 검증).
  await p.context().grantPermissions(['geolocation']);
  await p.context().setGeolocation({ latitude: 33.589, longitude: 130.399 });
  await p.evaluate(() => { route.clear(); ['c1', 'c2'].forEach((id) => route.add(id)); });
  await p.evaluate(() => showRoute());
  await p.waitForTimeout(150);
  await p.click('[data-course-new]');
  await p.waitForTimeout(200);
  const gpsSheetTitle = await p.textContent('#sheetLabel');
  t('추정 결과는 체험을 안 써서 다음 시도도 곧바로 출발지 화면(이용권 아님)', gpsSheetTitle === '출발지 정하기');
  await p.click('[data-start-gps]');
  await p.waitForTimeout(1500);
  const detailGps = await p.textContent('#sheetContent');
  t('GPS 현재 위치를 출발지로 써도 코스가 만들어짐(API 키 없이 브라우저 위치 기능만 사용)', detailGps.includes('도보 이동'));
  const savedCourseGps = await p.evaluate(() => foodMap.course);
  t('GPS 출발일 때는 담아 둔 곳 전부가 정거장이 됨(출발지 자체가 목록에 없으므로)', savedCourseGps.stops.length === 2);
  await p.evaluate(() => document.getElementById('close').click());
}

if (scenario === 'budget') {
  await p.evaluate(() => {
    foodMap.places = [
      { id: 'b1', name: '출발점', lat: 33.590, lng: 130.400, cat: '카페·디저트', catConfirmed: true, sourceLists: [] },
      { id: 'b2', name: '가까운곳', lat: 33.591, lng: 130.401, cat: '맛집·식당', catConfirmed: true, sourceLists: [] },
      { id: 'b3', name: '먼곳', lat: 33.750, lng: 130.550, cat: '관광·명소', catConfirmed: true, sourceLists: [] },
    ];
    delete foodMap.course; delete foodMap.courses;
    A.saveFoodMap(foodMap);
  });
  await p.reload();
  await p.waitForTimeout(300);
  await login('course-budget@example.com');
  await p.evaluate(() => { ['b1', 'b2', 'b3'].forEach((id) => route.add(id)); });
  await p.evaluate(() => showRoute());
  await p.waitForTimeout(200);
  await p.click('[data-build-course]');
  await p.waitForTimeout(200);
  await p.fill('#courseMinutes', '60');
  await p.click('[data-start-pick="b1"]');
  await p.waitForTimeout(800);
  const detailBudget = await p.textContent('#sheetContent');
  t('가용 시간을 넘겨 못 들르는 곳은 "시간 안에 못 들름"으로 따로 표시', detailBudget.includes('가용 시간 안에'));
  const savedCourseBudget = await p.evaluate(() => foodMap.course);
  t('가용 시간을 넘는 먼 곳은 정거장에서 빠짐', !savedCourseBudget.stops.some((s) => s.id === 'b3'));
  t('시간 안에 드는 가까운 곳은 그대로 들어감', savedCourseBudget.stops.some((s) => s.id === 'b2'));
  t('시간 이유로 뺀 곳은 excludedReasons에 time-budget으로 남음', savedCourseBudget.excludedReasons && savedCourseBudget.excludedReasons.b3 === 'time-budget');
  await p.evaluate(() => document.getElementById('close').click());
  await p.waitForTimeout(150);

  await p.evaluate(() => showRoute());
  await p.waitForTimeout(150);
  const beforeNewCourse = await p.evaluate(() => foodMap.course);
  await p.click('[data-course-new]');
  await p.waitForTimeout(200);
  t('"새로 만들기"를 누른 직후에도(아직 새 코스 완성 전) 기존 코스가 안 지워짐', JSON.stringify(await p.evaluate(() => foodMap.course)) === JSON.stringify(beforeNewCourse));
  await p.evaluate(() => document.getElementById('close').click());
  await p.waitForTimeout(150);
  t('출발지 시트를 취소해도 기존 코스가 그대로 남음', JSON.stringify(await p.evaluate(() => foodMap.course)) === JSON.stringify(beforeNewCourse));
}

t('최종 콘솔/런타임 오류 0', errs.length === 0);
if (errs.length) console.log('  ', errs.slice(0, 5));

await b.close();
server.close();
console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
