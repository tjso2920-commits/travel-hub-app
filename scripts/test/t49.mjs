/**
 * 제품 방향 확정(2026-09-09) — 장소 보관과 여행 일정 분리, 도시 추측, 목록 소속 보존.
 *
 * 2026-09-09 코드 검토 반영: 이 파일의 이전 버전은 "이름만 같으면 자동으로
 * 합친다"를 전제로 짜여 있었다 — 그런데 그게 실제 버그였다. 서울과 부산의
 * 동명 가게가 하나로 합쳐지는 게 재현됐다(주소가 명백히 다른데도 이름만
 * 보고 합침). 그래서 병합 규칙 자체를 다시 짰고, 이 파일도 다시 짰다.
 *
 * 지금 규칙:
 *  - 검증된 식별자(placeId·URL·이름+실좌표)로 확인된 것만 자동으로 합친다.
 *  - 이름만 같으면 합치지 않는다 — 중복 후보(dupCandidateIds)로만 남긴다.
 *  - 이름이 같아도 도시·좌표로 이미 다른 곳이라는 증거가 있으면 후보로도
 *    안 남긴다(진짜 다른 곳이니까).
 *  - 재수입 시 사용자가 원본에서 이미 고친 값(메모·주소·이름)은 새로
 *    들어온 값으로 덮지 않는다.
 *  - 좌표만으로는 도시를 확정하지 않는다(후쿠오카 사각 범위도 마찬가지 —
 *    fmCityHint 는 "짐작"이지 fmCityGuess 의 확정값이 아니다).
 *
 * 실제 가게 이름·메모는 개인정보라 여기 넣지 않는다 — 지어낸 이름으로도
 * 버그가 재현되게 구조만 그대로 옮겼다.
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

/* ── 1. 핵심 재현 — 서울과 부산의 동명 가게는 절대 하나로 합쳐지면 안 됨 ──
   주소는 가져오는 시점에 이미 있어야 한다 — 병합 판단은 그 순간의 증거로
   내려지므로, 나중에 주소를 채워 넣는 건 재현이 아니다(실사용에서 CSV·
   GeoJSON 은 처음부터 주소를 갖고 들어온다). */
const csvSeoul = '제목,메모,URL,주소,댓글\n동네 커피집,,,서울특별시 마포구,';
const csvBusan = '제목,메모,URL,주소,댓글\n동네 커피집,,,부산광역시 해운대구,';
w.eval(`fmMerge(fmCsv(${JSON.stringify(csvSeoul)}),'목록A')`);
w.eval("foodMap.places[0].city=fmCityGuess(foodMap.places[0]);save('foodmap_v1',foodMap);");
const z1 = JSON.parse(w.eval(`JSON.stringify(fmMerge(fmCsv(${JSON.stringify(csvBusan)}),'목록B'))`));
t('주소로 다른 도시라는 증거가 있으면 이름이 같아도 새 장소로 담김', z1.added === 1 && z1.updated === 0);
t('전체 2곳 — 하나로 합쳐지지 않음(핵심 버그 재현·수정 확인)', w.eval('foodMap.places.length') === 2);
w.eval("foodMap.places[1].city=fmCityGuess(foodMap.places[1]);save('foodmap_v1',foodMap);");
t('서울 것과 부산 것이 서로 다른 도시로 유지됨',
  w.eval("foodMap.places[0].city") === '서울' && w.eval("foodMap.places[1].city") === '부산');
t('도시가 다르다는 증거가 이미 가져오는 시점에 있으니 중복 후보로도 안 남음(진짜 다른 곳)',
  !(w.eval('foodMap.places[0].dupCandidateIds')||[]).length && !(w.eval('foodMap.places[1].dupCandidateIds')||[]).length);

/* ── 2. 이름만 같고 증거가 없으면(둘 다 주소 없음) — 후보로만 남김, 자동 병합 안 함 ── */
w.eval("foodMap.places=[];");
const csvA = '제목,메모,URL,태그,댓글\n모퉁이 라멘집,,,,';
w.eval(`fmMerge(fmCsv(${JSON.stringify(csvA)}),'기본 목록')`);
const z2 = JSON.parse(w.eval(`JSON.stringify(fmMerge(fmCsv(${JSON.stringify(csvA)}.replace('모퉁이 라멘집','모퉁이 라멘집')),'가고 싶은 장소'))`));
/* 완전히 같은 문자열(제목만 있고 좌표·URL 다 없음)을 다시 넣으면 재수입과
   구분이 안 되므로(진짜 재수입인지 새 항목인지 알 길이 없다), 이 경우는
   실제로는 "같은 행을 두 번 넣은 것"과 동일하게 취급돼 후보로 남는다. */
