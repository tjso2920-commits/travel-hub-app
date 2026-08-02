/**
 * 돈이 실제로 오가는 길 — 정품 등록 · 무료 한도 · 백업.
 *
 * 이게 깨지면 물건을 못 판다. 그런데 여태 끝까지 밟아 본 적이 한 번도 없었다.
 * 산 사람이 실제로 겪는 순서 그대로 간다 —
 * 코드를 받아 넣고 · 가짜는 막히고 · 30곳에서 걸리고 · 사면 풀리고 ·
 * 백업을 받아 다른 폰에 넣어도 그대로 나오되 **정품 열쇠는 안 따라간다.**
 *
 * 열쇠가 백업에 섞여 나가면 백업 파일 하나로 무한 복제가 된다. 그게 제일 중요하다.
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs';
const file = process.argv[2] || 'private/personal.html';
const errs = []; const vc = new VirtualConsole();
vc.on('jsdomError', (e) => { if (!/scrollTo|Not implemented/.test(e.message)) errs.push(e.message); });
const dom = new JSDOM(fs.readFileSync(file, 'utf8'), { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: 'https://local.test/' });
const w = dom.window; const d = w.document; await new Promise((r) => setTimeout(r, 700));
let alerts = []; w.alert = (m) => alerts.push(String(m)); w.confirm = () => true; w.prompt = () => '';
w.Element.prototype.scrollIntoView = function () {};
let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

/* 화면 입력칸에 넣고 실제 licSave() 를 태운다 — 산 사람이 밟는 그 길이다 */
w.eval(`function licPut(code){
  var el=document.getElementById('licIn');
  if(!el){el=document.createElement('input');el.id='licIn';document.body.appendChild(el);}
  el.value=code; licSave();
}`);

/* ── 1. 이름을 받아 넣는 길 ──────────────────────────────────────────── */
const code = w.eval("licMake('김철수','2026-08-01')");
t('코드가 만들어짐', !!code && code.includes('.'));
w.eval(`licPut(${JSON.stringify(code)})`);
t('그 코드를 넣으면 풀림', w.eval('licOn()') === true);
t('이름이 화면 도장에 나옴', w.eval('licStamp()').includes('김철수'));
t('산 날짜도 나옴', w.eval('licStamp()').includes('2026-08-01'));

/* 한 글자만 바꾼 가짜 — 여기가 뚫리면 코드가 돌아다닌다 */
w.eval("delete foodMap.lic;save('foodmap_v1',foodMap);");
const fake = code.slice(0, -1) + (code.slice(-1) === 'a' ? 'b' : 'a');
w.eval(`licPut(${JSON.stringify(fake)})`);
t('한 글자 바꾼 가짜는 안 통함', w.eval('licOn()') === false);

/* 이름 부분만 바꿔치기한 것도 막혀야 한다 */
const other = w.eval("licMake('박영희','2026-08-01')");
const mixed = other.split('.')[0] + '.' + code.split('.')[1];
w.eval(`licPut(${JSON.stringify(mixed)})`);
t('이름만 바꿔치기한 것도 안 통함', w.eval('licOn()') === false);

w.eval(`licPut(${JSON.stringify(other)})`);
t('다른 사람 코드는 그 사람 이름으로 풀림', w.eval("licName()") === '박영희');

/* 아무거나 넣어도 죽으면 안 된다 */
let died = false;
try {
  ['', 'abc', '....', 'a.b.c', '!!!!', '한글코드', 'x'.repeat(500), '   ', '.'].forEach((x) => {
    w.eval(`licPut(${JSON.stringify(x)})`);
  });
} catch (e) { died = true; }
t('이상한 코드를 넣어도 안 죽음', !died);

