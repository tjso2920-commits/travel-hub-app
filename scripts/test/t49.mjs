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

/* ── 3-1. origin* 필드 자체가 없는 기존 레코드(마이그레이션 전 데이터·
   fmAdd로 손으로 추가한 곳)는 원본을 모르니 보수적으로 안 건드림.
   2026-09-09 코드 검토: exact.originNote가 undefined면
   "exact.note===undefined?exact.note:exact.note" 꼴이 되어 항상 참이라서
   무조건 덮어써지고 있었다. ── */
w.eval("foodMap.places=[{id:'legacy1',name:'옛날에 넣은 가게',note:'내가 손으로 적은 메모',address:'서울 마포구',url:'https://www.google.com/maps/place/legacy/data=!4m2!3m1!1s0xLEGACY',sourceLists:[]}];save('foodmap_v1',foodMap);");
const csvLegacy = '제목,메모,URL,주소,댓글\n옛날에 넣은 가게,CSV 원본 메모,https://www.google.com/maps/place/legacy/data=!4m2!3m1!1s0xLEGACY,서울 마포구,';
w.eval(`fmMerge(fmCsv(${JSON.stringify(csvLegacy)}),'기본 목록')`);
t('origin* 없는 기존 레코드는 재수입해도 손으로 적은 메모를 안 덮음(보수적 보존)',
  w.eval('foodMap.places[0].note') === '내가 손으로 적은 메모');
t('대신 origin* 은 이번 값으로 채워져서 다음부터는 원본이 뭐였는지 추적 가능', w.eval('foodMap.places[0].originNote') === 'CSV 원본 메모');
/* 주의: 이 레코드는 "손으로 적은 메모"가 실제로는 원래 이 CSV 값 그대로였을
   수도, 사용자가 진짜 고친 것일 수도 있어 구분할 방법이 없다 — 그래서 한
   번 보수적으로 보존하면 그 이후로도 "지금 값 !== origin"인 채로 남아
   자동 갱신 대상에서 계속 빠진다(안전한 쪽으로 영구히 치우침). 이건 의도한
   동작이다 — 자동으로 다시 덮어쓰기 시작하는 것보다 사람이 확인하게
   남겨두는 쪽이 안전하다. */
const csvLegacy2 = csvLegacy.replace('CSV 원본 메모', 'CSV 갱신된 메모');
w.eval(`fmMerge(fmCsv(${JSON.stringify(csvLegacy2)}),'기본 목록')`);
t('한 번 보수적으로 보존된 뒤에도 계속 안전하게 보존됨(자동으로 다시 덮지 않음)', w.eval('foodMap.places[0].note') === '내가 손으로 적은 메모');
t('원본 추적은 계속 최신 값으로 갱신됨(나중에 비교용)', w.eval('foodMap.places[0].originNote') === 'CSV 갱신된 메모');

/* ── 4. 좌표 둘 다 없으면 이름+좌표(null|null) 로도 검증된 식별자 취급 안 함 ── */
w.eval("foodMap.places=[{id:'x',name:'같은이름',address:'서울 종로구',city:'서울',lat:null,lng:null,sourceLists:[]}];save('foodmap_v1',foodMap);");
const csvNoCoord = '제목,메모,URL,태그,댓글\n같은이름,,,,';
const z4 = JSON.parse(w.eval(`JSON.stringify(fmMerge(fmCsv(${JSON.stringify(csvNoCoord)}),'다른 목록'))`));
t('좌표 없는 동명 장소는 null|null 로 자동 합쳐지지 않음(핵심 원인이었던 버그)', z4.added === 1);
t('대신 도시가 같으니(서울) 후보로는 남음', (w.eval('foodMap.places[0].dupCandidateIds')||[]).length > 0);

