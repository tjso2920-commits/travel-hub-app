/**
 * 한국에서 현지 위치인 것처럼 테스트하는 모드(2026-09-11 재검토 9차
 * 6-3절) 검증 — 실제 Chromium + 실제 index.html.
 *
 * 실행: node scripts/test-test-location-mode.mjs
 */
import { chromium } from 'playwright';

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('dialog', (d) => d.dismiss());

// =====================================================================
// 1. ?testmode=1 없이 들어오면 테스트 위치 기능이 전혀 안 보인다.
// =====================================================================
await p.goto('file://' + process.cwd() + '/src/design/index.html');
await p.waitForTimeout(200);
const allowedBefore = await p.evaluate(() => A.testModeAllowed());
t('1) testmode 파라미터 없이는 테스트 모드가 잠겨 있음', allowedBefore === false);
await p.evaluate(() => { profile(); });
await p.waitForTimeout(150);
const hasTestSectionLocked = await p.locator('#sheetContent:has-text("테스트 위치(개발자 전용)")').count();
t('1) 잠금 상태에서는 프로필에 테스트 위치 섹션이 아예 안 보임', hasTestSectionLocked === 0);
await p.evaluate(() => { sheet.close(); });

// =====================================================================
// 2. ?testmode=1로 한 번 들어오면 이 브라우저에 계속 풀린다(재방문/
//    새로고침에도 유지) — 실제 GPS를 흉내 내지 않는다는 문구도 확인.
// =====================================================================
await p.goto('file://' + process.cwd() + '/src/design/index.html?testmode=1');
await p.waitForTimeout(200);
const allowedAfterUnlock = await p.evaluate(() => A.testModeAllowed());
t('2) ?testmode=1로 들어오면 잠금이 풀림', allowedAfterUnlock === true);
await p.goto('file://' + process.cwd() + '/src/design/index.html'); // 파라미터 없이 재방문.
await p.waitForTimeout(200);
const allowedAfterReload = await p.evaluate(() => A.testModeAllowed());
t('2) 파라미터 없이 다시 들어와도(같은 브라우저) 계속 풀려 있음', allowedAfterReload === true);
await p.evaluate(() => { profile(); });
await p.waitForTimeout(150);
const sectionText = await p.locator('#sheetContent').innerText();
t('2) 풀린 상태에서는 테스트 위치 섹션이 실제로 보임', sectionText.includes('테스트 위치(개발자 전용)'));
t('2) 실제 GPS를 흉내 내지 않는다는 문구가 실제로 있음', sectionText.includes('실제 GPS를 흉내 내지 않습니다'));

// =====================================================================
// 3. 하카타역 프리셋을 고르면 실제로 저장되고, 화면 상단 배너가
//    "테스트 위치 사용 중"으로 바뀐다(실제 위치 아님을 항상 밝힘).
// =====================================================================
await p.click('[data-test-loc-preset="hakata"]');
await p.waitForTimeout(150);
const bannerVisible = await p.locator('#testLocationBanner').isVisible();
const bannerText = await p.locator('#testLocationBannerText').innerText();
t('3) 프리셋 선택 후 배너가 실제로 나타남', bannerVisible);
t('3) 배너에 "실제 위치 아님"이 명시됨(현지 GPS 검증으로 오인 방지)', bannerText.includes('실제 위치 아님'));
t('3) 배너에 고른 지점 이름이 실제로 들어감', bannerText.includes('하카타역'));

// =====================================================================
// 4. 거리순 정렬이 테스트 위치를 기준으로 실제로 동작한다 — 하카타역에
//    가까운 곳이 먼 곳보다 먼저 온다.
// =====================================================================
await p.evaluate(() => {
  const cityName = '후쿠오카';
  foodMap.places = [
    { id: 'far1', name: '먼곳', cat: '기타', catConfirmed: true, city: cityName, cityKnown: true, cityConfirmed: true, sourceLists: [], lat: 34.5, lng: 131.5 },
    { id: 'near1', name: '하카타역 근처', cat: '기타', catConfirmed: true, city: cityName, cityKnown: true, cityConfirmed: true, sourceLists: [], lat: 33.5906, lng: 130.4209 },
  ];
  A.saveFoodMap(foodMap);
});
await p.reload();
await p.waitForTimeout(200);
await p.evaluate(() => { city = '후쿠오카'; updateCity(); });
await p.waitForTimeout(100);
await p.selectOption('#sortSelect', 'distance');
await p.waitForTimeout(100);
const firstCard = await p.locator('#grid .spot h3').first().innerText();
const basisText = await p.locator('#sortBasisNote').innerText();
t('4) 테스트 위치(하카타역) 기준으로 가까운 곳이 먼저 옴', firstCard === '하카타역 근처');
t('4) 거리순 기준 문구가 테스트 위치임을 실제로 밝힘', basisText.includes('테스트 위치') && basisText.includes('하카타역'));

// =====================================================================
// 5. "실제 위치로 되돌리기"를 누르면 실제로 꺼지고, 정렬 기준도
//    원래(지정 위치=센트로이드)로 돌아온다.
// =====================================================================
await p.click('#testLocationBannerClear');
await p.waitForTimeout(150);
const bannerHiddenAfterClear = await p.locator('#testLocationBanner').isHidden();
const basisTextAfterClear = await p.locator('#sortBasisNote').innerText();
t('5) 되돌리기를 누르면 배너가 실제로 사라짐', bannerHiddenAfterClear);
t('5) 정렬 기준 문구도 테스트 위치가 아닌 원래 안내로 돌아옴', !basisTextAfterClear.includes('테스트 위치'));

// =====================================================================
// 6. 직접 좌표 입력도 실제로 반영된다.
// =====================================================================
await p.evaluate(() => { profile(); });
await p.waitForTimeout(100);
await p.fill('#testLocLat', '33.5911');
await p.fill('#testLocLng', '130.3987');
await p.click('#testLocCustomBtn');
await p.waitForTimeout(150);
const customLoc = await p.evaluate(() => A.getTestLocation());
t('6) 직접 입력한 좌표가 실제로 저장됨', customLoc && Math.abs(customLoc.lat - 33.5911) < 1e-6 && Math.abs(customLoc.lng - 130.3987) < 1e-6);
await p.evaluate(() => { A.clearTestLocation(); });

t('최종 콘솔/런타임 오류 0', errs.length === 0);
if (errs.length) console.log(errs);

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
await b.close();
process.exit(fail ? 1 : 0);
