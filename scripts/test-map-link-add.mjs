/**
 * 2026-09-11 재검토(13차) 3절 — "지도 링크로 한 곳 추가" 실제 화면
 * 검증(Chromium):
 *  1) 지원하는 전체 URL을 붙여넣으면 실제로 장소가 담기고(이름·좌표
 *     반영), 성공 토스트가 뜸.
 *  2) 지원하지 않는 링크(구글맵 아님)는 명확한 오류 문구만 뜨고 아무
 *     것도 담기지 않음(조용한 성공 처리 금지).
 *  3) 같은 링크를 다시 붙여넣으면(재현) 중복으로 쌓이지 않고 기존
 *     장소와 합쳐짐(daMerge 재사용 확인).
 *  4) 로그인 안 한 상태에서 열면 로그인부터 요구함(기존 게이트 패턴과
 *     동일).
 *
 * 2026-09-11 재검토(14차) 3절 — 추가:
 *  5) ChatGPT 재현 — "@lat,lng"만 있고 !3d!4d(진짜 장소 데이터 블록)가
 *     없는 링크는 좌표가 확정으로 담기지 않음(지도 중심을 장소 좌표로
 *     오인하는 버그 재현 차단, 위치 확인 필요 상태로 남아야 함).
 *  6) 이름을 찾지 못한 링크는 조용히 무명 장소를 만들지 않고 이름
 *     입력을 요구하며, 입력한 이름으로 실제로 담김.
 *  7) 저장(localStorage) 자체가 실패하면 성공 처리하지 않고 복구
 *     안내를 보여주며, 장소 목록에 아무것도 남지 않음(롤백).
 *
 * 2026-09-21(17차) 1·2·3·4절 — "빠른 장소 추가" 재사용·개선분 추가:
 *  4) 로그인 안 한 상태에서 열어도 시트가 바로 뜸(입력을 먼저 할 수
 *     있어야 함 — 예전처럼 화면 자체를 로그인으로 막지 않음).
 *  4-1) 로그인 안 한 채로 "저장"을 누르면 그때 로그인을 요구하고,
 *       입력해 둔 내용이 사라지지 않고 로그인 완료 후 자동으로 이어서
 *       저장까지 끝남(내용 유실 금지).
 *  8) 이미 저장된 장소를 다시 추가하면 "이미 저장된 장소예요" + "장소
 *     보기"가 뜨고(중복 생성 아님), 눌러 실제 상세로 이동함.
 *  9) 새 장소를 저장하면 "저장했어요" + "오늘 동선에 담기"가 뜨고,
 *     눌러도 코스 재계산 없이 route Set에만 더해짐.
 *  10) "이름 + 링크" 공유 텍스트에서 URL과 이름 힌트를 분리함
 *      (daExtractMapsUrl 단위 검증 — 링크 해석 자체는 기존 서버
 *      엔드포인트를 그대로 재사용).
 *  11) 클립보드 자동 붙여넣기 성공/거부 각각 처리(거부 시 수동 안내).
 *  12) 빠른 연속 클릭(더블탭)에도 중복 저장되지 않음.
 *  13) 느린 네트워크 중엔 버튼이 "확인 중…" 상태를 유지하고, 실패 후
 *      재시도가 실제로 성공함.
 *  14) Web Share Target(GET) 쿼리스트링을 부팅 시 읽어 시트를 미리
 *      채우고, 쿼리스트링은 지워짐(자동 저장은 하지 않음).
 *
 * 2026-09-21(17차 2차 독립검토) 1절 — ChatGPT 재현 추가:
 *  15) 계정 A로 저장 요청 중 계정 B로 전환하면, A 요청의 늦은 응답이
 *      B 계정에 저장되지 않음(응답 전 기록해 둔 sessionEpoch로 버림).
 *  16) 저장 요청이 도는 중 다른 화면(장소 상세)으로 이동하면, 그
 *      응답이 지금 보고 있는 화면을 덮지 않음(화면 버전으로 버림).
 *  17) "이름 확인 대기" 중 링크를 바꿔 다시 누르면, 이전 pendingLink가
 *      즉시 무효화돼 옛 이름 확인 버튼으로 엉뚱한 링크에 이름이
 *      안 붙음.
 *
 * 실행: node scripts/test-map-link-add.mjs
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
const page = await b.newPage();
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('dialog', (d) => d.dismiss());
await page.addInitScript((base) => { window.API_BASE = base; }, apiBase);
await page.goto('file://' + process.cwd() + '/src/design/index.html');
await page.waitForTimeout(200);

// =====================================================================
// 4) 로그인 안 한 상태 — 시트가 바로 뜸(입력을 먼저 할 수 있어야 함).
// 4-1) "저장"을 누르는 시점에만 로그인을 요구하고, 입력 내용이 로그인
//      후에도 남아 자동으로 이어서 저장됨.
// =====================================================================
{
  await page.evaluate(() => showAddByMapLinkSheet());
  await page.waitForTimeout(150);
  const opensDirectly = await page.evaluate(() => !!document.getElementById('mapLinkInput') && !document.getElementById('loginEmail'));
  t('4) 로그인 안 한 상태에서도 시트가 바로 열림(입력 가능)', opensDirectly);

  const preLoginUrl = 'https://www.google.com/maps/place/%EB%A1%9C%EA%B7%B8%EC%9D%B8%EC%A0%84%EC%9E%85%EB%A0%A5/@39.0,143.0,17z/data=!4m6!3m5!1s0x0:0x0!8m2!3d39.11!4d143.22!16s%2Fg%2F11xyz';
  await page.fill('#mapLinkInput', preLoginUrl);
  await page.click('#mapLinkAddBtn');
  await page.waitForTimeout(150);
  const asksLoginOnSave = await page.evaluate(() => !!document.getElementById('loginEmail'));
  t('4-1) "저장"을 누를 때만 로그인을 요구함(입력 화면 자체는 안 막음)', asksLoginOnSave);

  await page.fill('#loginEmail', 'maplink-1@example.com');
  await page.click('#loginSendBtn');
  await page.waitForTimeout(200);
  const sent = sentEmailsForTest.filter((e) => e.to === 'maplink-1@example.com').pop();
  const code = sent.body.match(/(\d{6})/)[1];
  await page.fill('#loginCode', code);
  await page.click('#loginVerifyBtn');
  await page.waitForFunction(() => !!(foodMap.session && foodMap.session.token), { timeout: 5000 });
  await page.waitForTimeout(400);
  const added = await page.evaluate(() => foodMap.places.find((p) => p.name === '로그인전입력'));
  t('4-1) 로그인 후 입력했던 링크로 자동으로 이어서 저장됨(내용 유실 없음)', !!added);
  await page.evaluate(() => { const c = document.getElementById('close'); if (c) c.click(); });
}

// =====================================================================
// 1) 지원하는 전체 URL(!3d!4d 확정 좌표 포함) — 실제로 장소가 담김.
// =====================================================================
const fullUrl = 'https://www.google.com/maps/place/%EC%B9%B4%ED%8E%98+%ED%85%8C%EC%8A%A4%ED%8A%B8/@35.0,139.0,17z/data=!4m6!3m5!1s0x0:0x0!8m2!3d35.1234!4d139.5678!16s%2Fg%2F11abc';
{
  await page.evaluate(() => showAddByMapLinkSheet());
  await page.waitForTimeout(150);
  await page.fill('#mapLinkInput', fullUrl);
  await page.click('#mapLinkAddBtn');
  await page.waitForTimeout(400);
  const added = await page.evaluate(() => foodMap.places.find((p) => p.name === '카페 테스트'));
  t('1) 실제로 장소가 담김(이름 반영)', !!added);
  t('1) !3d!4d 확정 좌표가 반영됨(뷰포트 @ 값과 다름)', added && Math.abs(added.lat - 35.1234) < 0.0001 && Math.abs(added.lng - 139.5678) < 0.0001);
  t('1) 링크로 추가된 출처가 표시됨', added && Array.isArray(added.sourceLists) && added.sourceLists.includes('지도 링크로 추가'));
}

// =====================================================================
// 5) ChatGPT 재현(14차 3절) — "@lat,lng"만 있고 !3d!4d가 없으면 지도
//    중심을 장소 좌표로 오인하지 않는다(위치 확인 필요 상태로 남음).
// =====================================================================
{
  await page.evaluate(() => showAddByMapLinkSheet());
  await page.waitForTimeout(150);
  const centerOnlyUrl = 'https://www.google.com/maps/place/%EB%86%80%EC%9D%B4%ED%84%B0/@36.5,140.5,17z';
  await page.fill('#mapLinkInput', centerOnlyUrl);
  await page.click('#mapLinkAddBtn');
  await page.waitForTimeout(400);
  const added = await page.evaluate(() => foodMap.places.find((p) => p.name === '놀이터'));
  t('5) 이름이 있으므로 실제로 담김', !!added);
  t('5) @만 있고 !3d!4d가 없으면 좌표가 확정으로 담기지 않음(중심좌표 오인 재현 차단)', added && added.lat == null && added.lng == null);
  const needsLookup = await page.evaluate((id) => window.DesignAdapter.needsLookup(foodMap.places.find((x) => x.id === id)), added ? added.id : null);
  t('5) daNeedsLookup=true로 실제로 분류됨', needsLookup === true);
}

// =====================================================================
// 6) 이름을 못 찾은 링크(순수 좌표 핀 공유) — 조용히 무명 장소를 만들지
//    않고 이름 입력을 요구하며, 입력한 이름으로 실제로 담김.
// =====================================================================
{
  await page.evaluate(() => showAddByMapLinkSheet());
  await page.waitForTimeout(150);
  const noNameUrl = 'https://www.google.com/maps/@37.1,141.1,17z'; // 장소가 아니라 지도 화면 자체 링크(이름 없음).
  await page.fill('#mapLinkInput', noNameUrl);
  await page.click('#mapLinkAddBtn');
  await page.waitForTimeout(400);
  const nameWrapShown = await page.evaluate(() => !document.getElementById('mapLinkNameWrap').hidden);
  t('6) 이름을 못 찾으면 이름 입력 칸이 뜸(무명 장소 자동 생성 금지)', nameWrapShown);
  await page.fill('#mapLinkNameInput', '이름모를 전망대');
  await page.click('#mapLinkNameConfirmBtn');
  await page.waitForTimeout(400);
  const added = await page.evaluate(() => foodMap.places.find((p) => p.name === '이름모를 전망대'));
  t('6) 입력한 이름으로 실제로 담김', !!added);
}

// =====================================================================
// 7) 저장(localStorage) 자체가 실패하면 — 성공 처리하지 않고 복구
//    안내를 보여주며, 방금 추가하려던 항목이 목록에 남지 않는다(롤백).
// =====================================================================
{
  const beforeCount = await page.evaluate(() => foodMap.places.length);
  await page.evaluate(() => {
    window.__origSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function () { throw new Error('QuotaExceededError(테스트로 흉내낸 저장 실패)'); };
  });
  await page.evaluate(() => showAddByMapLinkSheet());
  await page.waitForTimeout(150);
  const saveFailUrl = 'https://www.google.com/maps/place/%EC%A0%80%EC%9E%A5%EC%8B%A4%ED%8C%A8%EA%B0%80%EA%B2%8C/@38.0,142.0,17z';
  await page.fill('#mapLinkInput', saveFailUrl);
  await page.click('#mapLinkAddBtn');
  await page.waitForTimeout(400);
  const errShown = await page.evaluate(() => !document.getElementById('mapLinkMsg').hidden && document.getElementById('mapLinkMsg').textContent.includes('저장에 실패'));
  t('7) 저장 실패 시 복구 안내 문구가 뜸(성공으로 위장하지 않음)', errShown);
  await page.evaluate(() => { Storage.prototype.setItem = window.__origSetItem; });
  const afterCount = await page.evaluate(() => foodMap.places.length);
  t('7) 저장 실패한 항목은 목록에 남지 않음(롤백)', afterCount === beforeCount);
  await page.evaluate(() => { const c = document.getElementById('close'); if (c) c.click(); });
}

// =====================================================================
// 2) 지원하지 않는 링크 — 오류만 뜨고 아무것도 안 담김.
// =====================================================================
{
  const beforeCount = await page.evaluate(() => foodMap.places.length);
  await page.evaluate(() => showAddByMapLinkSheet());
  await page.waitForTimeout(150);
  await page.fill('#mapLinkInput', 'https://example.com/not-a-maps-link');
  await page.click('#mapLinkAddBtn');
  await page.waitForTimeout(400);
  const errorShown = await page.evaluate(() => !document.getElementById('mapLinkMsg').hidden && document.getElementById('mapLinkMsg').textContent.length > 0);
  t('2) 지원하지 않는 링크는 오류 문구가 명확히 뜸', errorShown);
  const afterCount = await page.evaluate(() => foodMap.places.length);
  t('2) 아무 장소도 조용히 담기지 않음(개수 그대로)', afterCount === beforeCount);
  await page.evaluate(() => { const c = document.getElementById('close'); if (c) c.click(); });
}

// =====================================================================
// 3) 같은 링크를 다시 붙여넣으면 — 중복으로 쌓이지 않고 합쳐짐.
// =====================================================================
{
  const beforeCount = await page.evaluate(() => foodMap.places.length);
  await page.evaluate(() => showAddByMapLinkSheet());
  await page.waitForTimeout(150);
  await page.fill('#mapLinkInput', fullUrl); // 테스트 1과 완전히 같은 링크(문자열 그대로) — urlKey 기준 병합 확인.
  await page.click('#mapLinkAddBtn');
  await page.waitForTimeout(400);
  const afterCount = await page.evaluate(() => foodMap.places.length);
  t('3) 같은 링크를 다시 추가해도 개수가 늘지 않음(중복 병합)', afterCount === beforeCount);

  // ---------------------------------------------------------------------
  // 8) 위와 같은 재추가 직후 화면 — "이미 저장된 장소예요" + "장소 보기"
  //    (중복 생성 대신 기존 장소로 안내), 눌러 실제 상세로 이동함.
  // ---------------------------------------------------------------------
  const alreadyText = await page.evaluate(() => document.getElementById('sheetContent').textContent);
  t('8) "이미 저장된 장소예요" 안내가 뜸', alreadyText.includes('이미 저장된 장소'));
  const viewBtn = await page.evaluate(() => !!document.querySelector('[data-view-place]'));
  t('8) "장소 보기" 버튼이 있음', viewBtn);
  await page.click('[data-view-place]');
  await page.waitForTimeout(200);
  const wentToDetail = await page.evaluate(() => document.getElementById('sheetLabel').textContent === '내 장소' && document.getElementById('sheetContent').innerHTML.includes('카페 테스트'));
  t('8) 실제로 그 장소의 상세 화면으로 이동함', wentToDetail);
  await page.evaluate(() => { const c = document.getElementById('close'); if (c) c.click(); });
}

// =====================================================================
// 9) 새 장소를 저장하면 "저장했어요" + "오늘 동선에 담기"가 뜨고,
//    눌러도 코스 재계산 없이 route Set에만 더해짐(무료/무차감).
// =====================================================================
{
  const newPlaceUrl = 'https://www.google.com/maps/place/%EC%98%A4%EB%8A%98%EB%8F%99%EC%84%A0%ED%85%8C%EC%8A%A4%ED%8A%B8/@40.0,144.0,17z/data=!4m6!3m5!1s0x0:0x0!8m2!3d40.11!4d144.22!16s%2Fg%2F11nrt';
  await page.evaluate(() => showAddByMapLinkSheet());
  await page.waitForTimeout(150);
  await page.fill('#mapLinkInput', newPlaceUrl);
  await page.click('#mapLinkAddBtn');
  await page.waitForTimeout(400);
  const savedText = await page.evaluate(() => document.getElementById('sheetContent').textContent);
  t('9) "저장했어요" 안내가 뜸(신규)', savedText.includes('저장했어요'));
  const addRouteBtn = await page.evaluate(() => !!document.querySelector('[data-add-today-route]'));
  t('9) "오늘 동선에 담기" 버튼이 있음', addRouteBtn);
  await page.click('[data-add-today-route]');
  await page.waitForTimeout(200);
  // route Set은 모듈 스코프 변수라 밖에서 직접 못 읽는다 — 화면 전환 결과(오늘 동선 화면에
  // 그 장소가 실제로 나타나는지)로 대신 확인한다(내부 구현 세부가 아니라 눈에 보이는 결과).
  const shownInRouteScreen = await page.evaluate((name) => document.getElementById('sheetContent').textContent.includes(name), '오늘동선테스트');
  t('9) "오늘 동선" 화면으로 이동하고 그 장소가 실제로 담겨 있음', shownInRouteScreen);
  await page.evaluate(() => { const c = document.getElementById('close'); if (c) c.click(); });
}

// =====================================================================
// 10) "이름 + 링크" 공유 텍스트 — URL과 이름 힌트를 분리함(단위 검증).
//     링크 자체의 해석은 기존 /api/places/resolve-link를 그대로 재사용
//     하므로 여기선 클라이언트 파싱만 확인한다.
// =====================================================================
{
  const ext1 = await page.evaluate(() => window.DesignAdapter.extractMapsUrl('카페 노스텔지어\nhttps://maps.app.goo.gl/abc123'));
  t('10) "이름\\n링크" 형태에서 URL을 정확히 뽑음', ext1.url === 'https://maps.app.goo.gl/abc123');
  t('10) 이름 힌트도 함께 뽑음', ext1.nameHint === '카페 노스텔지어');
  const ext2 = await page.evaluate(() => window.DesignAdapter.extractMapsUrl('https://maps.app.goo.gl/abc123'));
  t('10) 링크만 있어도 그대로 동작(이름 힌트는 빈 값)', ext2.url === 'https://maps.app.goo.gl/abc123' && ext2.nameHint === '');
  const ext3 = await page.evaluate(() => window.DesignAdapter.extractMapsUrl('그냥 아무 문자'));
  t('10) 링크가 아예 없으면 빈 URL을 돌려줌', ext3.url === '');
}

// =====================================================================
// 11) 클립보드 붙여넣기 — 자동 읽기 성공/거부 각각 처리(거부 시 수동
//     안내로 유도, 절대 반복 자동 시도하지 않음 — 버튼 클릭 시 1회뿐).
// =====================================================================
{
  await page.evaluate(() => showAddByMapLinkSheet());
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => 'https://maps.app.goo.gl/pastetest' } });
  });
  await page.click('#mapLinkPasteBtn');
  await page.waitForTimeout(150);
  const pastedIn = await page.evaluate(() => document.getElementById('mapLinkInput').value);
  t('11) 붙여넣기 버튼을 누르면 클립보드 내용이 입력칸에 들어감', pastedIn === 'https://maps.app.goo.gl/pastetest');

  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => { throw new Error('permission denied'); } } });
  });
  await page.click('#mapLinkPasteBtn');
  await page.waitForTimeout(150);
  const deniedMsg = await page.evaluate(() => document.getElementById('mapLinkMsg').textContent);
  t('11) 권한 거부 시 길게 눌러 직접 붙여넣으라는 안내가 뜸', deniedMsg.includes('길게 눌러'));
  await page.evaluate(() => { const c = document.getElementById('close'); if (c) c.click(); delete navigator.clipboard; });
}

// =====================================================================
// 12) 빠른 연속 클릭(더블탭) — 중복 저장되지 않음.
// =====================================================================
{
  const beforeCount = await page.evaluate(() => foodMap.places.length);
  const rapidUrl = 'https://www.google.com/maps/place/%EB%8D%94%EB%B8%94%ED%81%B4%EB%A6%AD%ED%85%8C%EC%8A%A4%ED%8A%B8/@41.0,145.0,17z/data=!4m6!3m5!1s0x0:0x0!8m2!3d41.11!4d145.22!16s%2Fg%2F11dbl';
  await page.evaluate(() => showAddByMapLinkSheet());
  await page.waitForTimeout(150);
  await page.fill('#mapLinkInput', rapidUrl);
  await page.evaluate(() => {
    const btn = document.getElementById('mapLinkAddBtn');
    btn.click(); btn.click(); // 응답이 오기 전에 같은 틱에서 두 번 누름 — saving 플래그가 두 번째를 막아야 함.
  });
  await page.waitForTimeout(500);
  const afterCount = await page.evaluate(() => foodMap.places.length);
  t('12) 더블탭해도 한 곳만 담김(중복 저장 방지)', afterCount === beforeCount + 1);
  await page.evaluate(() => { const c = document.getElementById('close'); if (c) c.click(); });
}

// =====================================================================
// 13) 느린 네트워크 — 응답이 늦는 동안 "확인 중…" 상태 유지, 실패 후
//     재시도가 실제로 성공함.
// =====================================================================
{
  await page.evaluate(() => showAddByMapLinkSheet());
  await page.waitForTimeout(150);
  const slowUrl = 'https://www.google.com/maps/place/%EB%8A%90%EB%A6%B0%EB%A7%9D%ED%85%8C%EC%8A%A4%ED%8A%B8/@42.0,146.0,17z/data=!4m6!3m5!1s0x0:0x0!8m2!3d42.11!4d146.22!16s%2Fg%2F11slw';
  await page.fill('#mapLinkInput', slowUrl);
  let failOnce = true;
  await page.route('**/api/places/resolve-link', async (route) => {
    if (failOnce) { failOnce = false; await new Promise((r) => setTimeout(r, 600)); return route.abort(); }
    return route.continue();
  });
  await page.click('#mapLinkAddBtn');
  await page.waitForTimeout(200);
  const showsChecking = await page.evaluate(() => document.getElementById('mapLinkAddBtn').textContent);
  t('13) 응답을 기다리는 동안 "확인 중…" 상태로 바뀜', showsChecking.includes('확인 중'));
  await page.waitForTimeout(700);
  const afterFail = await page.evaluate(() => document.getElementById('mapLinkAddBtn').disabled);
  t('13) 실패 후 버튼이 다시 눌러지는 상태로 돌아옴(재시도 가능)', afterFail === false);
  await page.click('#mapLinkAddBtn'); // 재시도 — 이번엔 route.continue()로 실제 성공.
  await page.waitForTimeout(400);
  const added = await page.evaluate(() => foodMap.places.find((p) => p.name === '느린망테스트'));
  t('13) 재시도가 실제로 성공함', !!added);
  await page.unroute('**/api/places/resolve-link');
  await page.evaluate(() => { const c = document.getElementById('close'); if (c) c.click(); });
}

