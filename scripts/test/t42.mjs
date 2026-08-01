/**
 * 가져오기에서 좌표 살려내기 — 이 앱에서 제일 큰 것.
 *
 * 구글맵 저장목록을 CSV 로 뽑으면 **위도·경도 칸이 없다.** 137곳 전부 좌표 0개였다.
 * 좌표가 없으면 지도·거리·오늘 동선·구역 자동 묶기가 전부 죽는다. 앱의 핵심이 죽는 것이다.
 *
 * 그런데 CSV 를 뜯어 보니 **URL 칸 안에 좌표가 들어 있는 경우가 많았다.**
 * 앱은 위도·경도 칸만 보고 있어서 그걸 통째로 버리고 있었다.
 * 꺼내 쓰면 Places API 를 안 사도 상당수가 살아난다.
 *
 * 여기서는 구글맵이 실제로 뱉는 주소 모양을 전부 넣고 하나씩 확인한다.
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs';
const file = process.argv[2] || 'private/personal.html';
const errs = []; const vc = new VirtualConsole();
vc.on('jsdomError', (e) => { if (!/scrollTo|Not implemented/.test(e.message)) errs.push(e.message); });
const dom = new JSDOM(fs.readFileSync(file, 'utf8'), { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: 'https://local.test/' });
const w = dom.window; await new Promise((r) => setTimeout(r, 700));
let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };
w.alert = () => {}; w.confirm = () => true;

const near = (a, b) => a !== null && Math.abs(a - b) < 0.0002;
function coord(u) { return JSON.parse(w.eval(`JSON.stringify(fmCoordFromUrl(${JSON.stringify(u)}))`)); }

/* ── 구글맵이 실제로 뱉는 주소 모양들 ────────────────────────────────── */
const OK = [
  ['장소 데이터(!3d!4d) — 제일 정확',
    'https://www.google.com/maps/place/Wat+Pho/@13.7465,100.4927,17z/data=!4m5!3m4!1s0x0!8m2!3d13.7466!4d100.4930', 13.7466, 100.4930],
  ['지도 중심(@)', 'https://www.google.com/maps/place/Wat+Pho/@13.7465,100.4927,17z', 13.7465, 100.4927],
  ['검색(?api=1&query=)', 'https://www.google.com/maps/search/?api=1&query=48.8529,2.3387', 48.8529, 2.3387],
  ['짧은 검색(?q=)', 'https://maps.google.com/?q=35.6812,139.7671', 35.6812, 139.7671],
  ['ll=', 'https://maps.google.com/maps?ll=37.5665,126.9780&z=15', 37.5665, 126.9780],
  ['center=', 'https://www.google.com/maps?center=41.0082,28.9784', 41.0082, 28.9784],
  ['길찾기 daddr=', 'https://maps.google.com/maps?daddr=1.3521,103.8198', 1.3521, 103.8198],
  ['%2C 로 인코딩된 쉼표', 'https://www.google.com/maps/search/?api=1&query=21.0285%2C105.8542', 21.0285, 105.8542],
  ['남반구·서반구(음수)', 'https://maps.google.com/?q=-33.8688,-151.2093', -33.8688, -151.2093]
];
OK.forEach(([label, url, lat, lng]) => {
  const c = coord(url);
  t('좌표 꺼냄 — ' + label, !!c && near(c.lat, lat) && near(c.lng, lng));
});

/* ── 꺼낼 게 없으면 조용히 없는 것으로 ───────────────────────────────── */
const NONE = [
  ['단축주소', 'https://goo.gl/maps/abcdef'],
  ['place_id 만', 'https://www.google.com/maps/place/?q=place_id:ChIJN1t_tDeuEmsRUsoyG83frY4'],
  ['이름만', 'https://www.google.com/maps/search/?api=1&query=Wat+Pho'],
  ['빈 값', ''],
  ['주소가 아예 없음', null],
  ['0,0 은 바다 한가운데 — 값이 빈 것', 'https://maps.google.com/?q=0,0'],
  ['말도 안 되는 위도', 'https://maps.google.com/?q=999,999']
];
NONE.forEach(([label, url]) => t('좌표 없음으로 처리 — ' + label, coord(url) === null));

/* ── CSV 를 통째로 넣어 본다 ─────────────────────────────────────────── */
const csv = ['Title,Note,URL',
  '"Le Comptoir du Relais",,"https://www.google.com/maps/search/?api=1&query=48.8529,2.3387"',
  '"Boulangerie Poilâne",,"https://maps.google.com/?q=48.8510,2.3260"',
  '"Wat Pho",,"https://www.google.com/maps/place/Wat+Pho/@13.7465,100.4927,17z"',
  '"Çiya Sofrası",,"https://goo.gl/maps/abcdef"'].join('\n');
w.eval("foodMap.places=[];foodMap.lic={name:'검사',date:'2026-01-01'};save('foodmap_v1',foodMap);");
w.eval(`fmMerge(fmCsv(${JSON.stringify(csv)}))`);
const got = JSON.parse(w.eval("JSON.stringify(foodMap.places.map(function(p){return {n:p.name,lat:p.lat,lng:p.lng,cat:p.cat};}))"));
t('네 곳 다 담김', got.length === 4);
t('좌표 있는 세 곳은 좌표가 들어옴', got.filter((x) => x.lat !== null && x.lng !== null).length === 3);
t('좌표 없는 한 곳은 좌표 없이 들어옴', got.filter((x) => x.lat === null).length === 1);
t('위도·경도가 뒤바뀌지 않음', near(got.find((x) => x.n === 'Wat Pho').lat, 13.7465));
t('분류도 같이 찍힘', got.find((x) => x.n === 'Wat Pho').cat === '관광·명소');

/* 칸에 좌표가 있으면 그 값이 이긴다 — 주소에서 꺼낸 것보다 정확하다 */
const csv2 = ['Title,Latitude,Longitude,URL',
  '"A",35.1,139.1,"https://maps.google.com/?q=1.0,2.0"'].join('\n');
const row = JSON.parse(w.eval(`JSON.stringify(fmCsv(${JSON.stringify(csv2)})[0])`));
t('칸에 든 좌표가 주소보다 우선', near(row.lat, 35.1) && near(row.lng, 139.1));

/* ── JSON·GeoJSON 도 같은 그물 ───────────────────────────────────────── */
const g1 = JSON.parse(w.eval(`JSON.stringify(fmObj({name:'B',url:'https://maps.google.com/?q=13.75,100.50'}))`));
t('JSON 도 주소에서 좌표를 꺼냄', near(g1.lat, 13.75) && near(g1.lng, 100.50));
const g2 = JSON.parse(w.eval(`JSON.stringify(fmObj({type:'Feature',geometry:{type:'Point',coordinates:[2.34,48.85]},properties:{name:'C'}}))`));
t('GeoJSON 좌표는 그대로', near(g2.lat, 48.85) && near(g2.lng, 2.34));
const g3 = JSON.parse(w.eval(`JSON.stringify(fmObj({name:'D'}))`));
t('아무것도 없으면 좌표 없음', g3.lat === null && g3.lng === null);

t('최종 런타임 오류 0', errs.length === 0);
if (errs.length) console.log('  ', errs.slice(0, 3));
console.log(fail ? ('\n실패 ' + fail + '건') : '\n전체 통과');
process.exit(fail ? 1 : 0);
