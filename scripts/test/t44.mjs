/**
 * 데이터가 사라지지 않게 · 새 버전이 왔다고 알려주게.
 *
 * 8번째 검사에서 나온 것들. 앞의 일곱 가지가 전부 못 보던 종류다.
 *
 * 1. **저장이 막혀도 아무도 몰랐다.**
 *    save() 는 실패하면 false 를 돌려주는데 **부르는 곳 어디에서도 확인하지 않았다.**
 *    아이폰 사파리 시크릿 모드면 저장이 아예 막힌다 — 화면은 멀쩡히 돌고,
 *    앱을 닫는 순간 그날 담은 게 통째로 없어진다.
 *    "담아 놨는데 다 사라졌다" 는 산 사람 입장에서 최악이다.
 *
 *    크기는 문제가 아니었다 — 137곳 + 90일 진도 + 회화팩 3나라 + 지출 200건을
 *    다 넣어도 155KB, 사파리 한계(5MB)의 3% 다. 문제는 **막혔을 때 말을 안 하는 것**이었다.
 *
 * 2. **새 버전을 올려도 사용자는 한 번은 옛 화면을 봤다.**
 *    비행기 안에서도 열려야 해서 캐시를 먼저 쓴다 — 그 대가다. 없앨 수는 없다.
 *    대신 왔다고 알려 주고 한 번에 새로고침하게 한다.
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

/* ── 저장이 막혔을 때 ────────────────────────────────────────────────── */
const bar = () => d.getElementById('saveBar');
t('저장 경고 칸이 있음', !!bar());
t('정상일 때는 안 뜸', !bar().classList.contains('on'));

/* 시크릿 모드처럼 저장을 막는다 */
w.eval(`
  window.__origSet = Storage.prototype.setItem;
  Storage.prototype.setItem = function(){ throw new Error('QuotaExceededError'); };
`);
t('막히면 save 가 false 를 돌려줌', w.eval("save('foodmap_v1',foodMap)") === false);
t('막히면 경고가 뜸', bar().classList.contains('on'));
const txt = bar().textContent;
t('무슨 일인지 적혀 있음', txt.includes('사라집니다'));
t('어떻게 하라고 적혀 있음', txt.includes('시크릿 모드'));

/* 막힌 채로도 앱은 계속 돌아야 한다 — 여기서 죽으면 더 나쁘다 */
let died = false;
try {
  w.eval("foodMap.places=[{id:'a',name:'가게',cat:'맛집·식당',lat:1,lng:2}];renderFoodMap();showTab('jp');renderJapanese();");
} catch (e) { died = true; }
t('막힌 채로도 앱이 안 죽음', !died);

w.eval("Storage.prototype.setItem = window.__origSet;");

/* 경고는 한 번만 — 계속 띄우면 그것대로 못 쓴다 */
w.eval("document.getElementById('saveBar').classList.remove('on');");
w.eval("save('foodmap_v1',foodMap);");
t('저장이 되면 다시 안 뜸', !bar().classList.contains('on'));

/* ── 실제로 쓸 만큼 담아도 저장이 되는가 ─────────────────────────────── */
const used = w.eval(`(function(){
  foodMap.lic={name:'검사',date:'2026-01-01'};
  foodMap.places=Array.from({length:137},function(_,i){return{id:'q'+i,
    name:'아주 긴 가게 이름을 넣어 본다 '+i,cat:'맛집·식당',kind:'해산물',region:'중심가',
    lat:33.59+i*0.001,lng:130.40+i*0.001,
    address:'福岡県福岡市博多区中洲'+i+'丁目'+i+'番地 아주 긴 주소를 넣어 본다',
    note:'여기 가면 이거 시켜야 한다고 적어 둔 긴 메모 '+i,
    url:'https://www.google.com/maps/place/aaaaaaaaaaaaaaaa/@33.59,130.40,17z',
    videos:[{name:'영상 '+i,short:'https://youtube.com/shorts/aaaaaaaaaaa',long:'https://youtube.com/watch?v=aaaaaaaaaaa'}],
    rating:4.3,ratingCount:1200,placeId:'ChIJ'+'a'.repeat(20)+i};});
  if(!save('foodmap_v1',foodMap))return -1;
  for(var i=0;i<90;i++)jpState.done[i]=TODAY;
  for(var x=0;x<104;x++)jpState.srs['w'+x]={due:TODAY,box:3};
  if(!save('jp_state_v1',jpState))return -1;
  var n=0;for(var k in localStorage)if(Object.prototype.hasOwnProperty.call(localStorage,k))n+=k.length+localStorage[k].length;
  return n;
})()`);
t('137곳 + 90일 진도가 저장됨', used > 0);
t('사파리 한계(5MB)에 한참 못 미침', used > 0 && used < 1024 * 1024);
console.log('        실제로 쓴 크기: ' + Math.round(used / 1024) + 'KB (한계의 ' + (used / 1024 / 5120 * 100).toFixed(1) + '%)');
t('저장하고 다시 읽어도 137곳 그대로', w.eval("load('foodmap_v1',{places:[]}).places.length") === 137);

/* ── 새 버전 알림 ────────────────────────────────────────────────────── */
t('새 버전 알림 칸이 있음', !!d.getElementById('verBar'));
t('평소에는 안 뜸', !d.getElementById('verBar').classList.contains('on'));
w.eval('verShow();');
t('새 버전이 오면 뜸', d.getElementById('verBar').classList.contains('on'));
t('새로고침 버튼이 있음', /verApply\(\)/.test(d.getElementById('verBar').innerHTML));
w.eval('verHide();');
t('닫으면 사라짐', !d.getElementById('verBar').classList.contains('on'));

/* 오프라인 캐시가 통째로 죽지 않게 하나씩 담는지 — sw.js 를 같이 본다 */
const sw = fs.readFileSync('src/sw.js', 'utf8');
t('sw: addAll 로 한 번에 담지 않음', !/cache\.addAll/.test(sw));
t('sw: 앱 본체는 반드시 담음', /const CORE\s*=/.test(sw) && sw.includes('./index.html'));
t('sw: 아이콘까지 담음', sw.includes('icon-192.png') && sw.includes('icon-512.png'));
t('sw: 새 버전을 앱에 알림', sw.includes("postMessage({ type: 'newVersion' })"));
t('sw: 비교용 응답을 미리 떠 둠', sw.includes('forCompare'));
t('sw: 바깥 주소는 가로채지 않음', sw.includes('url.origin !== self.location.origin'));

t('최종 런타임 오류 0', errs.length === 0);
if (errs.length) console.log('  ', errs.slice(0, 3));
console.log(fail ? ('\n실패 ' + fail + '건') : '\n전체 통과');
process.exit(fail ? 1 : 0);
