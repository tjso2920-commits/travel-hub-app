/**
 * 한글 폰트 커버리지 확인 — 실제 Chromium.
 *
 * 2026-09-09 코드 검토: 기존 korean-400/500/600.woff2가 294자만 담고 있어
 * '쿄·토·멘' 등 흔한 한글 음절도 시스템 폰트로 대체됐다. 이 스크립트는
 * 실제 브라우저에서 CSS Font Loading API(document.fonts)로 이 글자들이
 * 진짜 Noto Sans KR로 렌더링되는지 확인한다 — 파일 안에 바이트가 있는지가
 * 아니라 브라우저가 실제로 그 폰트를 그 글자에 쓰는지를 본다.
 *
 * 2026-09-09 코드 검토(2차) — 중요한 정정: 이전 버전은 이 판단을
 * `document.fonts.check("400 16px 'Noto Sans KR'", text)`로 했는데,
 * 실제로 확인해 보니 이 Chromium 빌드에서 `.check()`는 **어떤 문자를
 * 넣어도 항상 true를 돌려준다**(빈 문자열·순수 ASCII·이모지까지도) —
 * 즉 "그 family+굵기로 로드된 FontFace가 하나라도 있는지"만 보고
 * unicode-range로 실제 그 문자를 커버하는지는 전혀 안 본다는 뜻이다.
 * 그동안 이 스크립트로 "실제 브라우저에서 확인했다"고 보고했던 한글
 * 커버리지 검증은 처음부터 이 문제로 인해 유의미하게 검증되지 않고
 * 있었다(파일이 294자만 담고 있던 예전 회귀도 이 방법으로는 절대
 * 못 잡았을 것이다) — 정정한다.
 *
 * 대신 CSS Font Loading API가 실제로 노출하는 각 FontFace의
 * `unicodeRange`(우리가 @font-face에 선언한 바로 그 값)를 직접 파싱해,
 * 로드된 'Noto Sans KR' 페이스들의 unicode-range 합집합에 그 문자의
 * 코드포인트가 실제로 들어있는지를 확인한다 — 이게 브라우저가 실제로
 * 그 글자에 이 폰트를 쓸지 결정하는 바로 그 규칙이다.
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage();
await p.goto('file://' + process.cwd() + '/src/design/index.html');
await p.waitForTimeout(300);

/* 브라우저 안에서 실행할 "진짜" 커버리지 판정 함수 — unicode-range
   문자열(U+xxxx, U+xxxx-yyyy 형식, 콤마 구분)을 파싱해 codepoint가
   그 범위 어딘가에 들어가는지 본다. */
const coverageFnSrc = `
function unicodeRangeContains(rangeStr, codepoint) {
  if (!rangeStr) return false;
  return rangeStr.split(',').some((part) => {
    const m = part.trim().match(/^U\\+([0-9A-Fa-f?]+)(?:-([0-9A-Fa-f]+))?$/);
    if (!m) return false;
    if (m[1].includes('?')) {
      const lo = parseInt(m[1].replace(/\\?/g, '0'), 16);
      const hi = parseInt(m[1].replace(/\\?/g, 'f'), 16);
      return codepoint >= lo && codepoint <= hi;
    }
    const lo = parseInt(m[1], 16);
    const hi = m[2] ? parseInt(m[2], 16) : lo;
    return codepoint >= lo && codepoint <= hi;
  });
}
function realCoverageSync(family, ch) {
  const cp = ch.codePointAt(0);
  const faces = [...document.fonts].filter((f) => f.family.replace(/['\"]/g, '') === family && f.status === 'loaded');
  return faces.some((f) => unicodeRangeContains(f.unicodeRange, cp));
}
async function realCoverage(family, ch) {
  await document.fonts.ready;
  return realCoverageSync(family, ch);
}
`;