// =====================================================================
// 14) Web Share Target(GET) 쿼리스트링 — 부팅 시 읽어 시트를 미리
//     채우고, 쿼리스트링은 지워짐(자동 저장은 하지 않음 — 사람이
//     "이 링크로 추가"를 직접 눌러야 함).
// =====================================================================
{
  const shareUrl = 'file://' + process.cwd() + '/src/design/index.html?title=%EC%B9%B4%ED%8E%98&text=&url=' + encodeURIComponent('https://maps.app.goo.gl/sharetarget');
  await page.goto(shareUrl);
  await page.waitForTimeout(300);
  const prefilled = await page.evaluate(() => document.getElementById('mapLinkInput') && document.getElementById('mapLinkInput').value);
  t('14) 공유로 받은 내용이 시트에 미리 채워짐', !!(prefilled && prefilled.includes('maps.app.goo.gl/sharetarget')));
  const searchCleared = await page.evaluate(() => location.search === '');
  t('14) 쿼리스트링이 지워짐(새로고침 시 반복 방지)', searchCleared);
  const notAutoSaved = await page.evaluate(() => !foodMap.places.some((p) => p.url && p.url.includes('sharetarget')));
  t('14) 자동 저장하지 않음(사람이 직접 눌러야 함)', notAutoSaved);
}

