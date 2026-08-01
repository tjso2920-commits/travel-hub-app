/**
 * 권역 필터 — 산 사람이 앱을 처음 열었을 때 목록이 보이는가.
 *
 * 이게 지금까지 나온 것 중 제일 크다. 목록을 넣고 앱을 열면 기본 필터가 '권역'인데,
 * 권역 판정이 **후쿠오카 좌표 범위 고정**이었다. 결과:
 *
 *   후쿠오카 20/20 · 도쿄 0/20 · 오사카 0/20 · 교토 0/20 · 삿포로 0/20 · 오키나와 0/20
 *
 * 일본이 제일 큰 시장인데 도쿄·오사카 가는 사람이 전부 **빈 화면**을 봤다.
 * 파리·방콕도 마찬가지였다 — 구글맵 주소는 "Paris, France" 라 한글 '파리'로는 안 걸린다.
 * 산 사람은 앱이 고장 났다고 생각한다. 환불 사유다.
 *
 * 규칙 셋을 여기서 못 박는다.
 *  1. 후쿠오카 좌표 범위는 **목적지가 후쿠오카일 때만** 쓴다
 *  2. 다른 도시는 주소로 맞춘다 — 東京·Tokyo 처럼 현지어·영어도 같이 본다
 *  3. 그래도 잴 근거가 없으면 **빼지 않는다**
 *     ("이 권역인지 모르겠다" 와 "이 권역이 아니다" 는 다르다)
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs';
const file = process.argv[2] || 'private/personal.html';
const errs = []; const vc = new VirtualConsole();
vc.on('jsdomError', (e) => { if (!/scrollTo|Not implemented/.test(e.message)) errs.push(e.message); });
const dom = new JSDOM(fs.readFileSync(file, 'utf8'), { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: 'https://local.test/' });
const w = dom.window; await new Promise((r) => setTimeout(r, 700));
let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };
w.alert = () => {}; w.confirm = () => true; w.Element.prototype.scrollIntoView = function () {};

/** 목록만 넣고 숙소는 아직 안 넣은 상태 — 산 사람이 처음 여는 그 상황 */
function firstRun(city, cc, lat, lng, addr) {
  w.eval(`
    foodMap.dest=${JSON.stringify(city)}; foodMap.destCountry=${JSON.stringify(cc)};
    foodMap.lic={name:'검사',date:'2026-01-01'};
    delete foodMap.hotel; foodMap.originMode='gps';
    foodMap.filter='후쿠오카권'; foodMap.q=''; delete foodMap.cluster;
    foodMap.region='전체 지역'; foodMap.kind='전체 음식·술'; foodMap.status='기본 상태';
    foodMap.places=Array.from({length:20},function(_,i){return{id:'p'+i,name:'가게'+i,
     cat:'맛집·식당',lat:${lat}+i*0.002,lng:${lng}+i*0.002,address:${JSON.stringify(addr)}};});
    save('foodmap_v1',foodMap); renderFoodMap();
  `);
  return w.eval('fmFiltered().length');
}

/* ── 처음 열었을 때 목록이 보이는가 ─────────────────────────────────── */
const CITIES = [
  ['후쿠오카', 'JP', 33.59, 130.40, '福岡市博多区'],
  ['도쿄', 'JP', 35.68, 139.76, '東京都渋谷区'],
  ['오사카', 'JP', 34.69, 135.50, '大阪市中央区'],
  ['교토', 'JP', 35.01, 135.76, '京都市東山区'],
  ['삿포로', 'JP', 43.06, 141.35, '札幌市中央区'],
  ['오키나와', 'JP', 26.21, 127.68, '那覇市'],
  ['파리', 'FR', 48.85, 2.34, '12 Rue de Rivoli, Paris, France'],
  ['방콕', 'TH', 13.75, 100.50, 'Sukhumvit Rd, Bangkok'],
  ['뉴욕', 'US', 40.71, -74.0, 'Broadway, New York, NY'],
  ['타이베이', 'TW', 25.03, 121.56, '台北市信義區'],
  ['이스탄불', 'TR', 41.01, 28.97, 'Sultanahmet, Istanbul'],
  ['두바이', 'AE', 25.20, 55.27, 'Sheikh Zayed Rd, Dubai']
];
CITIES.forEach(([city, cc, lat, lng, addr]) => {
  t(`${city} — 처음 열어도 20곳 다 보임`, firstRun(city, cc, lat, lng, addr) === 20);
});