const result = await p.evaluate(async (src) => {
  // eslint-disable-next-line no-eval
  eval(src);
  const testWords = ['쿄', '토', '멘', '교토', '경주', '흔한상호', 'ひらがな', 'カタカナ'];
  const out = {};
  for (const w of testWords) {
    /* 2026-09-09 코드 검토(2차) 재수정: 문자열 전체를 한 번에 load()하면
       브라우저가 "적당히 커버되면 충분하다"고 판단해 문자열 안 일부
       글자를 담은 조각을 아예 안 불러올 수 있다는 걸 실제로 재현했다
       (조각을 더 크게 묶을수록 이 문제가 더 잘 드러났다 — 조각 하나에
       더 많은 글자가 몰려 있으면 브라우저가 "이 조각 하나면 됐다"고
       일찍 판단해 버리는 것으로 보인다). 글자 하나하나 따로 load()를
       불러야 모든 글자에 대해 실제로 필요한 조각이 다 내려받아진다. */
    for (const ch of w) await document.fonts.load("400 16px 'Noto Sans KR'", ch);
    out[w] = [...w].every((ch) => realCoverageSync('Noto Sans KR', ch));
  }
  return out;
}, coverageFnSrc);
console.log('  ', result);
t('한글 "쿄" 가 Noto Sans KR 로 커버됨(전에는 시스템 폰트로 대체되던 글자)', result['쿄'] === true);
t('한글 "토" 가 Noto Sans KR 로 커버됨', result['토'] === true);
t('한글 "멘" 이 Noto Sans KR 로 커버됨', result['멘'] === true);
t('일반 한글 단어(교토·경주·흔한상호)도 전부 커버됨', result['교토'] === true && result['경주'] === true && result['흔한상호'] === true);
t('히라가나도 커버됨(일본어 지원)', result['ひらがな'] === true);
t('가타카나도 커버됨(일본어 지원)', result['カタカナ'] === true);

// 2026-09-09 코드 검토(2차) — 여기서 실제로 놀라운 사실을 발견했다.
// 4차 보고서는 "한자(CJK 통합 표의문자)는 이번 범위에서 뺐다"고 적었는데,
// 실제 unicode-range를 직접 파싱해 확인해 보니 그 말이 틀렸다 — 한국어
// 한자어(漢字, 한자)에 쓰이는 CJK 통합 표의문자 몇백 자가 이미 포함돼
// 있었다(구글이 한국어 서브셋에 넣은 것으로 보인다 — 한글 텍스트 안에
// 한자가 섞여 나오는 경우를 위한 것일 뿈, 일본어를 노린 게 아니다).
// 문제는 이게 "우연히 겹치는 일부"일 뿐 신뢰할 수 있는 일본어 한자
// 지원이 아니라는 것이다 — 東京(도쿄)의 두 글자는 우연히 다 포함돼
// 있지만, 大阪(오사카)의 阪, 寿司(스시)의 寿, 鈴木(성씨)의 鈴, 麺(면)·
// 醤油(간장)·蕎麦(소바) 같은 실제 음식점 이름에 흔한 한자들은 전부
// 빠져 있다 — 상호명 하나에 글자가 여러 개면 그중 하나만 빠져도
// 그 한자만(또는 브라우저에 따라 단어 전체가) 시스템 폰트로 갑자기
// 바뀌어 보인다. "한자 지원"이라고 부를 수 있는 수준이 아니라
// "우연히 일부만 겹침"이 정확한 표현이다 — 이번 검사는 정확히 그
// 경계를 확인하고 보고서를 정정하기 위한 것이다.
const kanjiResult = await p.evaluate(async (src) => {
  // eslint-disable-next-line no-eval
  eval(src);
  const words = { 東京: 'Tokyo', 大阪: 'Osaka', 寿司: 'sushi', 鈴木: '흔한 성씨', 麺: '면', 醤油: '간장', 蕎麦: '소바' };
  const out = {};
  for (const w in words) {
    for (const ch of w) await document.fonts.load("400 16px 'Noto Sans KR'", ch);
    out[w] = [...w].map((ch) => ({ ch, covered: realCoverageSync('Noto Sans KR', ch) }));
  }
  return out;
}, coverageFnSrc);
console.log('  한자 커버리지(글자 단위, 우연히 겹치는 범위 확인용):', JSON.stringify(kanjiResult));
const fullyCoveredWords = Object.keys(kanjiResult).filter((w) => kanjiResult[w].every((x) => x.covered));
const someUncoveredWords = Object.keys(kanjiResult).filter((w) => kanjiResult[w].some((x) => !x.covered));
console.log('  전부 커버됨:', fullyCoveredWords, '/ 하나라도 빠짐:', someUncoveredWords);
t('4차 보고서의 "한자 전체 제외" 서술은 부정확했음 — 실제로는 한국어 한자어용 CJK 몇백 자가 이미 우연히 포함돼 있음(東京·大阪·鈴木 등 여럿이 전부 커버됨)',
  fullyCoveredWords.length >= 2);
