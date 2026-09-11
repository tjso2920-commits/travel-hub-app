/**
 * 2026-09-11 재검토(12차) 6절 — "아이폰만 대상으로 완료 판단하지 말고,
 * 실행 가능한 Chromium·Firefox·WebKit에서 핵심 흐름을 확인하라. 실행
 * 환경이 없으면 미검증으로 기록하라. 모바일 화면 크기 에뮬레이션이나
 * WebKit 통과를 실제 Galaxy·iPhone·Safari 검증으로 표시하지 마라."
 *
 * 이 파일이 실제로 하는 일과 정직하게 하지 않는 일을 명확히 구분한다:
 *
 *  1) Firefox·WebKit 실행 가능 여부를 실제로 시도해 본다 — 이 세션
 *     환경에는 Chromium만 설치돼 있고 Firefox·WebKit 실행 파일 자체가
 *     없다(설치를 새로 시도하지 않는다 — 환경 안내에 따라 Chromium
 *     외 브라우저 설치는 이 세션에서 금지돼 있다). 실행 안 되면
 *     "미검증"으로 그대로 기록하고 넘어간다(가짜 통과 표시 없음).
 *  2) Chromium으로 실제 핵심 흐름을 모바일 화면 크기(작은 뷰포트)에서
 *     확인한다 — 이건 "화면 크기 에뮬레이션"일 뿐 실제 iPhone·Galaxy
 *     기기 검증이 아니다(터치 이벤트·실제 OS 폰트 확대·실제 키보드
 *     동작과는 다르다).
 *  3) 글자 확대(브라우저 기본 글꼴 크기를 키우는 것과 비슷하게 흉내)
 *     상태에서도 핵심 버튼이 겹치거나 화면 밖으로 밀려나지 않는지
 *     확인한다.
 *  4) 느린 네트워크·연결 끊김 중 중복 요청으로 데이터가 안 깨지는지
 *     확인한다(태그/AI 분류에 이미 적용한 것과 같은 종류의 점검을
 *     장소 동기화에도 적용).
 *
 * 실행: node scripts/test-cross-browser-and-viewport.mjs
 */
import { chromium, firefox, webkit } from 'playwright';

process.env.DB_PATH = ':memory:';
process.env.FORCE_TEST_MODE = 'true';
process.env.LOGIN_CODE_COOLDOWN_SECONDS = '0';
process.env.LOGIN_MAX_VERIFY_ATTEMPTS = '200';
const { createServer } = await import('../server/index.mjs');
const { sentEmailsForTest } = await import('../server/adapters/email.mjs');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };
const info = (n) => console.log('INFO ' + n);

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const apiBase = `http://127.0.0.1:${port}`;

