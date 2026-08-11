/**
 * 만든 사람조차 헤맨 두 곳 — 여기가 막히면 물건이 안 팔린다.
 *
 * 1. **구글에서 파일 받는 게 너무 어려웠다.**
 *    "모두 선택 해제" 를 안 누르면 구글 데이터가 통째로 나오고,
 *    압축을 풀면 csv 가 여러 개인데 **어느 걸 고를지** 안 적혀 있었다.
 *    실제로 만든 사람이 '별표 표시된 장소.csv' 를 골라서 137곳 중 20곳도 안 들어왔다.
 *
 * 2. **30곳에서 막혔는데 코드 넣는 데를 못 찾았다.**
 *    안내가 "설정(⚙)에서 정품 코드를 넣으면" — **글자뿐이었다.**
 *    정품 칸은 화면 맨 아래라 137곳 목록을 다 내려야 나온다.
 *    돈 내고 산 사람이 코드를 못 넣으면 그건 환불 사유다.
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
let alerts = []; let asked = [];
w.alert = (m) => alerts.push(String(m));
w.confirm = (m) => { asked.push(String(m)); return true; };
w.Element.prototype.scrollIntoView = function () {};

/* ── 1. 어느 csv 를 고를지 화면에 적혀 있는가 ─────────────────────────── */
const guide = w.eval('(function(){var h="";(GUIDE_STEPS()||[]).forEach(function(s){h+=(s.how||"");});return h;})()');
t('구글 화면에서 먼저 뭘 누를지 있음', guide.includes('모두 선택 해제'));
t('무엇 하나만 체크할지 있음', guide.includes('저장됨'));
t('zip 을 풀어야 한다고 있음', /압축 해제/.test(guide));
t('풀린 폴더 경로가 있음', guide.includes('Takeout') && guide.includes('저장됨'));
/* 여기가 사람이 제일 많이 틀리는 자리다 */
t('고를 csv 를 알려줌', /목록 이름/.test(guide));
t('고르면 안 되는 csv 를 이름으로 찍어 줌',
  guide.includes('즐겨찾기') && guide.includes('별표 표시된 장소'));
t('여러 개 넣어도 겹치지 않는다고 알려줌', /겹쳐 들어가지 않/.test(guide));

/* ── 2. 적게 들어오면 그걸 의심하게 해 주는가 ─────────────────────────── */
t('불러오기 결과 안내가 따로 있음', w.eval("typeof fmImportDone==='function'"));
alerts = [];
w.eval("foodMap.listName='별표 표시된 장소';fmImportDone({added:12,updated:0,skipped:0,blocked:0});");
t('적게 들어오면 다른 파일일 수 있다고 알려줌', /다른 목록 파일/.test(alerts.join('')));
t('그 안내에 고르면 안 될 이름이 적혀 있음', /즐겨찾기/.test(alerts.join('')));

alerts = [];
w.eval("fmImportDone({added:137,updated:0,skipped:0,blocked:0});");
t('많이 들어오면 쓸데없는 말 안 함', !/다른 목록 파일/.test(alerts.join('')));

/* ── 3. 막힌 자리에서 바로 코드를 넣게 데려다 주는가 ─────────────────── */
t('데려다 주는 길이 있음', w.eval("typeof licGo==='function'"));
t('막혔을 때 물어보는 길이 있음', w.eval("typeof licAskGo==='function'"));

asked = []; alerts = [];
w.eval("foodMap.listName='여행 계획';fmImportDone({added:30,updated:0,skipped:0,blocked:107});");
t('막히면 몇 곳이 막혔는지 알려줌', /107곳/.test(asked.join('') + alerts.join('')));
t('막히면 지금 넣겠냐고 물어봄', /지금 정품 코드를 넣으시겠어요/.test(asked.join('')));
t('예를 누르면 설정이 열림', d.getElementById('ovSet').classList.contains('show'));
t('예를 누르면 정품 칸이 실제로 화면에 있음', !!d.getElementById('licIn'));

await new Promise((r) => setTimeout(r, 400));
t('정품 칸이 눈에 띄게 표시됨', (d.getElementById('licIn').className || '').includes('lic-hi'));

/* 막히지 않았으면 묻지 않는다 */
asked = [];
w.eval("fmImportDone({added:5,updated:0,skipped:0,blocked:0});");
t('안 막혔으면 안 물어봄', asked.length === 0);

/* ── 4. 맨 위에도 보이는가 (맨 아래까지 내려야 보이면 못 찾는다) ─────── */
const SALE = w.eval('SALE_MODE') === true;
t('맨 위 띠 함수가 있음', w.eval("typeof licTopBarHTML==='function'"));
w.eval("delete foodMap.lic;foodMap.places=[{id:'a',name:'가게',cat:'맛집·식당',lat:1,lng:2}];save('foodmap_v1',foodMap);");
const top = w.eval('licTopBarHTML()');
if (SALE) {
  t('안 산 사람에게는 맨 위에도 뜸', top.includes('정품 코드 넣기'));
  t('몇 곳 남았는지 같이 보여줌', /1 \/ 30/.test(top));
  t('누르면 바로 가게 연결돼 있음', top.includes('licGo()'));
  w.eval(`licPutTest=function(c){var e=document.getElementById('licIn');e.value=c;licSave();};
          licPutTest(licMake('검사','2026-08-01'));`);
  t('산 사람에게는 안 보임', w.eval('licTopBarHTML()') === '');
} else {
  t('개인용에는 안 보임', top === '');
}

/* 담기 화면에 실제로 박혀 있는가 — 함수만 있고 안 불리면 소용없다 */
t('담기 화면이 맨 위 띠를 부름', /licTopBarHTML\(\)/.test(html.split('\n').filter((l) => l.includes('장소 가져오기')).join('')));

/* ── 5. 손가락으로 누를 수 있는 크기인가 ─────────────────────────────── */
t('맨 위 띠 버튼이 44px 이상', /\.lic-top button\{min-height:44px/.test(html));

t('최종 런타임 오류 0', errs.length === 0);
if (errs.length) console.log('  ', errs.slice(0, 3));
console.log(fail ? ('\n실패 ' + fail + '건') : '\n전체 통과');
process.exit(fail ? 1 : 0);
