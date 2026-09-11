/**
 * 현지 거리 · 옷차림 보기(2026-09-10 재검토 8차 4절) 종단 검증 — 실제
 * Chromium + 실제 서버(임시 포트). 실제 유튜브 방송 존재·임베드 가능
 * 여부는 이번 세션에서 검증할 방법이 없어(가짜 videoId를 지어내지
 * 말라는 지시) src/design/street-video.js의 STREET_VIDEOS는 빈 표로
 * 배포된다. 그래서 이 검증은 두 갈래다:
 *   1) 빈 표 상태에서 버튼이 실제로 숨겨지는지(합성 데이터 없이도
 *      확인 가능한, "검증된 영상이 없으면 숨긴다" 요구사항의 실제 확인).
 *   2) 이 테스트가 직접 주입한 합성(가짜, 명백히 테스트 전용) 항목으로
 *      플레이어 구조·표시 문구·닫기 동작·오류 대체 화면을 모의 검증.
 * 실제 방송 검증이 아니라 구조 검증이라는 걸 출력에도 명시한다.
 *
 * 실행: node scripts/test-street-video.mjs
 */
import { chromium } from 'playwright';

process.env.DB_PATH = ':memory:';
process.env.FORCE_TEST_MODE = 'true';
const { createServer } = await import('../server/index.mjs');
const { openDb } = await import('../server/db.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const apiBase = `http://127.0.0.1:${port}`;

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('dialog', (d) => d.dismiss());
// street-video.js가 클릭 시 실제로 https://www.youtube.com/iframe_api를
// 불러오려 시도한다 — 이 샌드박스에는 실제 인터넷이 없을 수 있으므로,
// 이 페이지에서는 그 요청을 응답하지 않고 그대로 붙들어 둔다(끝내지도
// 실패시키지도 않음 — 8초 타임아웃보다 훨씬 짧은 이 테스트 구간
// 안에서는 "아직 로딩 중" 상태가 그대로 유지된다). 실제 로드 성공/
// 오류/타임아웃/낡은 콜백 방지는 아래 8~10번에서 각각 별도로,
// 결정론적으로 제어되는 라우팅으로 검증한다.
await p.route('https://www.youtube.com/iframe_api', () => {});

await p.addInitScript((base) => { window.API_BASE = base; }, apiBase);
await p.goto('file://' + process.cwd() + '/src/design/index.html');
await p.waitForTimeout(300);

// =====================================================================
// 1. 배포 기본 상태 — STREET_VIDEOS가 빈 표이므로 어떤 도시에서도
//    버튼이 뜨면 안 된다(가짜 영상 없이도 확인 가능한 핵심 요구사항).
// =====================================================================
await p.evaluate(() => showRoute());
await p.waitForTimeout(150);
const buttonBeforeSeed = await p.locator('.street-video-button').count();
t('1) 검증된 영상이 없는 기본 배포 상태에서는 버튼 자체가 없음(가짜 영상 없이 실제로 확인됨)', buttonBeforeSeed === 0);
await p.evaluate(() => sheet.close());

// =====================================================================
// 2. 이 테스트가 직접 주입한 합성 항목(명백히 테스트 전용 — 실제
//    검증된 방송이 아님)으로 구조를 확인한다.
// =====================================================================
await p.evaluate(() => {
  // 실제 서비스에 절대 올라가면 안 되는 합성 테스트 픽스처임을
  // videoId 자체에도 남긴다.
  window.StreetVideo.STREET_VIDEOS['후쿠오카'] = [{
    videoId: 'TEST0FAKE01',
    title: '(테스트 전용) 합성 픽스처',
    channel: '테스트 채널',
    filmingLocation: '테스트 촬영지',
    tzId: 'Asia/Tokyo',
    sourceUrl: 'https://www.youtube.com/watch?v=TEST0FAKE01',
  }];
});
await p.evaluate(() => showRoute());
await p.waitForTimeout(150);
t('2) 합성 항목을 등록하면 버튼이 실제로 나타남', await p.locator('.street-video-button').count() === 1);
t('2) 버튼 문구가 요청 그대로임', (await p.locator('.street-video-button').innerText()).includes('현지 거리 · 옷차림 보기'));
t('2) 클릭 전에는 iframe도 유튜브 스크립트도 DOM에 전혀 없음(미리 로드 안 함)', (await p.locator('iframe').count()) === 0 && (await p.locator('script[src*="youtube.com/iframe_api"]').count()) === 0);

// =====================================================================
// 3. 클릭 → 그때서야 공식 임베드 플레이어를 불러온다.
// =====================================================================
await p.click('.street-video-button');
await p.waitForTimeout(150);
const iframeSrc = await p.locator('#streetVideoPanel iframe').getAttribute('src');
t('3) 클릭한 뒤에만 iframe이 생김(지연 로드)', !!iframeSrc);
t('3) 공식 유튜브 임베드 도메인을 씀', iframeSrc.startsWith('https://www.youtube.com/embed/TEST0FAKE01?'));
t('3) 자동재생을 명시적으로 끔(autoplay=0)', iframeSrc.includes('autoplay=0'));
t('3) 유튜브 스크립트를 로드 시도함(패널을 열 때만 — 클릭 전엔 없었음)', (await p.locator('script[src*="youtube.com/iframe_api"]').count()) === 1);

const panelText = await p.locator('#streetVideoPanel').innerText();
t('3) 촬영 장소가 표시됨', panelText.includes('테스트 촬영지'));
t('3) 제공 채널이 표시됨', panelText.includes('테스트 채널'));
t('3) 현지 시간이 표시됨', /현지 시간/.test(panelText));
t('3) "영상 시청 시 데이터가 사용돼요" 안내가 표시됨', panelText.includes('영상 시청 시 데이터가 사용돼요'));
t('3) "현지인"이라 단정하지 않고 "현지 거리의 옷차림"으로만 표현함', panelText.includes('현지 거리의 옷차림') && panelText.includes('반드시 현지인이라는 뜻은 아니에요'));
t('3) 우리가 LIVE 상태를 직접 단정하는 표시는 없음(실제로 확인 못 하면 안 씀)', !panelText.includes('LIVE') && !panelText.includes('라이브'));
// https://developers.google.com/youtube/player_parameters 의 modestbranding
// 같은 "채널 브랜딩 숨김" 파라미터를 안 씀 — 컨트롤·브랜딩을 가리지 않는다.
t('3) 채널 브랜딩을 가리는 파라미터를 안 씀(modestbranding 미사용)', !iframeSrc.includes('modestbranding'));

// =====================================================================
// 4. 닫기 — 실제로 재생이 멈춰야 한다(iframe src가 비워짐).
// =====================================================================
await p.click('[data-street-video-close]');
await p.waitForTimeout(100);
t('4) 닫기를 누르면 패널이 다시 숨겨짐', await p.locator('#streetVideoPanel').isHidden());
t('4) 패널 안에 재생 중이던 iframe이 사라짐(정지 보장)', (await p.locator('#streetVideoPanel iframe').count()) === 0);

// =====================================================================
// 5. 임베드가 애초에 불가능하다고 이미 확인된 영상 — 시도조차 하지
//    않고 곧바로 원본 링크로 안내해야 한다.
// =====================================================================
await p.evaluate(() => {
  window.StreetVideo.STREET_VIDEOS['후쿠오카'] = [{
    videoId: 'TEST0FAKE02', title: '(테스트) 임베드 불가', channel: '테스트 채널',
    filmingLocation: '테스트 촬영지', tzId: 'Asia/Tokyo',
    sourceUrl: 'https://www.youtube.com/watch?v=TEST0FAKE02', embeddable: false,
  }];
});
await p.click('.street-video-button');
await p.waitForTimeout(100);
t('5) 임베드 불가로 이미 확인된 영상은 iframe을 만들지 않음', (await p.locator('#streetVideoPanel iframe').count()) === 0);
t('5) 대신 원본 유튜브 링크를 보여줌', (await p.locator('#streetVideoPanel .street-video-original-link').getAttribute('href')) === 'https://www.youtube.com/watch?v=TEST0FAKE02');
await p.evaluate(() => window.StreetVideo.closePanel());

// =====================================================================
// 6. 실제 재생 중 오류(방송 종료·비공개·임베드 거부)를 IFrame Player
//    API의 onError로 감지했을 때의 대체 화면 — 실제 유튜브 네트워크
//    없이 오류 처리 로직만 직접 호출해 모의 검증한다(합성 테스트).
// =====================================================================
const errorFallbackText = await p.evaluate(() => {
  const panel = document.createElement('div');
  document.body.appendChild(panel);
  const entry = { sourceUrl: 'https://www.youtube.com/watch?v=TEST0FAKE03', filmingLocation: '테스트', channel: '테스트', tzId: 'Asia/Tokyo' };
  window.StreetVideo._testHooks.applyPlayerError(panel, entry, 150); // 150=제작자가 임베드 재생을 허용 안 함
  const text = panel.innerText;
  panel.remove();
  return text;
});
t('6) (모의) 임베드 거부(코드 150) 시 원본 링크 안내로 대체됨', /바로 재생할 수 없어요|유튜브에서 직접/.test(errorFallbackText));

// =====================================================================
// 7. 무료 보조 기능 — 위치확인·코스생성 이용권/비용 원장을 전혀 안
//    건드림(entitlement-usage.mjs·cost-ledger.mjs를 아예 안 부름).
// =====================================================================
{
  const db = openDb();
  const entCount = db.prepare('SELECT COUNT(*) AS n FROM entitlement_usage').get().n;
  const costCount = db.prepare('SELECT COUNT(*) AS n FROM cost_ledger').get().n;
  t('7) 영상 기능 사용 중 이용권 사용량 테이블에 아무 기록도 안 생김', entCount === 0);
  t('7) 영상 기능 사용 중 비용 원장에도 아무 기록도 안 생김', costCount === 0);
}

// =====================================================================
// 8. 2026-09-11 재검토(9차) 8절 — 스크립트 로드 자체가 실패(onerror,
//    예: 광고 차단·네트워크 차단)하면 무한정 기다리지 않고 원본 링크
//    안내로 바뀌어야 한다. 실제로 재현해 확인한다.
// =====================================================================
{
  const b3 = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p3 = await b3.newPage();
  p3.on('dialog', (d) => d.dismiss());
  await p3.route('https://www.youtube.com/iframe_api', (route) => route.abort());
  await p3.addInitScript((base) => { window.API_BASE = base; }, apiBase);
  await p3.goto('file://' + process.cwd() + '/src/design/index.html');
  await p3.waitForTimeout(200);
  await p3.evaluate(() => {
    window.StreetVideo.STREET_VIDEOS['후쿠오카'] = [{
      videoId: 'TEST0FAKE04', title: '(테스트) 로드 실패', channel: '테스트 채널',
      filmingLocation: '테스트 촬영지', tzId: 'Asia/Tokyo', sourceUrl: 'https://www.youtube.com/watch?v=TEST0FAKE04',
    }];
  });
  await p3.evaluate(() => showRoute());
  await p3.waitForTimeout(150);
  await p3.click('.street-video-button');
  await p3.waitForTimeout(400); // 실제로 onerror가 도착할 시간을 준다.
  const panelText8 = await p3.locator('#streetVideoPanel').innerText();
  t('8) 스크립트 로드 자체가 실패(onerror)하면 무한정 안 기다리고 원본 링크 안내로 바뀜', /유튜브에서 직접|바로 재생할 수 없어요/.test(panelText8));
  t('8) 실패 상태에서도 원본 유튜브 링크는 계속 제공됨', (await p3.locator('#streetVideoPanel .street-video-original-link').getAttribute('href')) === 'https://www.youtube.com/watch?v=TEST0FAKE04');
  await b3.close();
}

// =====================================================================
// 9. 응답이 아예 안 오는(느린 해외 연결 흉내) 경우도 정해진 시간이
//    지나면 타임아웃으로 같은 원본 링크 안내로 바뀐다. 실제 8초를
//    기다리지 않도록 테스트 전용 훅으로 타임아웃을 짧게 줄인다.
// =====================================================================
{
  const b4 = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p4 = await b4.newPage();
  p4.on('dialog', (d) => d.dismiss());
  await p4.route('https://www.youtube.com/iframe_api', () => {}); // 응답 자체를 영원히 안 함.
  await p4.addInitScript((base) => { window.API_BASE = base; }, apiBase);
  await p4.goto('file://' + process.cwd() + '/src/design/index.html');
  await p4.waitForTimeout(200);
  await p4.evaluate(() => window.StreetVideo._testHooks.setIframeApiTimeoutMs(200));
  await p4.evaluate(() => {
    window.StreetVideo.STREET_VIDEOS['후쿠오카'] = [{
      videoId: 'TEST0FAKE05', title: '(테스트) 타임아웃', channel: '테스트 채널',
      filmingLocation: '테스트 촬영지', tzId: 'Asia/Tokyo', sourceUrl: 'https://www.youtube.com/watch?v=TEST0FAKE05',
    }];
  });
  await p4.evaluate(() => showRoute());
  await p4.waitForTimeout(150);
  await p4.click('.street-video-button');
  await p4.waitForTimeout(400); // 테스트용 200ms 타임아웃보다 넉넉히 더 기다린다.
  const panelText9 = await p4.locator('#streetVideoPanel').innerText();
  t('9) 응답이 아예 없어도(느린 해외 연결 흉내) 정해진 시간이 지나면 타임아웃으로 원본 링크 안내로 바뀜', /유튜브에서 직접|바로 재생할 수 없어요/.test(panelText9));
  await b4.close();
}

// =====================================================================
// 10. 닫기/빠른 재열기 시 낡은 콜백이 새 플레이어 인스턴스에 영향을
//     주면 안 된다. 첫 번째 열기의 응답을 일부러 붙들어 둔 채 바로
//     닫고 다른 영상을 빠르게 다시 연 뒤, 그제서야 첫 번째 응답이
//     늦게 도착하게 만들어 실제로 재현·확인한다.
// =====================================================================
{
  const b5 = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p5 = await b5.newPage();
  p5.on('dialog', (d) => d.dismiss());
  let resolveFirstRoute;
  const firstRouteHeld = new Promise((res) => { resolveFirstRoute = res; });
  await p5.route('https://www.youtube.com/iframe_api', async (route) => {
    await firstRouteHeld; // 사용자가 닫고 다시 열 때까지 응답을 늦춘다(느린 응답 흉내).
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: "window.YT=window.YT||{};window.YT.Player=function(elId){window.__ytPlayerCreations=window.__ytPlayerCreations||[];window.__ytPlayerCreations.push(elId);this.destroy=function(){};};if(typeof window.onYouTubeIframeAPIReady==='function')window.onYouTubeIframeAPIReady();",
    });
  });
  await p5.addInitScript((base) => { window.API_BASE = base; }, apiBase);
  await p5.goto('file://' + process.cwd() + '/src/design/index.html');
  await p5.waitForTimeout(200);
  await p5.evaluate(() => {
    window.StreetVideo.STREET_VIDEOS['후쿠오카'] = [{
      videoId: 'TEST0STALE1', title: '(테스트) 첫 번째', channel: '테스트', filmingLocation: '테스트', tzId: 'Asia/Tokyo', sourceUrl: 'https://www.youtube.com/watch?v=TEST0STALE1',
    }];
  });
  await p5.evaluate(() => showRoute());
  await p5.waitForTimeout(150);
  await p5.click('.street-video-button'); // 첫 번째 열기 — 응답이 아직 안 옴(붙들려 있음).
  await p5.waitForTimeout(100);
  await p5.evaluate(() => window.StreetVideo.closePanel()); // 바로 닫음(세대가 올라감).
  await p5.evaluate(() => {
    window.StreetVideo.STREET_VIDEOS['후쿠오카'] = [{
      videoId: 'TEST0STALE2', title: '(테스트) 두 번째', channel: '테스트', filmingLocation: '테스트', tzId: 'Asia/Tokyo', sourceUrl: 'https://www.youtube.com/watch?v=TEST0STALE2',
    }];
  });
  await p5.evaluate(() => showRoute());
  await p5.waitForTimeout(50);
  await p5.click('.street-video-button'); // 빠르게 재열기 — 다른 영상.
  await p5.waitForTimeout(100);
  resolveFirstRoute(); // 이제서야 붙들려 있던 첫 번째 응답이 늦게 도착.
  await p5.waitForTimeout(300);
  const playerCreations = await p5.evaluate(() => window.__ytPlayerCreations || []);
  t('10) 늦게 도착한 응답이 있어도 실제 YT.Player는 딱 한 번만 만들어짐(낡은 콜백이 중복 생성 안 함)', playerCreations.length === 1);
  const finalIframeSrc = await p5.locator('#streetVideoPanel iframe').getAttribute('src');
  t('10) 화면에 남는 것은 나중에 연 두 번째 영상임(낡은 콜백이 잘못 덮어쓰지 않음)', !!finalIframeSrc && finalIframeSrc.includes('TEST0STALE2'));
  await b5.close();
}