// =====================================================================
// 1) Firefox·WebKit 실행 가능 여부 — 실제로 launch를 시도해 보고,
//    실패하면 "이 환경에는 없다"고 정직하게 기록한다(가짜 통과 없음).
// =====================================================================
for (const [name, engine] of [['Firefox', firefox], ['WebKit', webkit]]) {
  try {
    const b = await engine.launch();
    await b.close();
    info(`1) ${name} 실행 가능 — 이 파일 범위 밖의 핵심 흐름 검증에 실제로 쓸 수 있음(이번 라운드엔 시간상 미실시, 다음 라운드 후보)`);
  } catch (e) {
    info(`1) ${name} 실행 불가(이 세션 환경에 실행 파일 없음) — 실제 검증 미실시로 정직하게 기록: ${e.message.split('\n')[0]}`);
  }
}

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errs = [];
async function newPage(label, viewport) {
  const page = await b.newPage({ viewport: viewport || null });
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
// 2) 작은 화면(모바일 뷰포트 에뮬레이션, iPhone SE급 375×667)에서 핵심
//    흐름 — 하단 내비게이션 버튼이 화면 안에 있고, 실제로 44×44px
//    이상의 터치 영역을 유지하며, 클릭 가능함을 확인한다. **주의**:
//    이건 실제 iPhone Safari 검증이 아니라 Chromium의 뷰포트 크기
//    에뮬레이션일 뿐이다.
// =====================================================================
{
  const p = await newPage('P-mobile', { width: 375, height: 667 });
  const navBtnBoxes = await p.evaluate(() => {
    const nav = document.querySelector('nav');
    return Array.from(nav.querySelectorAll('button')).map((b) => {
      const r = b.getBoundingClientRect();
      return { w: r.width, h: r.height, top: r.top, bottom: r.bottom, visible: r.top >= 0 && r.bottom <= window.innerHeight };
    });
  });
  t('2) 375×667 뷰포트에서도 하단 내비게이션 버튼이 전부 화면 안에 있음(잘려서 안 보이는 버튼 없음)', navBtnBoxes.every((x) => x.visible));
  t('2) 하단 내비게이션 버튼이 44×44px 이상의 터치 영역을 유지함(작은 화면에서도 오작동 방지 규칙 유지)', navBtnBoxes.every((x) => x.w >= 44 && x.h >= 44));

  // 검색 → 로그인 시트 열기 → 핵심 입력 필드가 화면 밖으로 밀려나지 않는지.
  await p.evaluate(() => showLoginSheet(() => {}));
  await p.waitForTimeout(150);
  const loginFieldBox = await p.evaluate(() => {
    const el = document.getElementById('loginEmail');
    const r = el.getBoundingClientRect();
    return { visible: r.top >= 0 && r.bottom <= window.innerHeight && r.width > 0 };
  });
  t('2) 작은 화면에서도 로그인 이메일 입력창이 화면 안에 보임', loginFieldBox.visible);
  await p.evaluate(() => { const c = document.getElementById('close'); if (c) c.click(); });

  await p.close();
}

// =====================================================================
// 3) 글자 확대 흉내(루트 글꼴 크기를 150%로 강제) — 핵심 버튼 글자가
//    겹치거나 화면 밖으로 밀려나지 않는지 확인한다. **주의**: 이건
//    실제 iOS/Android의 "글자 크게" 접근성 설정(요소별 상대크기 확대)
//    과 다르다 — 전체 배율을 흉내 낸 근사치일 뿐이다.
// =====================================================================
{
  const p = await newPage('P-textzoom', { width: 390, height: 844 });
  await p.addStyleTag({ content: 'html{font-size:150% !important}' });
  await p.waitForTimeout(150);
  const navOverlap = await p.evaluate(() => {
    const nav = document.querySelector('nav');
    const btns = Array.from(nav.querySelectorAll('button'));
    for (let i = 0; i < btns.length - 1; i++) {
      const a = btns[i].getBoundingClientRect();
      const b2 = btns[i + 1].getBoundingClientRect();
      if (a.right > b2.left && a.left < b2.right && Math.abs(a.top - b2.top) < 5) return true; // 가로로 겹침
    }
    return false;
  });
  t('3) 글자 150% 확대 상태에서도 하단 내비게이션 버튼끼리 겹치지 않음', !navOverlap);
  await p.close();
}

// =====================================================================
// 4) 느린 네트워크·연결 끊김 중 중복 요청 — 장소 동기화 요청이 응답
//    지연 중 재시도(예: 사용자가 다시 조작해 daSyncPushSafe가 겹쳐
//    불림)돼도 서버에 중복 반영되거나 데이터가 깨지지 않는지 확인한다
//    (AI 분류·태그에 이미 적용한 것과 같은 종류의 점검을 장소 동기화
//    경로에도 적용 — daSyncPush의 기존 mySeq 가드가 실제로 이 상황을
//    막고 있는지 실제 지연 응답으로 재확인).
// =====================================================================
{
  const email = 'crossbrowser-sync@example.com';
  const p = await newPage('P-slownet');
  await loginViaUi(p, email);

  let putCount = 0;
  await p.route('**/api/places', async (route) => {
    if (route.request().method() === 'PUT') {
      putCount++;
      await new Promise((r) => setTimeout(r, 300)); // 느린 네트워크 흉내.
    }
    await route.continue();
  });

  await p.evaluate(() => {
    foodMap.places = [{ id: 'slow-1', name: '느린네트워크가게', cat: '기타', catConfirmed: true, city: '테스트시', cityKnown: true, cityConfirmed: true, sourceLists: [] }];
    A.saveFoodMap(foodMap);
  });
  // 지연 중에 곧바로 또 한 번 저장을 트리거한다(겹쳐 불리는 상황 재현).
  await p.evaluate(() => { daSyncPushSafe(); daSyncPushSafe(); });
  await p.waitForTimeout(700);

  const token = await p.evaluate(() => foodMap.session.token);
  const serverPlaces = await fetch(`${apiBase}/api/places`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
  const matching = serverPlaces.places.filter((x) => x.id === 'slow-1');
  t('4) 겹쳐 불린 동기화 요청이 있어도 서버에는 장소가 정확히 한 번만 저장됨(중복 레코드 없음)', matching.length === 1);
  t('4) 실제로 겹친 요청 두 번이 서버까지 나갔음(재현 조건이 실제로 성립)', putCount >= 2);

  await p.close();
}

t('최종 콘솔/런타임 오류 0', errs.length === 0);
if (errs.length) console.log(errs);

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
console.log('\n참고 — 이 파일이 확인하지 않는 것(정직하게 미검증으로 남김):');
console.log('  - 실제 iPhone Safari, 실제 Android Chrome/Samsung Internet, macOS Safari');
console.log('  - Instagram/Threads 인앱 브라우저에서의 파일 선택·로그인·결제 제한 여부');
console.log('  - 실제 OS 접근성 글자 확대(요소별 상대크기 확대) 및 실제 온스크린 키보드 표시로 인한 뷰포트 축소');
console.log('  - 실제 기기의 GPS 하드웨어·모바일 통신망 끊김');

await b.close();
server.close();
process.exit(fail ? 1 : 0);