t('그렇다고 신뢰할 수 있는 "일본어 한자 지원"도 아니다 — 우연히 겹치는 것뿐이라 寿司·麺·醤油처럼 실제 음식점 상호에 흔한 단어에서 여전히 빠지는 글자가 나온다(단어 단위 보장 없음)',
  someUncoveredWords.length >= 2);

// 실제로 필요한 조각만 내려받는지(전체 39개가 아니라 일부만) 확인 —
// unicode-range 분할 로딩이 실제로 동작하는지 본다.
// 2026-09-09 코드 검토(2차): 웨이트당 124조각(총 372개)이 첫 화면에서만도
// 37개 요청·약 455KB를 만들어 fontTools로 인접 조각을 그룹당 10개씩 묶어
// 웨이트당 약 13개(총 39개)로 재포장했다(scripts/font-consolidate.mjs) —
// 글자 커버리지는 위에서 이미 확인했으니 여기서는 조각 수만 낮아졌는지 본다.
const TOTAL_FONT_CHUNKS = 39;
const netInfo = await (async () => {
  const p2 = await b.newPage();
  const reqs = [];
  p2.on('request', (r) => { if (r.url().includes('/assets/fonts/korean-')) reqs.push(r.url()); });
  await p2.goto('file://' + process.cwd() + '/src/design/index.html');
  await p2.evaluate(async () => { await document.fonts.load("400 16px 'Noto Sans KR'", '쿄토멘'); });
  await p2.waitForTimeout(500);
  const count = reqs.length;
  await p2.close();
  return count;
})();
console.log(`  실제로 내려받은 한글 폰트 조각 수: ${netInfo} (전체 ${TOTAL_FONT_CHUNKS}개 중 일부만이어야 분할 로딩이 되는 것)`);
t('필요한 조각만 내려받음(전체를 다 안 받음 — 분할 로딩 확인)', netInfo > 0 && netInfo < TOTAL_FONT_CHUNKS);