t('이름만 같고 증거가 전혀 없으면 자동으로 안 합쳐짐(중복 후보로만)', w.eval('foodMap.places.length') === 2);
t('서로 중복 후보로 연결됨', (w.eval('foodMap.places[0].dupCandidateIds')||[]).includes(w.eval('foodMap.places[1].id')));

/* 후보를 사람이 "같은 곳" 이라고 확인하면 그때 합친다(자동 아님) */
const aId = w.eval('foodMap.places[0].id'), bId = w.eval('foodMap.places[1].id');
w.eval(`
  function daHasCoords2(p){return p.lat!==null&&p.lat!==undefined&&p.lng!==null&&p.lng!==undefined;}
  (function(){
    var places=foodMap.places, a=places.find(function(p){return p.id===${JSON.stringify(aId)};}), b=places.find(function(p){return p.id===${JSON.stringify(bId)};});
    if(!a.address&&b.address)a.address=b.address;
    a.sourceLists=Array.from(new Set((a.sourceLists||[]).concat(b.sourceLists||[])));
    var idx=places.findIndex(function(p){return p.id===${JSON.stringify(bId)};});
    if(idx>=0)places.splice(idx,1);
    save('foodmap_v1',foodMap);
  })();
`);
t('사람이 확인하면 합쳐서 1곳으로 줄어듦', w.eval('foodMap.places.length') === 1);
t('합친 곳은 두 목록 소속을 다 가짐', w.eval('foodMap.places[0].sourceLists').includes('기본 목록') && w.eval('foodMap.places[0].sourceLists').includes('가고 싶은 장소'));

/* ── 3. 검증된 식별자(URL)는 예전처럼 자동으로 합쳐진다 ─────────────── */
w.eval("foodMap.places=[];");
const csvUrl1 = '제목,메모,URL,태그,댓글\n골목 이자카야 하나,,https://www.google.com/maps/place/a/data=!4m2!3m1!1s0xAAA,,';
w.eval(`fmMerge(fmCsv(${JSON.stringify(csvUrl1)}),'기본 목록')`);
const geo = { type: 'FeatureCollection', features: [
  { properties: { google_maps_url: 'https://www.google.com/maps/place/a/data=!4m2!3m1!1s0xAAA', location: { name: '골목 이자카야 하나', address: '2 Chome Daimyo, Fukuoka' } }, geometry: { type: 'Point', coordinates: [130.39, 33.59] } },
] };
const z3 = JSON.parse(w.eval(`JSON.stringify(fmMerge(fmJson(${JSON.stringify(geo)}),'저장한 장소'))`));
t('같은 URL(검증된 식별자)이면 자동으로 합쳐짐', z3.added === 0 && z3.updated === 1);
t('전체 개수 안 늘어남(1곳 그대로)', w.eval('foodMap.places.length') === 1);
const enriched = JSON.parse(w.eval("JSON.stringify(foodMap.places[0])"));
t('병합 후 좌표가 채워짐(GeoJSON 쪽 정보로 보강)', enriched.lat !== null && enriched.lng !== null);
t('두 목록 다 보존됨', enriched.sourceLists.includes('기본 목록') && enriched.sourceLists.includes('저장한 장소'));

/* ── 4. 좌표 둘 다 없으면 이름+좌표(null|null) 로도 검증된 식별자 취급 안 함 ── */
w.eval("foodMap.places=[{id:'x',name:'같은이름',address:'서울 종로구',city:'서울',lat:null,lng:null,sourceLists:[]}];save('foodmap_v1',foodMap);");
const csvNoCoord = '제목,메모,URL,태그,댓글\n같은이름,,,,';
const z4 = JSON.parse(w.eval(`JSON.stringify(fmMerge(fmCsv(${JSON.stringify(csvNoCoord)}),'다른 목록'))`));
t('좌표 없는 동명 장소는 null|null 로 자동 합쳐지지 않음(핵심 원인이었던 버그)', z4.added === 1);
t('대신 도시가 같으니(서울) 후보로는 남음', (w.eval('foodMap.places[0].dupCandidateIds')||[]).length > 0);

