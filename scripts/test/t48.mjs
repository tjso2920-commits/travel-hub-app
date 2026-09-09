/**
 * 실제 구글 Takeout CSV로 확인된 진짜 버그.
 *
 * 사용자가 실제로 저장한 178곳을 구글 Takeout에서 그대로 받아 넣어 봤더니
 * "후쿠오카권" 필터에서 165곳(93%)이 조용히 사라졌다. 원인:
 *
 *  - 구글 Takeout CSV(기본 목록.csv 등)는 제목·메모·URL만 준다. 주소도 좌표도 없다.
 *  - fmInFukuoka() 는 주소 텍스트가 안 걸리면 좌표 범위를 검사하는데,
 *    좌표가 없으면 `null>=32.7` 이 조용히 false 가 되어 전부 빠졌다.
 *
 * fmInArea()(다른 나라용 일반 필터)는 이미 "잴 근거 없으면 빼지 않는다" 원칙을
 * 쓰고 있었는데, 후쿠오카 전용 경로(fmInFukuoka)만 그 원칙이 빠져 있었다.
 * 정작 제일 많이 팔리는 목적지(후쿠오카)에서 제일 크게 터진 셈이다.
 *
 * 여기서는 실제로 사용자가 보낸 파일과 같은 모양(주소 없음, 좌표 없음, 순수
 * 제목/메모/URL만 있는 CSV)을 그대로 재현해서 잰다. 지어낸 좌표를 넣으면 이
 * 버그가 안 잡힌다 — 실제 그렇게 잡혔다.
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

w.eval("foodMap.lic={name:'검사',date:'2026-01-01'};foodMap.places=[];foodMap.dest='후쿠오카';fmSetCountry('JP');");

/* 실제 구글 Takeout 기본 목록.csv 와 똑같은 모양 — 제목,메모,URL,태그,댓글.
   주소 칸 자체가 없다. URL도 좌표가 안 박힌 내부 feature-id 형식이다. */
const realShapeCsv =
  '제목,메모,URL,태그,댓글\n' +
  '멘야잇시 라멘,,https://www.google.com/maps/place/%EB%A9%98%EC%95%BC%EC%9E%87%EC%8B%9C/data=!4m2!3m1!1s0x35419194fb180e11:0x994fe0690e9ece48,,\n' +
  'ASOBIBAR 天神大名店,,https://www.google.com/maps/place/ASOBIBAR/data=!4m2!3m1!1s0x3541916cf44ccce3:0x926d5b2ac3429ed8,,\n' +
  'st.763,스탠드바,,,';

w.eval(`fmMerge(fmCsv(${JSON.stringify(realShapeCsv)}))`);
t('CSV 3곳 다 담김', w.eval('foodMap.places.length') === 3);
t('주소도 좌표도 없는 채로 담김', w.eval('foodMap.places.every(p=>!p.address&&p.lat===null&&p.lng===null)'));
t('주소·좌표 없어도 후쿠오카권에서 안 빠짐(핵심 버그)', w.eval('fmFiltered().length') === 3);

/* 좌표가 있고 실제로 다른 나라면 — 이건 정당하게 빠져야 한다.
   "잴 근거 없으면 안 뺀다"이지, "무조건 다 보여준다"가 아니다. */
w.eval("foodMap.places.push({id:'kr1',name:'경주고속버스터미널',address:'대한민국 경상북도 경주시',lat:35.8386770,lng:129.2034999,cat:'교통'});save('foodmap_v1',foodMap);");
t('좌표가 실제로 후쿠오카 밖이면 정당하게 빠짐', w.eval('fmFiltered().length') === 3);
t('그 장소 자체는 안 지워짐(담은 것은 그대로)', w.eval('foodMap.places.length') === 4);

/* 주소 텍스트로 판정되는 기존 경로는 그대로 살아 있어야 한다 */
w.eval("foodMap.places.push({id:'fk1',name:'니카쿠즈시',address:'2 Chome-5-36 Yakuin, Chuo Ward, Fukuoka',lat:null,lng:null,cat:'맛집·식당'});save('foodmap_v1',foodMap);");
t('주소에 Fukuoka 있으면 좌표 없어도 그대로 보임', w.eval('fmFiltered().length') === 4);

t('최종 런타임 오류 0', errs.length === 0);
if (errs.length) console.log('  ', errs.slice(0, 3));
console.log(fail ? ('\n실패 ' + fail + '건') : '\n전체 통과');
process.exit(fail ? 1 : 0);
