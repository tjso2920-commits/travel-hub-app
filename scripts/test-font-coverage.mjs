/**
 * 한글 폰트 커버리지 확인 — 실제 Chromium.
 *
 * 2026-09-09 코드 검토: 기존 korean-400/500/600.woff2가 294자만 담고 있어
 * '쿄·토·멘' 등 흔한 한글 음절도 시스템 폰트로 대체됐다. 이 스크립트는
 * 실제 브라우저에서 CSS Font Loading API(document.fonts)로 이 글자들이
 * 진짜 Noto Sans KR로 렌더링되는지 확인한다 — 파일 안에 바이트가 있는지가
 * 아니라 브라우저가 실제로 그 폰트를 그 글자에 쓰는지를 본다.
 */
import { chromium } from 'playwright';

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage();
await p.goto('file://' + process.cwd() + '/src/design/index.html');
await p.waitForTimeout(300);

const result = await p.evaluate(async () => {
  const testWords = ['쿄', '토', '멘', '교토', '경주', '흔한상호', 'ひらがな', 'カタカナ'];
  const out = {};
  for (const w of testWords) {
    try {
      await document.fonts.load("400 16px 'Noto Sans KR'", w);
      out[w] = document.fonts.check("400 16px 'Noto Sans KR'", w);
    } catch (e) {
      out[w] = 'error:' + e.message;
    }
  }
  return out;
});
console.log('  ', result);
t('한글 "쿄" 가 Noto Sans KR 로 커버됨(전에는 시스템 폰트로 대체되던 글자)', result['쿄'] === true);
t('한글 "토" 가 Noto Sans KR 로 커버됨', result['토'] === true);
t('한글 "멘" 이 Noto Sans KR 로 커버됨', result['멘'] === true);
t('일반 한글 단어(교토·경주·흔한상호)도 전부 커버됨', result['교토'] === true && result['경주'] === true && result['흔한상호'] === true);
t('히라가나도 커버됨(일본어 지원)', result['ひらがな'] === true);
t('가타카나도 커버됨(일본어 지원)', result['カタカナ'] === true);

// 실제로 필요한 조각만 내려받는지(전체 372개가 아니라 일부만) 확인 —
// unicode-range 분할 로딩이 실제로 동작하는지 본다.
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
console.log('  실제로 내려받은 한글 폰트 조각 수:', netInfo, '(372개 중 일부만이어야 분할 로딩이 되는 것)');
t('필요한 조각만 내려받음(372개를 전부 안 받음 — 분할 로딩 확인)', netInfo > 0 && netInfo < 372);

await b.close();
console.log(fail ? ('\n실패 ' + fail + '건') : '\n전체 통과');
process.exit(fail ? 1 : 0);