/* ── 4-1. 이름+좌표가 같아도 placeId가 서로 다르면 강한 충돌 증거로 본다
   (2026-09-09 코드 검토) — 같은 건물에 다른 가게가 여럿 있을 때 좌표가
   거의 같아 보일 수 있다. 구글이 이미 서로 다른 placeId를 줬다면 이름+
   좌표 일치보다 그 판정을 믿어야 한다. ── */
w.eval("foodMap.places=[{id:'pidA',name:'같은건물가게',placeId:'ChIJ_AAA',lat:33.59,lng:130.40,address:'',sourceLists:[]}];save('foodmap_v1',foodMap);");
const z4b = JSON.parse(w.eval("JSON.stringify(fmMerge([{name:'같은건물가게',placeId:'ChIJ_BBB',lat:33.59,lng:130.40}],'다른 목록'))"));
t('이름+좌표가 같아도 placeId가 다르면 자동 병합 안 함', z4b.added === 1 && z4b.updated === 0);
t('placeId 충돌은 후보로도 안 묶임(진짜 다른 곳이라는 강한 증거)',
  !(w.eval('foodMap.places[0].dupCandidateIds')||[]).length && !(w.eval('foodMap.places[1].dupCandidateIds')||[]).length);

/* ── 4-2. 검색 URL(/maps/search/)은 특정 장소 식별자가 아니다 — 우연히
   같은 검색 URL을 만들어도 병합 근거로 쓰면 안 된다(2026-09-09 코드 검토,
   fmLink() 같은 대체 링크 생성 함수가 만드는 형태를 흉내냄). ── */
w.eval("foodMap.places=[{id:'sA',name:'가게A',url:'https://www.google.com/maps/search/?api=1&query=33.59%2C130.40',lat:null,lng:null,address:'',sourceLists:[]}];save('foodmap_v1',foodMap);");
const z4c = JSON.parse(w.eval("JSON.stringify(fmMerge([{name:'가게B',url:'https://www.google.com/maps/search/?api=1&query=33.59%2C130.40'}],'다른 목록'))"));
t('검색 URL이 우연히 같아도 서로 다른 이름이면 자동 병합 안 함(검색 URL은 식별자가 아님)', z4c.added === 1 && z4c.updated === 0);

/* ── 4-4. fmResolveDup — 사람이 "같은 곳이에요"로 합친 뒤에도 삭제된
   쪽의 식별자로 재수입하면 새 레코드가 또 생기지 않아야 한다(2026-09-09
   코드 검토 — daResolveDup가 별칭을 안 남겨서 재생성되던 문제). ── */
w.eval(`foodMap.places=[
  {id:'wA',name:'중복확인가게',note:'A쪽 메모',url:'https://www.google.com/maps/place/w/data=!4m2!3m1!1s0xW1',placeId:'',visited:false,cat:'기타',sourceLists:['목록A'],dupCandidateIds:['wB']},
  {id:'wB',name:'중복확인가게',note:'B쪽 메모',address:'福岡市 天神',url:'https://www.google.com/maps/place/w/data=!4m2!3m1!1s0xW2',visited:true,visitedAt:'2026-01-01',cat:'이자카야',sourceLists:['목록B'],dupCandidateIds:['wA']}
];save('foodmap_v1',foodMap);`);
const rdup = JSON.parse(w.eval("JSON.stringify(fmResolveDup(foodMap.places,'wA','wB','merge'))"));
t('합치면 1곳으로 줄어듦', w.eval('foodMap.places.length') === 1);
t('반환값에 살아남은/삭제된 id가 담김(호출자가 일정 참조를 옮길 수 있게)', rdup.survivorId === 'wA' && rdup.mergedId === 'wB');
t('양쪽 메모가 다 있고 다르면 하나를 버리지 않고 이어붙임', w.eval('foodMap.places[0].note') === 'A쪽 메모 / B쪽 메모');
t('방문 기록은 a에 없으면 b에서 가져옴', w.eval('foodMap.places[0].visited') === true && w.eval('foodMap.places[0].visitedAt') === '2026-01-01');
t('분류도 a가 기타면 b의 확인된 분류로 채움', w.eval('foodMap.places[0].cat') === '이자카야');
t('삭제된 쪽(wB)의 URL이 별칭으로 남음', (w.eval('foodMap.places[0].aliasUrls')||[]).includes('https://www.google.com/maps/place/w/data=!4m2!3m1!1s0xW2'));
/* 삭제된 wB의 URL로 다시 가져오면 — 별칭 등록 덕분에 새 레코드가 아니라
   살아남은 wA가 갱신돼야 한다(진짜 버그였던 재생성 문제). */