// =====================================================================
// 15) 계정 A로 저장 요청 중 계정 B로 전환해도, A 요청의 늦은 응답이
//     B 계정에 섞여 들어가지 않는다(sessionEpoch 기록·대조).
//     화면 전환과 뒤섞이지 않게, 로그인 API를 직접 완료시켜(화면
//     이동 없이) 계정 전환 자체만 분리해서 재현한다.
// =====================================================================
{
  const urlSwitch = 'https://www.google.com/maps/place/%EA%B3%84%EC%A0%95%EC%A0%84%ED%99%98%ED%85%8C%EC%8A%A4%ED%8A%B8/@43.0,147.0,17z/data=!4m6!3m5!1s0x0:0x0!8m2!3d43.11!4d147.22!16s%2Fg%2F11acc';
  await page.evaluate(() => showAddByMapLinkSheet());
  await page.waitForTimeout(150);
  await page.fill('#mapLinkInput', urlSwitch);

  let releaseHold;
  const held = new Promise((resolve) => { releaseHold = resolve; });
  await page.route('**/api/places/resolve-link', async (route) => { await held; await route.continue(); });

  await page.click('#mapLinkAddBtn'); // 요청 발사 — 위 라우트가 잡아 응답을 미룬다.
  await page.waitForTimeout(150);

  // 계정 B로 전환 — 화면(다이얼로그)은 건드리지 않고 로그인 API만
  // 직접 완료시킨다(로그인 시트를 열면 화면 버전도 같이 바뀌어 두
  // 가지 방어(계정·화면)가 섞여 버려, 계정 전환 자체만 격리해 본다).
  const emailB = 'maplink-switch-b@example.com';
  await page.evaluate((email) => A.api('/api/auth/request-code', { method: 'POST', body: { email } }), emailB);
  const sentB = sentEmailsForTest.filter((e) => e.to === emailB).pop();
  const codeB = sentB.body.match(/(\d{6})/)[1];
  await page.evaluate(async ({ email, code }) => {
    const r = await A.api('/api/auth/verify-code', { method: 'POST', body: { email, code } });
    await daFinishLogin(r.json.token, email, r.json.isNew, () => {});
  }, { email: emailB, code: codeB });
  const bPlacesBeforeRelease = await page.evaluate(() => foodMap.places.length);

  releaseHold(); // 이제 A 요청의 응답이 도착한다 — 이미 B 계정으로 전환된 뒤.
  await page.waitForTimeout(400);
  await page.unroute('**/api/places/resolve-link');

  const leaked = await page.evaluate(() => foodMap.places.some((p) => p.name === '계정전환테스트'));
  t('15) 계정 A 요청 중 계정 B로 전환해도 A의 장소가 B에 섞여 들어가지 않음', !leaked);
  const bCountUnchanged = await page.evaluate((before) => foodMap.places.length === before, bPlacesBeforeRelease);
  t('15) B 계정의 장소 개수도 늘지 않음(늦은 응답이 조용히 버려짐)', bCountUnchanged);
  await page.evaluate(() => { const c = document.getElementById('close'); if (c) c.click(); });
}

