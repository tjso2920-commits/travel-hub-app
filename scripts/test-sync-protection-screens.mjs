/**
 * 2026-09-10 재검토(6차) 4절 — "새 trip/visit API의 충돌 보호가 있어도
 * 기존 /api/places·/api/courses 전체 치환 경로가 최신 데이터를 덮어쓰지
 * 않아야 한다"를 서버 단위 테스트가 아니라 실제 화면(Chromium)에서
 * 지정된 6개 시나리오로 확인한다.
 *
 * 실행: node scripts/test-sync-protection-screens.mjs
 */
import { chromium } from 'playwright';

process.env.DB_PATH = ':memory:';
process.env.FORCE_TEST_MODE = 'true';
process.env.ROUTING_TEST_FORCE = 'success';
process.env.LOGIN_CODE_COOLDOWN_SECONDS = '0';
const { createServer } = await import('../server/index.mjs');
const { openDb } = await import('../server/db.mjs');
const { sentEmailsForTest } = await import('../server/adapters/email.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const apiBase = `http://127.0.0.1:${port}`;

async function apiCall(pathname, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(apiBase + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, json };
}

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

const email = 'sync-protect-tester@example.com';
const city = '동기화도시';

// =====================================================================
// (a) 기기 A의 최신 장소 수정 후, 오래된(스냅샷이 뒤처진) 기기 B가
// 저장하면 A의 최신 수정이 사라지면 안 된다.
// =====================================================================
{
  const pA = await newPage('A');
  await loginViaUi(pA, email);
  await pA.evaluate((cityName) => {
    foodMap.places = [{ id: 'place1', name: '원래 이름', lat: 33.5, lng: 130.4, cat: '카페·디저트', catConfirmed: true, city: cityName, cityKnown: true, cityConfirmed: true, sourceLists: [] }];
    A.saveFoodMap(foodMap);
  }, city);
  await pA.evaluate(() => daSyncPushSafe());
  await pA.waitForTimeout(300);

  // 기기 B는 A가 이름을 바꾸기 "전" 상태를 그대로 들고 있다가 지금
  // 로그인한다(오래된 스냅샷).
  const pB = await newPage('B');
  await loginViaUi(pB, email);
  await pB.waitForTimeout(300);
  const bSeesOriginal = await pB.evaluate(() => foodMap.places.find((p) => p.id === 'place1').name);
  t('기기 B가 로그인하면 기기 A가 만든 장소를 그대로 받아옴', bSeesOriginal === '원래 이름');

  // 기기 A가 이름을 바꾼다(최신 수정).
  await pA.evaluate(() => { foodMap.places[0].name = 'A가 고친 최신 이름'; A.saveFoodMap(foodMap); });
  await pA.evaluate(() => daSyncPushSafe());
  await pA.waitForTimeout(300);

  // 기기 B는 A의 수정을 모른 채(재로그인하지 않은 채) 자신의 무관한
  // 변경(다른 장소 추가)을 저장 → daSyncPushSafe가 발동돼 B가 들고
  // 있던 "오래된 전체 배열"을 그대로 다시 올린다.
  await pB.evaluate(() => {
    foodMap.places.push({ id: 'place2', name: 'B가 새로 담은 곳', lat: 33.6, lng: 130.5, cat: '맛집·식당', catConfirmed: true, sourceLists: [] });
    A.saveFoodMap(foodMap);
  });
  await pB.evaluate(() => daSyncPushSafe());
  await pB.waitForTimeout(300);

  const serverPlaces = await apiCall('/api/places', { token: await pA.evaluate(() => foodMap.session.token) });
  const place1OnServer = serverPlaces.json.places.find((p) => p.id === 'place1');
  const survived = place1OnServer && place1OnServer.name === 'A가 고친 최신 이름';
  // 2026-09-10 재검토(7차) — 6차에서는 이 시나리오가 실패했다(/api/places가
  // 전체 치환이라 버전 비교가 없어 "마지막에 저장을 누른 기기가 이긴다"는
  // 구조였다 — 알려진 한계로 문서에 남겼었다). 7차에서 account_places에도
  // trips/visits(R5-7)와 같은 버전 비교+보수적 병합을 실제로 적용해
  // 고쳤다(server/routes/account-data.mjs의 syncPlaces) — 이제는 실제로
  // 통과해야 한다. 다시 실패하면 조용히 넘기지 않고 그대로 보고한다.
  t('(a) 기기 B의 오래된 저장이 기기 A의 최신 장소 수정을 덮어쓰지 않음', survived);
  await pA.close(); await pB.close();
}

// =====================================================================
// (b) 두 기기가 서로 다른 여행/방문 날짜를 추가하면 둘 다 보존돼야
// 한다(trips/visits sync — R5-7 버전 보호가 실제 화면에서도 동작).
// =====================================================================
{
  const pA = await newPage('A2');
  await loginViaUi(pA, email);
  await pA.evaluate((cityName) => {
    foodMap.places = (foodMap.places || []).concat([{ id: 'bp1', name: 'B시나리오 장소', lat: 33.7, lng: 130.6, cat: '카페·디저트', catConfirmed: true, city: cityName, cityKnown: true, cityConfirmed: true, sourceLists: [] }]);
    delete foodMap.trips; delete foodMap.currentTripByCity;
    A.saveFoodMap(foodMap);
  }, city + '2');
  await pA.reload();
  await pA.waitForTimeout(200);
  await pA.evaluate(() => daSyncPushSafe());
  await pA.waitForTimeout(300);
  await pA.evaluate((cityName) => { city = cityName; updateCity(); }, city + '2');
  await pA.waitForTimeout(150);
  await pA.evaluate(() => { route.add('bp1'); showRoute(); });
  await pA.waitForTimeout(150);
  await pA.click('[data-build-course]');
  await pA.waitForTimeout(150);
  await pA.click('[data-start-pick="bp1"]');
  await pA.waitForTimeout(800);
  await pA.evaluate(() => document.getElementById('close').click());

  const pB = await newPage('B2');
  await loginViaUi(pB, email);
  await pB.waitForTimeout(300);
  await pB.evaluate((cityName) => { city = cityName; updateCity(); }, city + '2');
  await pB.waitForTimeout(150);
  // B는 A와 "다른 날짜"로 새 여행을 하나 더 만든다.
  await pB.evaluate(() => showRoute());
  await pB.waitForTimeout(150);
  await pB.click('[data-trip-new]');
  await pB.waitForTimeout(150);
  await pB.fill('#tripName', 'B가 만든 여행');
  await pB.click('#tripCreateBtn');
  await pB.waitForTimeout(400);
  await pB.evaluate(() => document.getElementById('close').click());

  const finalTrips = await apiCall(`/api/trips`, { token: await pA.evaluate(() => foodMap.session.token) });
  t('(b) 서로 다른 기기가 만든 여행이 둘 다 서버에 보존됨(하나가 다른 하나를 안 지움)', finalTrips.json.trips.filter((tr) => tr.city === city + '2').length === 2);
  await pA.close(); await pB.close();
}

// =====================================================================
// (c) 방문 취소 후 오래된 기기가 재연결해도 취소한 방문이 되살아나면
// 안 된다(무덤 표시 — visits.mjs의 removed_visit_dates).
// =====================================================================
{
  const pA = await newPage('A3');
  await loginViaUi(pA, email);
  await pA.waitForTimeout(200);
  const tokenA3 = await pA.evaluate(() => foodMap.session.token);
  await apiCall('/api/places', { method: 'PUT', token: tokenA3, body: { places: [{ id: 'cp1', name: '취소시나리오장소', lat: 33.5, lng: 130.4, cat: '카페·디저트' }] } });
  await apiCall('/api/visits/cp1/mark', { method: 'POST', token: tokenA3, body: { date: '2026-05-01' } });
  // 서버에 직접(API로) 만들어 둔 위 데이터를 기기 A 화면 쪽으로 실제로
  // 끌어온다 — daSyncPullAndMerge가 로그인 때 쓰는 바로 그 함수다.
  await pA.evaluate((token) => daSyncPullAndMerge(token), tokenA3);
  await pA.evaluate(() => { refreshFromStorage(); updateCity(); });
  await pA.waitForTimeout(200);

  // 오래된 기기 B가 "취소되기 전" 상태(2026-05-01 방문 있음)로 로그인한다.
  const pB = await newPage('B3');
  await loginViaUi(pB, email);
  await pB.waitForTimeout(300);
  const bBeforeUnmark = await pB.evaluate(() => (foodMap.visits.find((v) => v.placeId === 'cp1') || {}).visitedDates || []);
  t('기기 B가 방문 취소 전 상태(2026-05-01 있음)를 정상적으로 받음', bBeforeUnmark.some((d) => d.date === '2026-05-01'));

  // 기기 A가 그 방문을 취소한다.
  await pA.evaluate(() => detail('cp1'));
  await pA.waitForTimeout(150);
  await pA.click('[data-visit-unmark="cp1"]');
  await pA.waitForTimeout(300);

  // 기기 B는 그 사실을 모른 채(재로그인 없이) 자신의 무관한 변경을
  // 실제 화면(장소 상세의 메모 저장 버튼)으로 저장한다 — 방문 액션은
  // 매번 서버 왕복이라 updatedAt이 그때그때 최신으로 갱신된다(로컬에서
  // 직접 필드를 조작하는 건 실제 앱이 절대 하지 않는 방식이다).
  await pB.evaluate(() => detail('cp1'));
  await pB.waitForTimeout(150);
  await pB.fill('#visitNotes_cp1', 'B가 남긴 메모');
  await pB.click('[data-visit-notes="cp1"]');
  await pB.waitForTimeout(300);

  const serverVisit = await apiCall('/api/visits', { token: tokenA3 });
  const cp1Visit = serverVisit.json.visits.find((v) => v.placeId === 'cp1');
  t('(c) 오래된 기기가 재연결해도 이미 취소된 방문 날짜가 되살아나지 않음', !cp1Visit.visitedDates.some((d) => d.date === '2026-05-01'));
  t('(c) 방문 취소와 무관한 기기 B의 메모 수정은 그대로 반영됨(보수적 재병합)', cp1Visit.notes === 'B가 남긴 메모');
  await pA.close(); await pB.close();
}

// =====================================================================
// (d) 재-가져오기(재import)로 중복 장소가 병합돼도 방문 기록은 보존돼야
// 한다.
// =====================================================================
{
  const pA = await newPage('A4');
  await loginViaUi(pA, email);
  await pA.evaluate(() => {
    foodMap.places = [{ id: 'dup1', name: '중복장소', lat: 33.5, lng: 130.4, cat: '카페·디저트', catConfirmed: true, sourceLists: ['목록1'] }];
    A.saveFoodMap(foodMap);
  });
  await pA.reload();
  await pA.waitForTimeout(200);
  await pA.evaluate(() => detail('dup1'));
  await pA.waitForTimeout(150);
  await pA.click('[data-visit-mark="dup1"]');
  await pA.waitForTimeout(300);
  await pA.evaluate(() => document.getElementById('close').click());

  // 같은 이름·같은 좌표로 다시 가져오기 — A.merge는 실제 가져오기
  // 흐름(handleRealFile)과 똑같이 foodMap.places를 그 자리에서 직접
  // 고친다(반환값은 개수 통계일 뿐 새 배열이 아니다). 같은 이름+좌표는
  // 검증된 식별자로 봐서 기존 레코드(dup1)를 그대로 갱신한다 — 새 id로
  // 다시 만들어지지 않는다("병합됐다"는 뜻은 id가 안 늘어난다는 것).
  const csvText = 'name,note,lat,lng\n중복장소,,33.5,130.4\n';
  const merged = await pA.evaluate((csv) => {
    const rows = A.parseCsv(csv);
    const before = foodMap.places.length;
    const z = A.merge(rows, '목록2', foodMap.places);
    A.saveFoodMap(foodMap);
    return { added: z.added, updated: z.updated, count: foodMap.places.length, before };
  }, csvText);
  t('재가져오기로 같은 장소는 새 id로 안 늘어나고 기존 레코드가 갱신됨', merged.count === merged.before && merged.updated >= 1);
  await pA.reload();
  await pA.waitForTimeout(200);
  const visitStillThere = await pA.evaluate(() => (foodMap.visits || []).find((v) => v.placeId === 'dup1'));
  t('(d) 재가져오기 후에도 기존 장소(dup1)의 방문 기록이 그대로 남아 있음', !!(visitStillThere && visitStillThere.visited));
  await pA.close();
}

// =====================================================================
// (e) 계정 전환/로그아웃 시 다른 계정의 로컬 데이터가 새어나가면 안
// 된다 — 여행·방문 기록도 places/courses와 같은 격리 규칙을 따르는지.
// =====================================================================
{
  const emailC = 'sync-protect-account-c@example.com';
  const pC = await newPage('C');
  await loginViaUi(pC, emailC);
  await pC.evaluate(() => {
    foodMap.places = [{ id: 'ec1', name: 'C계정 장소', lat: 33.5, lng: 130.4, cat: '카페·디저트', catConfirmed: true, sourceLists: [] }];
    A.saveFoodMap(foodMap);
  });
  await pC.evaluate(() => daSyncPushSafe());
  await pC.waitForTimeout(200);
  const tokenC = await pC.evaluate(() => foodMap.session.token);
  await apiCall('/api/visits/ec1/mark', { method: 'POST', token: tokenC });
  await apiCall('/api/trips', { method: 'POST', token: tokenC, body: { city: 'C도시' } });

  await pC.evaluate(() => { const b2 = document.querySelector('[data-profile]'); if (b2) b2.click(); });
  await pC.waitForTimeout(200);
  await pC.evaluate(() => { const lo = document.querySelector('[data-logout]'); if (lo) lo.click(); });
  await pC.waitForTimeout(200);

  const afterLogoutTrips = await pC.evaluate(() => foodMap.trips);
  const afterLogoutVisits = await pC.evaluate(() => foodMap.visits);
  t('(e) 로그아웃하면 이 기기의 여행 기록도 로컬에서 지워짐', !afterLogoutTrips);
  t('(e) 로그아웃하면 이 기기의 방문 기록도 로컬에서 지워짐', !afterLogoutVisits);

  const emailD = 'sync-protect-account-d@example.com';
  await loginViaUi(pC, emailD);
  await pC.waitForTimeout(200);
  const dTrips = await pC.evaluate(() => (foodMap.trips || []).length);
  const dVisits = await pC.evaluate(() => (foodMap.visits || []).length);
  t('(e) 처음 로그인하는 계정 D에는 계정 C의 여행 기록이 전혀 안 보임', dTrips === 0);
  t('(e) 처음 로그인하는 계정 D에는 계정 C의 방문 기록이 전혀 안 보임', dVisits === 0);
  await pC.close();
}

// =====================================================================
// (f) 서버 저장 실패가 성공으로 표시되지 않고, 다시 시도할 수 있어야
// 한다 — 여행 만들기 화면에서 서버 오류를 실제로 흉내내 확인.
// =====================================================================
{
  const pF = await newPage('F');
  await loginViaUi(pF, email);
  await pF.waitForTimeout(200);
  await pF.evaluate((cityName) => { city = cityName; updateCity(); }, '실패시나리오도시');
  await pF.waitForTimeout(150);
  // 이 도시엔 아직 여행이 하나도 없어 오늘 동선 화면엔 "새 여행
  // 만들기" 버튼이 안 뜬다(첫 여행은 코스 생성 때 조용히 자동 생성 —
  // tripBlockHTML 설계) — 여기서 검증할 건 "여행 만들기 화면 자체의
  // 실패 처리"이므로 그 화면을 직접 연다.
  await pF.evaluate((cityName) => newTripFormSheet(cityName), '실패시나리오도시');
  await pF.waitForTimeout(150);
  await pF.route('**/api/trips', (route) => route.fulfill({ status: 500, body: '{}' }), { times: 1 });
  await pF.click('#tripCreateBtn');
  await pF.waitForTimeout(400);
  const msgText = await pF.textContent('#tripMsg').catch(() => '');
  t('(f) 여행 만들기가 서버 오류로 실패하면 성공한 것처럼 넘어가지 않고 화면에 실패로 남음', /만들지 못했/.test(msgText));
  const tripsAfterFail = await pF.evaluate(() => (foodMap.trips || []).filter((tr) => tr.city === '실패시나리오도시').length);
  t('(f) 실패한 여행 만들기는 로컬에도 저장되지 않음(반쯤 반영된 상태 없음)', tripsAfterFail === 0);
  await pF.unroute('**/api/trips');
  // 재시도하면 정상적으로 성공해야 한다(막혀 있지 않음).
  await pF.click('#tripCreateBtn');
  await pF.waitForTimeout(400);
  const tripsAfterRetry = await pF.evaluate(() => (foodMap.trips || []).filter((tr) => tr.city === '실패시나리오도시').length);
  t('(f) 실패 후에도 같은 화면에서 바로 재시도해 성공할 수 있음', tripsAfterRetry === 1);
  await pF.close();
}

t('최종 콘솔/런타임 오류 0', errs.length === 0);
if (errs.length) console.log('  ', errs.slice(0, 10));

await b.close();
server.close();
console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
process.exit(fail ? 1 : 0);