/* 주소가 아예 없어도 빼면 안 된다 — 잴 근거가 없는 것뿐이다 */
t('주소가 비어 있어도 안 사라짐', firstRun('오사카', 'JP', 34.69, 135.50, '') === 20);
t('모르는 도시여도 안 사라짐', firstRun('어딘가시', 'FR', 10, 10, '') === 20);

/* ── 그래도 권역 필터가 제 일은 해야 한다 ───────────────────────────── */
w.eval(`
  foodMap.dest='후쿠오카'; foodMap.destCountry='JP'; foodMap.filter='후쿠오카권';
  delete foodMap.hotel; foodMap.originMode='gps';
  foodMap.places=[{id:'a',name:'하카타집',cat:'맛집·식당',lat:33.59,lng:130.40,address:'福岡市'},
                  {id:'b',name:'도쿄집',cat:'맛집·식당',lat:35.68,lng:139.76,address:'東京都'}];
  save('foodmap_v1',foodMap); renderFoodMap();
`);
t('후쿠오카에서 도쿄 가게는 걸러짐', w.eval("JSON.stringify(fmFiltered().map(function(p){return p.name;}))") === '["하카타집"]');

/* 숙소를 넣으면 거리로 거른다 */
w.eval(`
  foodMap.dest='파리'; foodMap.destCountry='FR';
  foodMap.hotel={name:'숙소',lat:48.86,lng:2.35}; foodMap.originMode='hotel';
  foodMap.places=[{id:'c',name:'파리집',cat:'맛집·식당',lat:48.85,lng:2.34,address:''},
                  {id:'d',name:'먼집',cat:'맛집·식당',lat:43.30,lng:5.37,address:''}];
  save('foodmap_v1',foodMap); renderFoodMap();
`);
t('숙소가 있으면 먼 곳은 걸러짐', w.eval("JSON.stringify(fmFiltered().map(function(p){return p.name;}))") === '["파리집"]');

/* 현지어·영어 도시 이름도 맞춰야 필터가 쓸모가 있다 */
w.eval("foodMap.dest='도쿄';foodMap.destCountry='JP';delete foodMap.hotel;foodMap.originMode='gps';");
t('도쿄 — 東京 로 적힌 주소를 알아봄', w.eval("fmInArea({address:'東京都新宿区',lat:0,lng:0})") === true);
t('도쿄 — Tokyo 로 적힌 주소를 알아봄', w.eval("fmInArea({address:'Shibuya, Tokyo, Japan',lat:0,lng:0})") === true);
w.eval("foodMap.dest='방콕';foodMap.destCountry='TH';");
t('방콕 — Bangkok 을 알아봄', w.eval("fmInArea({address:'Sukhumvit, Bangkok',lat:0,lng:0})") === true);

/* ── 저장된 값이 깨져도 앱이 죽으면 안 된다 ──────────────────────────
   여행지에서 하얀 화면이 뜨면 손 쓸 방법이 없다. */
w.eval("foodMap.places='망가짐';");
let died = false;
try { w.eval('renderFoodMap();'); } catch (e) { died = true; }
t('목록이 깨져도 안 죽음', !died);
t('깨진 목록은 빈 목록으로 되돌림', w.eval('Array.isArray(foodMap.places)') === true);

/* 회화팩 주차가 비어 있어도 죽으면 안 된다 */
w.eval("fmSetCountry('FR');jpAIPacks.langs={fr:{weeks:[{t:'a',s:[],l:[]}]}};jpState.pointer=3;");
let died2 = false;
try { w.eval("showTab('jp');jpMode='today';renderJapanese();"); } catch (e) { died2 = true; }
t('회화팩 주차가 비어도 안 죽음', !died2);
t('빈 주차는 문장 0개로 넘어감', w.eval('jpSession(3).lines.length') === 0);

t('최종 런타임 오류 0', errs.length === 0);
if (errs.length) console.log('  ', errs.slice(0, 3));
console.log(fail ? ('\n실패 ' + fail + '건') : '\n전체 통과');
process.exit(fail ? 1 : 0);
