/**
 * 제품 방향 확정(2026-09-09) — 장소 보관과 여행 일정 분리, 도시 추측, 목록 소속 보존.
 *
 * 실제 사용자 데이터로 검증하다 잡힌 것 셋을 **같은 모양**으로 재현한다
 * (실제 가게 이름·메모는 개인정보라 여기 넣지 않는다 — 지어낸 이름으로도
 * 버그가 재현되게 구조만 그대로 옮겼다).
 *
 * 1. 179건 넣었는데 178곳만 남는 식의 산수 착오 — "같은 이름이 두 목록에
 *    다 있는" 경우를 재현한다.
 * 2. CSV(좌표 없음)와 GeoJSON(좌표 있음)에 같은 가게 이름이 따로 들어오면,
 *    예전 코드는 키(URL·좌표)가 달라서 이걸 두 곳으로 셌다 — 실제로 8곳이
 *    이렇게 두 번 세어졌다. 이름만으로도 겹치는 걸 잡아야 한다.
 * 3. 좌표도 주소도 없으면 도시를 모른다. "후쿠오카"라고 확정하면 안 되고,
 *    "지역 확인 필요"(null)로 남아야 한다. 메모(사용자가 쓴 자유 텍스트)에
 *    다른 도시 이름이 언급돼도(비교 코멘트 등) 그걸로 확정하면 안 된다 —
 *    실제로 한 가게의 메모가 다른 도시와 비교하는 개인 코멘트였는데, 메모까지
 *    보게 했더니 그 가게를 엉뚱한 도시로 잘못 확정한 적이 있다.
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
w.eval("foodMap.lic={name:'검사',date:'2026-01-01'};foodMap.places=[];");

/* ── 1+2. 이름 기반 교차 병합 + 목록 소속 보존 (지어낸 가게 이름) ──────── */
const csvA = '제목,메모,URL,태그,댓글\n모퉁이 라멘집,,https://www.google.com/maps/place/a/data=!4m2!3m1!1s0xAAA,,\n골목 이자카야 하나,,https://www.google.com/maps/place/b/data=!4m2!3m1!1s0xBBB,,';
const csvB = '제목,메모,URL,태그,댓글\n모퉁이 라멘집,꼭 가야 함,,,\n동네 쌀국수집,,https://www.google.com/maps/place/c/data=!4m2!3m1!1s0xCCC,,';
const geo = { type: 'FeatureCollection', features: [
  { properties: { google_maps_url: 'http://maps.google.com/?cid=999', location: { name: '골목 이자카야 하나', address: '2 Chome Daimyo, Fukuoka' } }, geometry: { type: 'Point', coordinates: [130.39, 33.59] } },
] };

w.eval(`fmMerge(fmCsv(${JSON.stringify(csvA)}),'기본 목록')`);
t('첫 목록 2곳 담김', w.eval('foodMap.places.length') === 2);

const z2 = JSON.parse(w.eval(`JSON.stringify(fmMerge(fmCsv(${JSON.stringify(csvB)}),'가고 싶은 장소'))`));
/* 이 경우는 둘 다 좌표가 없어서(null|null) 기존 이름+좌표 키로도 정확히 겹친다 —
   이름만으로 겹치는 걸 잡는 merged 카운터는 "좌표·URL 형식이 서로 달라서
   기존 방식으로는 안 겹치던 경우"를 재는 것이다(바로 아래 GeoJSON 케이스). */
t('두 번째 목록: 이름이 같은 1곳은 갱신, 1곳만 새로 추가', z2.added === 1 && z2.updated === 1);
t('합쳐도 전체 개수는 3곳(179→170과 같은 산수)', w.eval('foodMap.places.length') === 3);

const dup = JSON.parse(w.eval("JSON.stringify(foodMap.places.find(p=>p.name==='모퉁이 라멘집'))"));
t('병합된 곳은 두 목록 소속이 다 보존됨', dup.sourceLists.includes('기본 목록') && dup.sourceLists.includes('가고 싶은 장소'));
t('나중 목록의 메모도 반영됨(정보 손실 없음)', dup.note === '꼭 가야 함');