t('최종 콘솔/런타임 오류 0', errs.length === 0);

console.log('\n※ 위 2~7번은 이 테스트가 직접 주입한 합성(가짜) 영상 픽스처로 구조·표시 로직만 확인한 것이다.');
console.log('※ 실제 방송 존재·임베드 가능 여부·카메라 각도(옷차림이 보이는지)는 이번 세션에서 검증하지 못했다 — src/design/street-video.js의 STREET_VIDEOS는 빈 표로 배포되어 실제 서비스에서는 모든 도시에서 버튼이 숨겨진다. 실제 영상 등록은 사람이 직접 방송을 확인한 뒤 별도로 진행해야 한다.');

// 합성 데이터 모바일 스크린샷 — 버튼·패널 구조가 실제로 어떻게
// 보이는지만 보여준다(실제 방송 화면이 아니라 iframe이 로드를
// 시도하는 자리와 표시 문구를 보여줄 뿐 — youtube.com/iframe_api
// 요청은 이 테스트에서 계속 막아 뒀다).
await b.close();
const b2 = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p2 = await b2.newPage({ viewport: { width: 390, height: 844 } });
p2.on('dialog', (d) => d.dismiss());
await p2.route('https://www.youtube.com/iframe_api', (route) => route.abort());
await p2.addInitScript((base) => { window.API_BASE = base; }, apiBase);
await p2.goto('file://' + process.cwd() + '/src/design/index.html');
await p2.waitForTimeout(200);
await p2.evaluate(() => {
  window.StreetVideo.STREET_VIDEOS['후쿠오카'] = [{
    videoId: 'TEST0FAKE01', title: '(합성 데이터) 예시 픽스처', channel: '(합성) 예시 채널',
    filmingLocation: '(합성) 예시 촬영지', tzId: 'Asia/Tokyo',
    sourceUrl: 'https://www.youtube.com/watch?v=TEST0FAKE01',
  }];
});
await p2.evaluate(() => showRoute());
await p2.waitForTimeout(150);
await p2.click('.street-video-button');
await p2.waitForTimeout(150);
await p2.screenshot({ path: 'docs/screenshots/after_현지거리영상_합성데이터.png' });
console.log('스크린샷 저장 완료: docs/screenshots/after_현지거리영상_합성데이터.png(합성 데이터 — 실제 방송·실제 영상 미검증, 구조만 표시)');

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
await b2.close();
server.close();
process.exit(fail ? 1 : 0);
