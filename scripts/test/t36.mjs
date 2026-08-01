/**
 * 목록 묶어보기 검사.
 *
 * 137곳을 한 줄로 늘어놓으면 스크롤만 하다 끝난다. 분류별로 묶고 접는다.
 * 확인할 것: 개수에 따른 기본값 · 묶음이 실제로 갈리는가 · 접힘을 기억하는가 ·
 * 그리고 **묶어도 장소가 하나도 안 사라지는가**(이게 제일 중요하다).
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs';
const file = process.argv[2] || 'private/personal.html';
const html = fs.readFileSync(file, 'utf8');
const errs = []; const vc = new VirtualConsole();
vc.on('jsdomError', (e) => { if (!/scrollTo|Not implemented/.test(e.message)) errs.push(e.message); });
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: 'https://local.test/' });
const w = dom.window; await new Promise((r) => setTimeout(r, 700));
let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };
w.alert = () => {}; w.confirm = () => true; w.Element.prototype.scrollIntoView = function () {};
const d = w.document;

t('런타임 오류 0', errs.length === 0);

/* 몇 개 안 되면 한 줄로 — 접는 게 방해다 */
w.eval(`
  delete foodMap.groupBy; delete foodMap.grpOpen;
  foodMap.lic={name:'검사',date:'2026-01-01'};
  foodMap.filter='전체'; foodMap.q=''; foodMap.region='전체 지역';
  foodMap.kind='전체 음식·술'; foodMap.status='기본 상태';
  foodMap.places=[];
  for(let i=0;i<5;i++)foodMap.places.push({id:'a'+i,name:'가게'+i,cat:'맛집·식당'});
  renderFoodMap();
`);
t('5곳이면 한 줄로', w.eval('fmGrouped()') === false);
t('5곳이면 고르는 칸도 안 보임', !d.getElementById('fmList').querySelector('.fm-view'));

/* 많아지면 분류별로 묶고 접어 둔다 */
w.eval(`
  foodMap.places=[];
  const CATS=['맛집·식당','바·이자카야','카페·디저트','사우나·온천','숙소'];
  for(let i=0;i<40;i++)foodMap.places.push({id:'b'+i,name:'가게'+i,cat:CATS[i%CATS.length]});
  renderFoodMap();
`);
t('40곳이면 분류별로', w.eval('fmGrouped()') === true);
const list = d.getElementById('fmList');
t('고르는 칸 나옴', !!list.querySelector('.fm-view'));
t('분류별로가 켜져 있음', list.querySelector('.fm-view button.on').textContent === '분류별로');

const grps = [...list.querySelectorAll('details.fm-grp')];
t('묶음 5개', grps.length === 5);
t('처음엔 전부 접힘', grps.every((g) => !g.open));
t('묶음마다 개수 표시', grps.every((g) => /\d+곳/.test(g.querySelector('summary').textContent)));
t('미방문 수도 표시', grps[0].querySelector('summary').textContent.includes('미방문'));

/* 묶어도 한 곳도 안 사라져야 한다 — 이게 제일 중요하다 */
const shown = list.querySelectorAll('.place').length;
t('묶어도 40곳 전부 있음', shown === 40);
const names = new Set([...list.querySelectorAll('.place-name')].map((x) => x.textContent));
t('이름이 겹치거나 빠지지 않음', names.size === 40);

/* 순서는 분류표를 따른다 */
const order = grps.map((g) => g.querySelector('summary').textContent.replace(/▶|\d+곳.*/g, '').trim());
t('맛집이 먼저', order[0] === '맛집·식당');
t('숙소가 사우나보다 앞', order.indexOf('숙소') < order.indexOf('사우나·온천'));

/* 접힘을 기억한다 */
w.eval("fmGrpToggle('맛집·식당',true);renderFoodMap();");
const g2 = [...d.getElementById('fmList').querySelectorAll('details.fm-grp')];
t('편 것은 펴진 채로', g2[0].open === true);
t('나머지는 접힌 채로', g2.slice(1).every((g) => !g.open));
t('저장까지 됨', w.eval("(load('foodmap_v1',{}).grpOpen||{})['맛집·식당']") === true);

/* 한 줄로 돌아가기 */
w.eval("fmSetGroup('flat')");
const list3 = d.getElementById('fmList');
t('한 줄로 바뀜', list3.querySelectorAll('details.fm-grp').length === 0);
t('한 줄로도 40곳 전부', list3.querySelectorAll('.place').length === 40);
t('선택을 기억함', w.eval("load('foodmap_v1',{}).groupBy") === 'flat');
w.eval("fmSetGroup('cat')");
t('다시 묶기', d.getElementById('fmList').querySelectorAll('details.fm-grp').length === 5);

/* 조건에 안 맞으면 빈 화면 문구 */
w.eval("foodMap.q='없는가게이름zzz';renderFoodMap();");
t('결과 없으면 안내', d.getElementById('fmList').textContent.includes('조건에 맞는 장소가 없습니다'));
w.eval("foodMap.q='';renderFoodMap();");

/* ── 클럽·나이트도 술집으로 잡히는가 ────────────────────────────────── */
for (const n of ['클럽 X', '나이트 부산', '스탠딩 펍', '와인바 미도리', 'Club Neo', '위스키 바']) {
  t('술집으로 분류: ' + n, w.eval('fmInfer(' + JSON.stringify(n) + ')') === '바·이자카야');
}
for (const n of ['찜질방 파라다이스', '유노야 온천', 'Onsen Yu']) {
  t('사우나·온천으로 분류: ' + n, w.eval('fmInfer(' + JSON.stringify(n) + ')') === '사우나·온천');
}
t('료칸은 숙소로', w.eval("fmInfer('료칸 하나')") === '숙소');

t('최종 런타임 오류 0', errs.length === 0);
if (errs.length) console.log('  ', errs.slice(0, 3));
console.log(fail ? ('\n실패 ' + fail + '건') : '\n전체 통과');
process.exit(fail ? 1 : 0);
