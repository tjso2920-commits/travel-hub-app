/**
 * 글자 모양과 방향 (글꼴 점검에서 나온 것).
 *
 * 받아오는 글꼴은 없다 — 폰에 이미 있는 글꼴만 쓴다. 그건 괜찮았다.
 * 문제는 **글자 모양을 고르는 기준**이었다.
 *
 *  · 페이지가 전부 lang="ko" 라 한자를 한국식 모양으로만 그린다.
 *    한자는 한국·일본·중국(간체)·중국(번체)가 서로 모양이 다르다(直·骨·令·画).
 *    중국 가는 사람이 보는 중국어가 중국 사람 눈에 어긋난 글자로 보인다
 *  · 아랍어는 오른쪽에서 왼쪽으로 쓴다. 방향을 안 알려주면 숫자·문장부호가 뒤집힌다
 *
 * 그래서 현지 말이 들어가는 칸에만 lang·dir 이 붙었는지 본다.
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs';
const file = process.argv[2] || 'private/personal.html';
const html = fs.readFileSync(file, 'utf8');
const errs = []; const vc = new VirtualConsole();
vc.on('jsdomError', (e) => { if (!/scrollTo|Not implemented/.test(e.message)) errs.push(e.message); });
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: 'https://local.test/' });
const w = dom.window; const d = w.document; await new Promise((r) => setTimeout(r, 700));
let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };
w.alert = () => {}; w.confirm = () => true; w.Element.prototype.scrollIntoView = function () {};

/* ── 글꼴 자체 ─────────────────────────────────────────────────────────
   비행기 안에서도 글자가 나와야 한다. 바깥에서 받아오는 글꼴이 있으면 안 된다. */
const body = html.replace(/^.*$/m, (x) => x);
t('@font-face 없음', !/@font-face/i.test(body));
t('구글 폰트 안 부름', !/fonts\.(googleapis|gstatic)\.com/i.test(body));
t('본문 글꼴에 한글 글꼴이 들어 있음', /Apple SD Gothic Neo|Noto Sans KR|Malgun Gothic/.test(body));

/* ── 나라별 lang·dir ──────────────────────────────────────────────────── */
function seed(code, cc, dest, sample) {
  w.eval(`
    foodMap.dest=${JSON.stringify(dest)}; foodMap.setupSeen=true; foodMap.setupDone=true;
    foodMap.places=[]; save('foodmap_v1',foodMap); fmSetCountry(${JSON.stringify(cc)});
    jpAIPacks.langs={${JSON.stringify(code)}:{weeks:LANG_THEMES.map(function(th){
      return {t:th[0],s:th.slice(1),l:th.slice(1).map(function(sub){
        return {j:${JSON.stringify(sample)},k:'읽는 소리',m:'뜻'};})};
    }),at:TODAY,dest:${JSON.stringify(dest)},ai:true,sex:'m'}};
    jpState.pointer=3; jpState.srs={}; jpReviewOpen=true; jpReviewQueue=[];
    jpSession(2).lines.forEach(function(x){jpState.srs[x.id]={due:TODAY,box:0};});
    startApp(); if(typeof setupClose==='function')setupClose(); showTab('jp');
  `);
}
/** 현지 말이 들어간 칸을 찾아 lang/dir 을 읽는다 */
function langOf(mode, sel) {
  w.eval(`jpMode='${mode}';jpReviewQueue=[];renderJapanese();`);
  const el = d.querySelector(sel);
  return el ? { lang: el.getAttribute('lang'), dir: el.getAttribute('dir') } : null;
}

/* 중국(간체) — 한자 모양이 걸린 곳 */
seed('zh-CN', 'CN', '상하이', '请给我一杯水');
t('중국어 문장 칸에 lang=zh-CN', langOf('today', '#jpPane .jp')?.lang === 'zh-CN');
t('중국어 복습 카드에도 lang', langOf('review', '#jpPane .jp')?.lang === 'zh-CN');
t('중국어 인포 읽기에도 lang', langOf('info', '#jpPane .jp-rubyline')?.lang === 'zh-CN');

/* 대만(번체) — 같은 한자라도 모양이 다르다 */
seed('zh-TW', 'TW', '타이베이', '請給我一杯水');
t('번체 문장 칸에 lang=zh-TW', langOf('today', '#jpPane .jp')?.lang === 'zh-TW');

/* 아랍에미리트 — 오른쪽에서 왼쪽 */
seed('ar', 'AE', '두바이', 'من فضلك، كوب ماء');
const ar = langOf('today', '#jpPane .jp');
t('아랍어 칸에 lang=ar', ar?.lang === 'ar');
t('아랍어 칸이 오른쪽에서 왼쪽', ar?.dir === 'rtl');

/* 왼쪽에서 오른쪽 쓰는 말은 rtl 이 아니어야 한다 */
seed('fr', 'FR', '파리', 'Bonjour');
const fr = langOf('today', '#jpPane .jp');
t('프랑스어 칸에 lang=fr', fr?.lang === 'fr');
t('프랑스어는 rtl 아님', fr?.dir !== 'rtl');

/* 일본은 지금과 똑같아야 한다 */
w.eval("foodMap.dest='후쿠오카';fmSetCountry('JP');jpState.pointer=3;showTab('jp');");
w.eval("jpMode='today';renderJapanese();");
const ja = d.querySelector('#jpPane .jp');
t('일본어 칸은 후리가나 그대로', !!ja && ja.innerHTML.includes('<ruby'));

/* ── 통역 결과 방향 ───────────────────────────────────────────────────
   상대에게 보여주는 화면이다. 여기서 방향이 틀리면 제일 티가 난다. */
w.eval("fmSetCountry('AE');foodMap.dest='두바이';");
w.eval("showTab('now');renderFoodMap();trShow({dir:'ko2lo',src:'물 한 잔 주세요',out:'من فضلك، كوب ماء',read:'민 파들락',note:''},false);");
const out = d.querySelector('#trOut .tr-big');
t('통역 결과가 아랍어 방향', out && out.getAttribute('lang') === 'ar' && out.getAttribute('dir') === 'rtl');
const src = d.querySelector('#trOut .tr-src');
t('내가 말한 한국어는 ko', src && src.getAttribute('lang') === 'ko');
/* 반대 방향이면 결과가 한국어다 */
w.eval("trShow({dir:'lo2ko',src:'من فضلك',out:'부탁드립니다',read:'',note:''},false);");
const out2 = d.querySelector('#trOut .tr-big');
t('반대 방향이면 결과는 ko', out2 && out2.getAttribute('lang') === 'ko');
t('반대 방향이면 원문이 ar', d.querySelector('#trOut .tr-src')?.getAttribute('lang') === 'ar');

t('최종 런타임 오류 0', errs.length === 0);
if (errs.length) console.log('  ', errs.slice(0, 3));
console.log(fail ? ('\n실패 ' + fail + '건') : '\n전체 통과');
process.exit(fail ? 1 : 0);