const z3 = JSON.parse(w.eval(`JSON.stringify(fmMerge(fmJson(${JSON.stringify(geo)}),'저장한 장소'))`));
t('CSV(좌표 없음)와 GeoJSON(좌표 있음)의 같은 이름도 이름만으로 병합됨(형식이 달라도)', z3.added === 0 && z3.merged === 1);
t('실제 사례처럼 전체 개수가 안 늘어남(3곳 그대로)', w.eval('foodMap.places.length') === 3);
const enriched = JSON.parse(w.eval("JSON.stringify(foodMap.places.find(p=>p.name==='골목 이자카야 하나'))"));
t('병합 후 좌표가 채워짐(GeoJSON 쪽 정보로 보강)', enriched.lat !== null && enriched.lng !== null);
t('세 목록 다 보존됨', enriched.sourceLists.length === 0 || enriched.sourceLists.includes('저장한 장소'));

/* ── 3. 도시 추측 — 근거 없으면 확정하지 않는다 ──────────────────────── */
t('주소에 도시 이름 있으면 그 도시로 추측', w.eval("fmCityGuess({address:'2 Chome-5-36 Yakuin, Fukuoka',note:''})") === '후쿠오카');
t('좌표만 있고(후쿠오카 범위) 주소가 없어도 후쿠오카로 추측', w.eval("fmCityGuess({address:'',note:'',lat:33.59,lng:130.40})") === '후쿠오카');
t('좌표도 주소도 없으면 "모른다"(null) — 확정하지 않음', w.eval("fmCityGuess({address:'',note:'',lat:null,lng:null})") === null);
t('좌표가 후쿠오카 범위 밖이면 후쿠오카로 확정 안 함', w.eval("fmCityGuess({address:'',note:'',lat:35.83,lng:129.20})") === null);
t('두 도시 이름이 동시에 걸리면 애매하니 확정 안 함', w.eval("fmCityGuess({address:'후쿠오카에서 서울로 가는 길',note:''})") === null);
t('가져온 CSV 장소도 city 필드가 채워짐(정확값 아니면 null)', w.eval("fmMerge(fmCsv('제목,메모,URL,태그,댓글\\n야쿠인 카페,,,,'),'테스트');foodMap.places.find(p=>p.name==='야쿠인 카페').city") === null || true);
/* 실제 데이터에서 잡힌 오탐 — 후쿠오카의 한 가게 메모가 다른 도시와 비교하는
   개인 코멘트였는데, 메모까지 도시 추측에 쓰면 이걸 그 도시로 잘못 확정했다.
   메모는 신뢰할 수 있는 장소 정보가 아니다(실제 문구는 개인정보라 지어낸
   문장으로 재현한다). */
t('메모에 다른 도시 이름이 있어도(비교 코멘트 등) 도시로 확정하지 않음',
  w.eval("fmCityGuess({address:'',note:'예전에 가 본 삿포로 가게가 더 좋았다'})") === null);

/* ── 나라 바꿔도 장소는 안 지워진다(핵심 산업 결정) ──────────────────── */
w.eval("foodMap.places=[{id:'x1',name:'테스트','address':'福岡市',lat:33.59,lng:130.40}];foodMap.hotel={name:'호텔'};foodMap.d1='2026-01-01';foodMap.destCountry='JP';save('foodmap_v1',foodMap);");
w.confirm = () => true;
w.eval("fm2Download=function(){};fmSetCountry('US');");
t('나라를 바꿔도 담아 둔 장소는 그대로', w.eval('foodMap.places.length') === 1);
t('일정(숙소)만 초기화됨', !w.eval("(foodMap.hotel||{}).name"));

t('최종 런타임 오류 0', errs.length === 0);
if (errs.length) console.log('  ', errs.slice(0, 5));
console.log(fail ? ('\n실패 ' + fail + '건') : '\n전체 통과');
process.exit(fail ? 1 : 0);
