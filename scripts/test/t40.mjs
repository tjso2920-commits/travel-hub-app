/**
 * 20개국 전수 검사.
 *
 * 프랑스 하나만 돌려보고 다섯 군데를 고쳤는데, 나머지 19개국은 안 돌려봤었다.
 * 전부 돌려 보니 두 가지가 더 나왔다 — 분류 칩·배지의 '바·이자카야'(19개국 전부),
 * 그리고 필요 없이 일본을 언급하던 안내 문구 둘.
 *
 * 그래서 이제 나라를 하나씩 다 돌려 모든 탭·모든 하위 화면을 그리고,
 * **일본에서만 의미가 있는 말이 새는지**를 통째로 본다.
 * 나라를 하나 늘리거나 화면을 하나 만들면 여기서 자동으로 걸린다.
 */

import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs';
const file = process.argv[2] || 'src/index.html';
const errs = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => { if (!/scrollTo|Not implemented|Could not parse CSS/.test(e.message)) errs.push(e.message); });
const dom = new JSDOM(fs.readFileSync(file, 'utf8'), { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: 'https://local.test/' });
const w = dom.window; const d = w.document;
await new Promise((r) => setTimeout(r, 800));
w.alert = () => {}; w.confirm = () => true; w.Element.prototype.scrollIntoView = function () {};

/** 새면 안 되는 것들. 나라마다 무엇이 샜는지 그대로 모은다. */
const LEAK = [
  ['일본 글자', /[぀-ヿ]|[一-鿿]/],
  ['"일본"', /일본/],
  ['후쿠오카', /후쿠오카/],
  ['하카타·텐진·나카스', /하카타|텐진|나카스|다이묘|야쿠인|이토시마/],
  ['이자카야·야타이', /이자카야|야타이/],
  ['엔 단위', /\d[\d,]*엔(?![어])/],
  ['일본 음식', /스시|사시미|라멘|모츠나베|니혼슈|쇼추|야키토리|우동|소바|교자|명란/],
  ['JLPT', /N[345]\b|JLPT/],
  ['하카타벤', /하카타벤/]
];
const COUNTRIES = w.eval('JSON.stringify(FM_COUNTRIES)');
const rows = JSON.parse(COUNTRIES).filter((x) => x[0] !== 'JP');

/** 그 나라 회화팩을 AI 결과와 같은 모양으로 넣는다 */
function seed(code, cc, dest) {
  w.eval(`
    foodMap.dest=${JSON.stringify(dest)}; foodMap.destIata='XXX';
    foodMap.setupSeen=true; foodMap.setupDone=true; foodMap.groupBy='cat';
    foodMap.places=[
     {id:'p1',name:'Sample Restaurant',cat:'맛집·식당',kind:'해산물',region:'중심가',lat:1.01,lng:2.01,address:'1 Main St',note:'메모'},
     {id:'p2',name:'Sample Bar',cat:'바·이자카야',lat:1.02,lng:2.02},
     {id:'p3',name:'Sample Spa',cat:'마사지·스파',lat:1.03,lng:2.03},
     {id:'p4',name:'Sample Shop',cat:'쇼핑',lat:1.04,lng:2.04,visited:true},
     {id:'p5',name:'Sample Clinic',cat:'약국·병원',lat:1.05,lng:2.05}];
    foodMap.hotel={name:'숙소',lat:1.0,lng:2.0}; foodMap.originMode='hotel';
    foodMap.selected='p1';
    bgSetTotal(800000); bgSetDays(4);
    save('foodmap_v1',foodMap);
    /* 여기는 사용자가 나라를 '바꾸는' 흉내가 아니라 검사할 상태를 세우는 것이다.
       fmSetCountry 를 쓰면 새 여행 확인창이 떠서 방금 세운 장소가 지워진다. */
    foodMap.destCountry=${JSON.stringify(cc)}; save('foodmap_v1',foodMap); renderFoodMap();
    jpAIPacks.langs={${JSON.stringify(code)}:{weeks:LANG_THEMES.map(function(th){
      return {t:th[0],s:th.slice(1),l:th.slice(1).map(function(sub){
        return {j:'Sample local sentence',k:'샘플 읽는 소리',m:'보기 뜻 ('+sub+')'};})};
    }),at:TODAY,dest:${JSON.stringify(dest)},ai:true,sex:'m'}};
    save('jp_packs_v1',jpAIPacks);
    jpState.pointer=3; jpState.srs={}; jpReviewOpen=true; jpReviewQueue=[];
    jpSession(2).lines.forEach(function(x){jpState.srs[x.id]={due:TODAY,box:0};});
    save('jp_state_v1',jpState);
    startApp(); if(typeof setupClose==='function')setupClose();
  `);
}