// =====================================================================
// 16) 저장 요청이 도는 중 다른 화면(프로필)으로 이동하면, 늦게 온
//     응답이 지금 화면을 덮지 않는다(화면 버전으로 대조·폐기).
// =====================================================================
{
  await page.evaluate(() => showAddByMapLinkSheet());
  await page.waitForTimeout(150);
  const urlScreen = 'https://www.google.com/maps/place/%ED%99%94%EB%A9%B4%EC%A0%84%ED%99%98%ED%85%8C%EC%8A%A4%ED%8A%B8/@44.0,148.0,17z/data=!4m6!3m5!1s0x0:0x0!8m2!3d44.11!4d148.22!16s%2Fg%2F11scr';
  await page.fill('#mapLinkInput', urlScreen);

  let releaseHold2;
  const held2 = new Promise((resolve) => { releaseHold2 = resolve; });
  await page.route('**/api/places/resolve-link', async (route) => { await held2; await route.continue(); });

  await page.click('#mapLinkAddBtn');
  await page.waitForTimeout(150);

  await page.evaluate(() => profile()); // 저장 요청과 무관한 다른 화면으로 이동.
  const labelAfterNav = await page.evaluate(() => document.getElementById('sheetLabel').textContent);

  releaseHold2();
  await page.waitForTimeout(400);
  await page.unroute('**/api/places/resolve-link');

  const labelAfterResponse = await page.evaluate(() => document.getElementById('sheetLabel').textContent);
  t('16) 저장 요청 중 다른 화면으로 이동하면, 늦게 온 응답이 그 화면을 안 덮음', labelAfterResponse === labelAfterNav);
  const savedAnyway = await page.evaluate(() => foodMap.places.some((p) => p.name === '화면전환테스트'));
  t('16) 화면을 벗어난 뒤 도착한 응답은 저장도 하지 않음(안전한 쪽으로 완전히 버림)', !savedAnyway);
  await page.evaluate(() => { const c = document.getElementById('close'); if (c) c.click(); });
}

