/**
 * 일본이 아닌 나라로 공부 탭을 돌려 본다.
 *
 * 프랑스로 세팅하고 화면을 찍어 보니 네 군데가 깨져 있었다 —
 * 탭 이름이 '일본어', 오디오가 "일본어로 두 번씩", 인포 읽기 화자가 **店主**,
 * 실전 AI가 "이자카야 프리토킹". 문장은 프랑스어인데 껍데기가 일본이었다.
 *
 * 후리가나·한글소리 변환은 가나 전용이라 프랑스어에 걸면 글자가 깨진다.
 * 그래서 여기서는 **화면에 일본 글자(가나·한자)가 한 자도 없는지**를 본다.
 * 반대로 일본으로 두면 店主·후리가나가 그대로 있어야 한다.
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs';
const file = process.argv[2] || 'private/personal.html';
const errs = []; const vc = new VirtualConsole();
vc.on('jsdomError', (e) => { if (!/scrollTo|Not implemented/.test(e.message)) errs.push(e.message); });
const dom = new JSDOM(fs.readFileSync(file, 'utf8'), { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: 'https://local.test/' });
const w = dom.window; const d = w.document; await new Promise((r) => setTimeout(r, 700));
let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };
w.alert = () => {}; w.confirm = () => true; w.Element.prototype.scrollIntoView = function () {};

const MODES = ['today', 'review', 'audio', 'info', 'bed', 'tools'];
/** 가나와 한자. 프랑스어 화면에는 한 자도 없어야 한다. */
const JA = /[぀-ヿ一-鿿]/;

/** 그 나라 말로 세팅하고, AI가 만든 것과 같은 모양의 회화팩을 넣는다. */
function setup(code, country, dest, sample) {
  w.eval(`
    foodMap.destCountry='${country}'; foodMap.dest='${dest}'; save('foodmap_v1',foodMap);
    jpAIPacks.langs={'${code}':{weeks:LANG_THEMES.map(function(th){
      return {t:th[0],s:th.slice(1),l:th.slice(1).map(function(sub){
        return {j:${JSON.stringify(sample)},k:'삼플 읽는 소리',m:'보기 문장 ('+sub+')'};})};
    }),at:TODAY,dest:'${dest}',ai:true,sex:'m'}};
    save('jp_packs_v1',jpAIPacks);
    jpState.pointer=3; jpState.srs={};
    jpSession(2).lines.forEach(function(x){jpState.srs[x.id]={due:TODAY,box:0};});
    jpReviewQueue=[]; jpReviewOpen=true;
    startApp(); showTab('jp');
  `);
}
function paneText(mode) {
  w.eval(`jpMode='${mode}';jpReviewQueue=[];renderJapanese();`);
  return d.getElementById('jpPane').textContent.replace(/\s+/g, ' ').trim();
}

/* ── 프랑스 ─────────────────────────────────────────────────────────── */
setup('fr', 'FR', '파리', 'Bonjour, une table pour deux');
t('말이 프랑스어로 잡힘', w.eval('jpLang()') === 'fr' && w.eval('jpLangName()') === '프랑스어');
/* 공부 탭을 한 번도 안 열었어도 탭 이름이 맞아야 한다 */
w.eval('showTab("collect");renderFoodMap();');
t('탭을 안 열어도 이름이 프랑스어', d.getElementById('tabJp').textContent === '프랑스어');
w.eval('showTab("jp");');

for (const m of MODES) {
  const txt = paneText(m);
  t(m + ': 일본 글자 없음', !JA.test(txt));
  t(m + ': "일본어" 라고 안 씀', !txt.includes('일본어'));
  t(m + ': 일본 지명·업종 없음', !/후쿠오카|하카타|이자카야/.test(txt));
  t(m + ': 화면이 비지 않음', txt.length > 20);
}
t('인포 읽기 화자가 한국어', paneText('info').includes('점원'));
t('인포 읽기 상황이 목적지', paneText('info').includes('파리의'));
t('프리토킹 제목이 목적지', paneText('tools').includes('파리'));
t('프랑스어 문장은 그대로 나옴', paneText('today').includes('Bonjour, une table pour deux'));
t('읽는 소리는 AI가 준 것을 씀', paneText('today').includes('삼플 읽는 소리'));

/* ── 태국: 글자가 아예 다른 말도 깨지지 않는가 ──────────────────────── */
setup('th', 'TH', '방콕', 'ขอน้ำหนึ่งแก้วครับ');
t('태국어 탭 이름', w.eval('jpLangName()') === '태국어');
for (const m of MODES) t('태국 ' + m + ': 일본 글자 없음', !JA.test(paneText(m)));
t('태국 문장 그대로 나옴', paneText('today').includes('ขอน้ำหนึ่งแก้วครับ'));

/* ── 일본으로 두면 한 글자도 안 바뀐다 ──────────────────────────────── */
w.eval(`
  foodMap.dest='후쿠오카'; fmSetCountry('JP');
  jpState.pointer=3; jpState.srs={}; jpReviewQueue=[]; jpReviewOpen=true;
  jpSession(2).lines.forEach(function(x){jpState.srs[x.id]={due:TODAY,box:0};});
  showTab('jp');
`);
t('일본 탭 이름 그대로', w.eval('jpLangName()') === '일본어' && d.getElementById('tabJp').textContent === '일본어');
const jaInfo = paneText('info');
/* 판매용 빌드는 개인 이름(윤식)을 '학습자'로 바꾼다. 둘 중 하나면 통과다. */
t('일본 인포 읽기 화자는 店主 그대로', jaInfo.includes('店主') && /윤식|학습자/.test(jaInfo));
t('일본 인포 읽기 상황은 후쿠오카', jaInfo.includes('후쿠오카의'));
t('일본 프리토킹은 이자카야 그대로', paneText('tools').includes('이자카야 프리토킹'));
t('일본 오디오는 일본어로', paneText('audio').includes('일본어로 두 번씩'));
t('일본 화면에는 일본 글자가 있음', JA.test(paneText('today')));
/* 후리가나는 가나 전용이다. 일본어에서만 나와야 한다. */
t('일본 오늘 화면에 후리가나 있음', d.getElementById('jpPane').innerHTML.includes('<ruby'));

/* ── 분류 칩 이름 ──────────────────────────────────────────────────────
   파리 가는 사람 화면에 '후쿠오카권' 칩이 뜨면 안 된다.
   (칩을 그리는 함수는 뒤에서 다시 정의된다 — 살아 있는 쪽을 봐야 한다) */
w.eval("foodMap.dest='파리';fmSetCountry('FR');showTab('collect');renderFoodMap();");
const chips = [...d.querySelectorAll('#tab-collect .fm-cats button')].map((x) => x.textContent);
t('칩에 후쿠오카권 없음', chips.length > 0 && !chips.includes('후쿠오카권'));
t('칩이 목적지를 따라감', chips.includes('파리권'));
w.eval("foodMap.dest='후쿠오카';fmSetCountry('JP');renderFoodMap();");
const jchips = [...d.querySelectorAll('#tab-collect .fm-cats button')].map((x) => x.textContent);
t('일본이면 후쿠오카권 그대로', jchips.includes('후쿠오카권'));

t('최종 런타임 오류 0', errs.length === 0);
if (errs.length) console.log('  ', errs.slice(0, 3));
console.log(fail ? ('\n실패 ' + fail + '건') : '\n전체 통과');
process.exit(fail ? 1 : 0);