/** 화면 하나를 그리고 글자를 뽑는다 */
function screen(name, js, sel) {
  try { w.eval(js); } catch (e) { return { name, err: String(e.message || e), txt: '' }; }
  const el = d.querySelector(sel);
  if (!el) return { name, txt: '', err: null };
  /* 화면에 안 보이는 것은 빼야 한다. <script> 안의 소스 문자열이 잡히면 전부 거짓 경보가 된다. */
  const c = el.cloneNode(true);
  c.querySelectorAll('script,style,template').forEach((x) => x.remove());
  return { name, txt: c.textContent.replace(/\s+/g, ' ').trim(), err: null };
}
function screensFor() {
  return [
    screen('담기', "showTab('collect');renderFoodMap();", '#tab-collect'),
    screen('일정', "showTab('plan');renderFoodMap();", '#tab-plan'),
    screen('지금 여행', "showTab('now');renderFoodMap();", '#tab-now'),
    screen('공부:오늘', "showTab('jp');jpMode='today';renderJapanese();", '#tab-jp'),
    screen('공부:복습', "jpMode='review';jpReviewQueue=[];renderJapanese();", '#jpPane'),
    screen('공부:오디오', "jpMode='audio';renderJapanese();", '#jpPane'),
    screen('공부:인포', "jpMode='info';renderJapanese();", '#jpPane'),
    screen('공부:취침', "jpMode='bed';renderJapanese();", '#jpPane'),
    screen('공부:실전AI', "jpMode='tools';renderJapanese();", '#jpPane'),
    screen('장소 상세', "showTab('collect');foodMap.selected='p1';fmRenderSpotTools();fmSpotJapanese('p1');", '#fmSpotTools'),
    screen('회화팩 없음', "jpAIPacks.langs={};jpMode='today';renderJapanese();", '#tab-jp'),
    screen('설정', "showTab('collect');renderFoodMap();if(typeof ovOpen==='function')ovOpen('set');", '#ovSet'),
    screen('처음 설정', "setupShow('setup');", '#setupWrap'),
    screen('첫 화면', "showLanding();", '#gateWrap'),
    screen('통역', "if(typeof setupClose==='function')setupClose();showTab('now');renderFoodMap();", '#trCard')
  ];
}

const found = {};
let total = 0;
for (const [cc, kname, code] of rows) {
  const before = errs.length;
  seed(code, cc, kname + ' 시내');
  for (const s of screensFor()) {
    total++;
    if (s.err) { (found['런타임 오류'] = found['런타임 오류'] || []).push(`${kname} ${s.name}: ${s.err}`); continue; }
    if (!s.txt || s.txt.length < 15) { (found['빈 화면'] = found['빈 화면'] || []).push(`${kname} ${s.name}`); continue; }
    for (const [label, re] of LEAK) {
      const m = s.txt.match(new RegExp(re.source, 'g'));
      if (m) {
        const k = label;
        found[k] = found[k] || [];
        found[k].push(`${kname}(${cc}) ${s.name} → ${[...new Set(m)].slice(0, 4).join(', ')}`);
      }
    }
  }
  if (errs.length > before) (found['jsdom 오류'] = found['jsdom 오류'] || []).push(`${kname}: ${errs[before]}`);
}

let fail = 0;
const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

t(`${rows.length}개국 × 화면 ${total / rows.length}개를 다 그림`, total >= rows.length * 10);
for (const [label] of LEAK) {
  /* '일본'은 처음 설정의 나라 고르는 칸에 당연히 있다. 그것만 빼고 본다. */
  const hits = (found[label] || []).filter((x) => !(label === '"일본"' && / 처음 /.test(x)));
  t(`${label} 안 샘`, hits.length === 0);
  if (hits.length) hits.slice(0, 5).forEach((x) => console.log('        ·', x));
}
for (const k of ['런타임 오류', 'jsdom 오류', '빈 화면']) {
  t(`${k} 없음`, !(found[k] || []).length);
  (found[k] || []).slice(0, 5).forEach((x) => console.log('        ·', x));
}
console.log(fail ? ('\n실패 ' + fail + '건') : '\n전체 통과');
process.exit(fail ? 1 : 0);