/* ── 2. 무료 한도 ────────────────────────────────────────────────────── */
w.eval("delete foodMap.lic;foodMap.places=[];save('foodmap_v1',foodMap);");
const SALE = w.eval('SALE_MODE') === true;
if (SALE) {
  t('안 산 사람은 30곳', w.eval('licRoom()') === 30);
  const csv29 = 'Title,Note,URL\n' + Array.from({ length: 29 }, (_, i) => '곳' + i + ',,').join('\n');
  w.eval(`fmMerge(fmCsv(${JSON.stringify(csv29)}))`);
  t('29곳 넣으면 1자리 남음', w.eval('licRoom()') === 1);

  const csv10 = 'Title,Note,URL\n' + Array.from({ length: 10 }, (_, i) => '더' + i + ',,').join('\n');
  const r = JSON.parse(w.eval(`JSON.stringify(fmMerge(fmCsv(${JSON.stringify(csv10)})))`));
  t('30곳을 넘겨 담기지 않음', w.eval('foodMap.places.length') === 30);
  t('몇 곳이 막혔는지 알려줌', r.blocked === 9);

  w.eval("if(typeof renderLicBar==='function')renderLicBar();");
  const barTxt = (d.getElementById('licBar') || {}).textContent || '';
  t('막혔다는 안내가 화면에 뜸', barTxt.length > 5);
  t('안내에 무엇을 하면 되는지 있음', /정품|코드/.test(barTxt));
  t('담아 둔 것은 그대로 쓸 수 있다고 적혀 있음', /그대로/.test(barTxt));

  w.eval(`licPut(${JSON.stringify(w.eval("licMake('구매자','2026-08-01')"))})`);
  t('사고 나면 제한이 풀림', w.eval('licRoom()') === Infinity);
  const csv120 = 'Title,Note,URL\n' + Array.from({ length: 120 }, (_, i) => '추가' + i + ',,').join('\n');
  w.eval(`fmMerge(fmCsv(${JSON.stringify(csv120)}))`);
  t('산 뒤에는 나머지도 다 담김', w.eval('foodMap.places.length') === 150);
} else {
  /* 개인용은 제한이 없다 — 그게 맞다 */
  t('개인용은 제한 없음', w.eval('licRoom()') === Infinity);
  const csv = 'Title,Note,URL\n' + Array.from({ length: 60 }, (_, i) => '곳' + i + ',,').join('\n');
  w.eval(`fmMerge(fmCsv(${JSON.stringify(csv)}))`);
  t('개인용은 60곳도 다 담김', w.eval('foodMap.places.length') === 60);
}

/* ── 3. 백업 받아서 다시 넣기 ────────────────────────────────────────── */
w.eval(`
  foodMap.dest='파리'; fmSetCountry('FR');
  foodMap.d1='2026-10-25'; foodMap.d2='2026-10-29';
  foodMap.hotel={name:'숙소',lat:48.86,lng:2.35}; foodMap.originMode='hotel';
  foodMap.places[0].note='꼭 가야 함'; foodMap.places[0].fav=true; foodMap.places[1].visited=true;
  bgSetTotal(800000); bgSetDays(4); save('foodmap_v1',foodMap);
`);
const bk = JSON.parse(w.eval('JSON.stringify(bkFoodMap())'));
t('백업에 장소·목적지·나라·숙소·날짜가 다 들어감',
  ['places', 'dest', 'destCountry', 'hotel', 'd1', 'd2'].every((k) => k in bk));
/* 여기가 제일 중요하다 — 백업 파일 하나로 무한 복제가 되면 안 된다 */
t('백업에 정품 열쇠는 안 들어감', !bk.lic);
t('대신 누구 것인지만 적힘', typeof bk.licensedTo === 'string' || bk.licensedTo === undefined);

const before = w.eval("JSON.stringify({n:foodMap.places.length,fav:foodMap.places[0].fav,note:foodMap.places[0].note,dest:foodMap.dest,cc:foodMap.destCountry})");
w.eval("foodMap={places:[],filter:'후쿠오카권'};save('foodmap_v1',foodMap);");
w.eval(`(function(){var o=${JSON.stringify(bk)};Object.keys(o).forEach(function(k){foodMap[k]=o[k];});save('foodmap_v1',foodMap);renderFoodMap();})()`);
const after = w.eval("JSON.stringify({n:foodMap.places.length,fav:foodMap.places[0].fav,note:foodMap.places[0].note,dest:foodMap.dest,cc:foodMap.destCountry})");
t('지우고 백업을 넣으면 그대로 돌아옴', before === after);

/* ── 4. 빨리 두 번 눌러도 ────────────────────────────────────────────── */
w.eval("foodMap.places=[];foodMap.lic={name:'검사',date:'2026-01-01'};save('foodmap_v1',foodMap);");
const one = 'Title,Note,URL\n"같은 가게",,"https://maps.google.com/?q=1,2"';
w.eval(`fmMerge(fmCsv(${JSON.stringify(one)}));fmMerge(fmCsv(${JSON.stringify(one)}));fmMerge(fmCsv(${JSON.stringify(one)}))`);
t('같은 파일을 세 번 넣어도 한 곳만 담김', w.eval('foodMap.places.length') === 1);

t('최종 런타임 오류 0', errs.length === 0);
if (errs.length) console.log('  ', errs.slice(0, 3));
console.log(fail ? ('\n실패 ' + fail + '건') : '\n전체 통과');
process.exit(fail ? 1 : 0);