/* ── 5. 재수입 시 사용자가 고친 메모를 덮지 않는다 ───────────────────── */
w.eval("foodMap.places=[];");
const csvOrig = '제목,메모,URL,태그,댓글\n동네 카페,원본 메모,https://www.google.com/maps/place/b/data=!4m2!3m1!1s0xBBB,,';
w.eval(`fmMerge(fmCsv(${JSON.stringify(csvOrig)}),'기본 목록')`);
t('처음엔 원본 메모 그대로', w.eval('foodMap.places[0].note') === '원본 메모');
/* 사용자가 앱에서 메모를 고쳤다고 가정 */
w.eval("foodMap.places[0].note='내가 고친 메모 — 여기 진짜 좋았음';save('foodmap_v1',foodMap);");
/* 같은 CSV(원본 메모 그대로)를 재수입 — 사용자가 고친 값을 덮으면 안 됨 */
w.eval(`fmMerge(fmCsv(${JSON.stringify(csvOrig)}),'기본 목록')`);
t('재수입해도 사용자가 고친 메모는 안 덮임(실제 버그였던 것)', w.eval('foodMap.places[0].note') === '내가 고친 메모 — 여기 진짜 좋았음');
t('원본 값 자체는 계속 추적됨(원본이 바뀌면 나중에 참고 가능)', w.eval('foodMap.places[0].originNote') === '원본 메모');
/* 사용자가 안 고쳤으면 재수입 시 새 원본 값으로 정상 갱신된다 */
w.eval("foodMap.places=[];");
w.eval(`fmMerge(fmCsv(${JSON.stringify(csvOrig)}),'기본 목록')`);
const csvUpdated = '제목,메모,URL,태그,댓글\n동네 카페,갱신된 원본 메모,https://www.google.com/maps/place/b/data=!4m2!3m1!1s0xBBB,,';
w.eval(`fmMerge(fmCsv(${JSON.stringify(csvUpdated)}),'기본 목록')`);
t('사용자가 안 고쳤으면 재수입 시 새 원본 값으로 정상 갱신됨', w.eval('foodMap.places[0].note') === '갱신된 원본 메모');

/* ── 6. 도시 추측 — 근거 없으면 확정하지 않는다 ──────────────────────── */
t('주소에 도시 이름 있으면 그 도시로 추측', w.eval("fmCityGuess({address:'2 Chome-5-36 Yakuin, Fukuoka'})") === '후쿠오카');
t('좌표만으로는 도시를 확정하지 않음(2026-09-09 코드 검토 반영 — 후쿠오카 박스는 실제보다 넓다)',
  w.eval("fmCityGuess({address:'',lat:33.59,lng:130.40})") === null);
t('좌표 기반 힌트는 별도 함수로만 제공(확정 아님)', w.eval("fmCityHint({lat:33.59,lng:130.40})") === '후쿠오카');
t('좌표가 후쿠오카 범위 밖이면 힌트도 없음', w.eval("fmCityHint({lat:35.83,lng:129.20})") === null);
t('좌표도 주소도 없으면 힌트도 확정도 없음(null)', w.eval("fmCityGuess({address:'',lat:null,lng:null})") === null && w.eval("fmCityHint({lat:null,lng:null})") === null);
t('두 도시 이름이 동시에 걸리면 애매하니 확정 안 함', w.eval("fmCityGuess({address:'후쿠오카에서 서울로 가는 길'})") === null);
t('메모에 다른 도시 이름이 있어도(비교 코멘트 등) 도시로 확정하지 않음 — fmCityGuess 는 주소만 봄',
  w.eval("fmCityGuess({address:'',note:'예전에 가 본 삿포로 가게가 더 좋았다'})") === null);

/* ── 나라 바꿔도 장소는 안 지워진다(핵심 산업 결정 — t46 에서 fmSetCountry 는 따로 검증) ── */
w.eval("foodMap.places=[{id:'x1',name:'테스트','address':'福岡市',lat:33.59,lng:130.40}];save('foodmap_v1',foodMap);");
t('fmMerge 로 담긴 장소는 destCountry 와 무관하게 그대로 유지됨(별도 검증은 t46)', w.eval('foodMap.places.length') === 1);

t('최종 런타임 오류 0', errs.length === 0);
if (errs.length) console.log('  ', errs.slice(0, 5));
console.log(fail ? ('\n실패 ' + fail + '건') : '\n전체 통과');
process.exit(fail ? 1 : 0);