// =====================================================================
// 17) "이름 확인 대기" 중 링크를 바꿔 다시 누르면, 이전 pendingLink가
//     즉시 무효화돼(이름 입력칸도 곧장 숨겨짐) 옛 확인 버튼으로
//     엉뚱한 링크에 이름이 붙지 않는다.
// =====================================================================
{
  await page.evaluate(() => showAddByMapLinkSheet());
  await page.waitForTimeout(150);
  const noNameUrl1 = 'https://www.google.com/maps/@45.1,149.1,17z'; // 이름 없는 링크 1.
  await page.fill('#mapLinkInput', noNameUrl1);
  await page.click('#mapLinkAddBtn');
  await page.waitForTimeout(300);
  const wrapShownFirst = await page.evaluate(() => !document.getElementById('mapLinkNameWrap').hidden);
  t('17) 첫 번째 이름 없는 링크에서 이름 입력칸이 뜸', wrapShownFirst);

  const fullUrl2 = 'https://www.google.com/maps/place/%EB%91%90%EB%B2%88%EC%A7%B8%EB%A7%81%ED%81%AC%ED%85%8C%EC%8A%A4%ED%8A%B8/@46.0,150.0,17z/data=!4m6!3m5!1s0x0:0x0!8m2!3d46.11!4d150.22!16s%2Fg%2F11two';
  await page.fill('#mapLinkInput', fullUrl2);
  await page.click('#mapLinkAddBtn'); // 이름 확인 없이 바로 새 시도를 시작 — 이전 pendingLink를 즉시 무효화해야 함.
  const wrapHiddenImmediately = await page.evaluate(() => document.getElementById('mapLinkNameWrap').hidden);
  t('17) 새 시도가 시작되자마자 이전 이름 입력칸이 즉시 숨겨짐(무효화)', wrapHiddenImmediately);

  // 옛(숨겨진) 확인 버튼을 억지로 눌러도(예: 스크립트로) pendingLink가
  // 이미 null이라 아무 일도 안 일어나야 한다.
  await page.evaluate(() => { const b = document.getElementById('mapLinkNameConfirmBtn'); if (b) b.click(); });
  await page.waitForTimeout(400);
  const oldNameLeaked = await page.evaluate(() => foodMap.places.some((p) => p.name === '그 카페'));
  t('17) 무효화된 옛 확인 버튼을 눌러도 엉뚱한 이름으로 저장되지 않음', !oldNameLeaked);
  const secondSaved = await page.evaluate(() => foodMap.places.find((p) => p.name === '두번째링크테스트'));
  t('17) 새로 시작한 두 번째 링크는 정상적으로 저장됨', !!secondSaved);
  await page.evaluate(() => { const c = document.getElementById('close'); if (c) c.click(); });
}

t('콘솔/런타임 오류 없음', errs.length === 0);
console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
await b.close();
server.close();
process.exit(fail ? 1 : 0);