const reimportCsv = '제목,메모,URL,태그,댓글\n중복확인가게,,https://www.google.com/maps/place/w/data=!4m2!3m1!1s0xW2,,';
const zAfterMerge = JSON.parse(w.eval(`JSON.stringify(fmMerge(fmCsv(${JSON.stringify(reimportCsv)}),'목록B 재수입'))`));
t('합쳐서 없어진 쪽 URL로 재수입해도 새 레코드가 안 생김(별칭 등록 확인)', zAfterMerge.added === 0 && zAfterMerge.updated === 1);
t('전체 장소 수 그대로(재생성 안 됨)', w.eval('foodMap.places.length') === 1);

/* ── 4-5. dismiss — "다른 곳이에요"로 확인한 조합은 같은 파일을 다시
   올려도 또 후보로 묻지 않는다 ── */
/* 주소·좌표를 안 줘서 fmPlacesConflict 만으로는 후보 제외가 안 되는
   상황을 만든다 — dismissedDupKeys 가 진짜로 막고 있는지 보기 위해서다. */
w.eval("foodMap.places=[{id:'dA',name:'흔한상호',address:'',sourceLists:[],dupCandidateIds:['dB']},{id:'dB',name:'흔한상호',address:'',sourceLists:[],dupCandidateIds:['dA']}];save('foodmap_v1',foodMap);");
w.eval("fmResolveDup(foodMap.places,'dA','dB','dismiss');");
t('dismiss 후엔 서로 후보 연결이 끊김', !(w.eval("foodMap.places[0].dupCandidateIds")||[]).includes('dB'));
t('둘 다 안 지워지고 남음(실제로 다른 곳)', w.eval('foodMap.places.length') === 2);
/* 같은 이름+같은 주소(둘 다 빈 문자열) 조합을 담은 파일을 다시 올리면,
   dismissedDupKeys가 없었다면 fmPlacesConflict만으로는 걸러지지 않아
   다시 후보로 묶였을 조합이다 — dismissedDupKeys 덕분에 묶이지 않아야
   한다. */
w.eval("fmMerge([{name:'흔한상호',address:''}],'재업로드')");
t('이미 다른 곳이라고 확인한 조합은 재수입해도 다시 후보로 안 묶임(dismissedDupKeys)', !(w.eval('foodMap.places[2].dupCandidateIds')||[]).length);

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

/* ── 7. 유형 분류 — 확인된 유형 우선 + 사용자 수정 보존(2026-09-09 코드 검토) ── */
w.eval("foodMap.places=[];");
const csvNoCat = '제목,메모,URL,태그,댓글\n동네라멘가게,,,,';
w.eval(`fmMerge(fmCsv(${JSON.stringify(csvNoCat)}),'목록')`);
t('원본에 유형 정보가 없으면 이름으로 짐작(맛집·식당)', w.eval('foodMap.places[0].cat') === '맛집·식당');
t('짐작한 값은 확정 아님(catConfirmed=false)', w.eval('foodMap.places[0].catConfirmed') === false);
/* 확인된 유형(예: Places API 보강 결과의 cat)이 있으면 이름 짐작보다 우선.
   재수입 시나리오이므로 URL(검증된 식별자)을 공유해 exact 매칭시킨다. */