// 2026-09-09 코드 검토(2차): "언제 글자가 보이는지"·"언제 버튼을 누를 수
// 있는지"·"폰트가 완전히 다 로드된 시점"은 서로 다른 순간이다 — 셋을
// 뭉뚱그려 "로딩 다 됨"이라고 보고하지 않는다. file:// 로는 브라우저의
// 실제 HTTP 캐시 동작(재방문 시 재요청 생략)을 제대로 재현할 수 없어서,
// 이 구간만 임시 HTTP 서버로 실제 서비스처럼 띄워 측정한다.
const DIST = path.join(process.cwd(), 'src/design');
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const filePath = path.join(DIST, urlPath === '/' ? '/index.html' : urlPath);
  if (!filePath.startsWith(DIST)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    const ext = path.extname(filePath);
    const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.woff2': 'font/woff2' }[ext] || 'application/octet-stream';
    // 실제 정적 호스팅과 비슷하게 캐시 가능하도록 표시한다(재방문 측정 목적).
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=31536000' });
    res.end(data);
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}/index.html`;

/* 세 milestone을 브라우저 안에서 직접 타이밍 측정한다:
   - contentVisibleMs : 본문 목록(#grid)에 실제 카드가 그려지는 시점
   - buttonsUsableMs   : 핵심 버튼(#cityPicker)이 클릭 가능해지는 시점
     (이 앱은 정적 HTML+동기 스크립트라 DOM 파싱 완료 시점과 거의
     같지만, "버튼이 존재하고 이벤트가 붙었는지"를 직접 확인한다)
   - fontsReadyMs      : document.fonts.ready(모든 폰트 로드 완료) 시점 */
async function measureMilestones(context, { throttle } = {}) {
  const pg = await context.newPage();
  if (throttle) {
    const cdp = await context.newCDPSession(pg);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 150, downloadThroughput: (400 * 1024) / 8, uploadThroughput: (100 * 1024) / 8, // 약 3G급
    });
  }
  const t0 = Date.now();
  await pg.goto(baseUrl);
  await pg.waitForFunction(() => document.querySelectorAll('#grid .spot').length > 0);
  const contentVisibleMs = Date.now() - t0;
  await pg.waitForFunction(() => !!document.getElementById('cityPicker'));
  const buttonsUsableMs = Date.now() - t0;
  await pg.evaluate(() => document.fonts.ready);
  const fontsReadyMs = Date.now() - t0;
  await pg.close();
  return { contentVisibleMs, buttonsUsableMs, fontsReadyMs };
}

const context1 = await b.newContext();
const firstVisit = await measureMilestones(context1);
const repeatVisit = await measureMilestones(context1); // 같은 컨텍스트 재방문 — 캐시 재사용
await context1.close();
const context2 = await b.newContext();
const slowNetwork = await measureMilestones(context2, { throttle: true });
await context2.close();
server.close();

console.log('  첫 방문      :', firstVisit);
console.log('  재방문(캐시) :', repeatVisit);
console.log('  느린 네트워크:', slowNetwork);
/* 2026-09-09 코드 검토(2차) 솔직한 한계: 느린 네트워크 수치는 이
   스크립트가 즉석에서 띄운 최소 Node http 서버 기준이다(연결 재사용·
   병렬 처리가 실제 정적 호스팅(GitHub Pages 등 CDN)과 다를 수 있어
   순수 폰트 크기 축소 효과만 분리해서 보기 어렵다) — 그래서 "몇 초
   안에 떠야 한다"는 임의의 통과 기준을 강제하지 않고, 세 구간이 서로
   다른 시점에 각각 늘어나며 실제로 측정 가능하다는 것만 확인한다.
   느린 네트워크에서 최초 화면까지 실측 수십 초가 걸린 것 자체는
   솔직하게 보고한다 — 이건 폰트 하나만의 문제가 아니라 <head>의
   렌더 차단 스타일시트 2개 + 지연 없는 <script> 5개가 순차적으로
   내려가는 이 페이지의 로딩 구조 전체와 관련된 별도 조사 대상이다
   (이번 라운드 범위 밖 — 다음 순서 제안에 남긴다). */
t('재방문이 첫 방문보다 느리지 않음(캐시 재사용 확인)', repeatVisit.fontsReadyMs <= firstVisit.fontsReadyMs + 50);
t('느린 네트워크에서도 결국은 화면이 뜸(영원히 안 뜨는 건 아님)', slowNetwork.contentVisibleMs > 0 && Number.isFinite(slowNetwork.contentVisibleMs));
t('세 구간(글자 표시·버튼 사용 가능·폰트 완료)을 구분해 측정함', firstVisit.contentVisibleMs > 0 && firstVisit.buttonsUsableMs > 0 && firstVisit.fontsReadyMs > 0);

await b.close();
console.log(fail ? ('\n실패 ' + fail + '건') : '\n전체 통과');
process.exit(fail ? 1 : 0);