w.eval("foodMap.places=[]");
const catUrl = 'https://www.google.com/maps/place/x/data=!4m2!3m1!1s0xCAT1';
w.eval(`fmMerge([{name:'동네라멘가게',url:${JSON.stringify(catUrl)},cat:'카페·디저트'}],'보강됨')`);
t('원본에 확인된 유형이 있으면 그걸 그대로 씀(이름 짐작 무시)', w.eval('foodMap.places[0].cat') === '카페·디저트');
t('확인된 유형은 catConfirmed=true', w.eval('foodMap.places[0].catConfirmed') === true);
/* 사용자가 fmSetCat으로 직접 고친 분류는 재수입해도 안 덮임 */
w.eval("fmSetCat(foodMap.places[0].id,'바·이자카야');");
t('사용자가 직접 고르면 catConfirmed=true', w.eval('foodMap.places[0].catConfirmed') === true);
w.eval(`fmMerge([{name:'동네라멘가게',url:${JSON.stringify(catUrl)},cat:'쇼핑'}],'다른보강')`);
t('사용자가 고친 분류는 재수입해도(같은 곳, 원본이 다른 값을 줘도) 안 덮임', w.eval('foodMap.places[0].cat') === '바·이자카야');
t('범용 유형 목록 사용 — 후쿠오카 전용 상호명에 의존하지 않음(맛집·바·카페 등 어느 여행지든 통용)',
  ['맛집·식당','바·이자카야','카페·디저트','관광·명소','쇼핑','숙소','교통','사우나·온천','마사지·스파','약국·병원','기타'].includes(w.eval('fmInfer("아무 상호명")')));

/* ── 8. 실제 위치 확인 — 저장된 식별자 우선, 추가 조회 필요 항목 구분
   (2026-09-09 코드 검토 ⑦). personal.html에는 daNeedsLookup 이 없으므로
   ("보관함" 화면에는 좌표 없는 곳을 그냥 "지역 확인 필요"로만 다룬다)
   이 절은 fmCoordFromUrl(이미 저장된 URL에서 추가 조회 없이 뽑아내는
   부분)만 여기서 확인하고, "추가 조회 필요" 구분은 design 어댑터 쪽
   테스트(design-integration-check.mjs)에서 확인한다. ── */
t('FID(!3d!4d) 형식은 추가 조회 없이 좌표를 바로 뽑아냄',
  JSON.stringify(w.eval("fmCoordFromUrl('https://www.google.com/maps/place/x/data=!4m2!3m1!1s0x0!8m2!3d33.5902!4d130.4017')")) === JSON.stringify({ lat: 33.5902, lng: 130.4017 }));
t('지도 중심(@lat,lng) 형식도 추가 조회 없이 뽑아냄',
  JSON.stringify(w.eval("fmCoordFromUrl('https://www.google.com/maps/place/x/@33.5902,130.4017,17z')")) === JSON.stringify({ lat: 33.5902, lng: 130.4017 }));
t('축약 링크(goo.gl/maps)는 URL 문자열만으로 좌표를 못 뽑음(추가 조회가 실제로 필요한 경우)',
  w.eval("fmCoordFromUrl('https://goo.gl/maps/abcXYZ123')") === null);

/* ── 나라 바꿔도 장소는 안 지워진다(핵심 산업 결정 — t46 에서 fmSetCountry 는 따로 검증) ── */
w.eval("foodMap.places=[{id:'x1',name:'테스트','address':'福岡市',lat:33.59,lng:130.40}];save('foodmap_v1',foodMap);");
t('fmMerge 로 담긴 장소는 destCountry 와 무관하게 그대로 유지됨(별도 검증은 t46)', w.eval('foodMap.places.length') === 1);

t('최종 런타임 오류 0', errs.length === 0);
if (errs.length) console.log('  ', errs.slice(0, 5));
console.log(fail ? ('\n실패 ' + fail + '건') : '\n전체 통과');
process.exit(fail ? 1 : 0);
