/**
 * 다개국 판매 검사.
 *
 * 겉은 목적지를 따라가는데 속에 일본이 박혀 있던 곳이 셋 있었다 —
 * 통화(예산이 전부 '엔'), 음식·술 종류(모츠나베·니혼슈), 구역(하카타·텐진).
 * 방콕 가는 사람한테 "80,000엔"이 뜨면 예산 기능 자체를 못 쓴다.
 *
 * 확인할 것: 목적지를 바꾸면 단위와 목록이 따라오는가 ·
 * **일본으로 두면 한 글자도 안 바뀌는가**(이게 제일 중요하다) ·
 * 이미 저장해 둔 값이 목록에서 사라져 못 고르게 되지는 않는가.
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

t('런타임 오류 0', errs.length === 0);

/* ── 기준선: 일본 ────────────────────────────────────────────────────────
   지금 쓰는 사람은 전부 일본이다. 여기가 한 글자라도 바뀌면 그건 사고다. */
w.eval("foodMap.places=[];foodMap.destCountry='JP';delete foodMap.fxCur;");
const jpKinds = w.eval('JSON.stringify(FM_KINDS_NOW())');
const jpRegions = w.eval('JSON.stringify(FM_REGIONS_NOW())');
t('일본 금액은 엔', w.eval('bgYen(80000)') === '80,000엔');
t('일본 통화는 JPY', w.eval('fxCur()') === 'JPY');
t('일본 종류에 모츠나베·니혼슈 그대로', jpKinds.includes('모츠나베') && jpKinds.includes('니혼슈'));
t('일본 구역에 하카타·텐진 그대로', jpRegions.includes('하카타') && jpRegions.includes('텐진'));
t('일본 종류 목록이 원래 표와 같음', jpKinds === w.eval('JSON.stringify(FM_KINDS_JP)'));
t('일본 구역 목록이 원래 표와 같음', jpRegions === w.eval('JSON.stringify(FM_REGIONS_JP)'));

/* ── 태국으로 바꾸면 ─────────────────────────────────────────────────── */
w.eval("fmSetCountry('TH');");
t('태국 금액은 바트', w.eval('bgYen(80000)') === '80,000바트');
t('태국 통화는 THB', w.eval('fxCur()') === 'THB');
const thKinds = w.eval('JSON.stringify(FM_KINDS_NOW())');
t('태국 종류에 모츠나베 없음', !thKinds.includes('모츠나베'));
t('태국 종류에 니혼슈 없음', !thKinds.includes('니혼슈'));
t('태국 종류에 쓸 만한 것은 있음', thKinds.includes('길거리 음식') && thKinds.includes('국수·면'));
t('태국 구역에 하카타 없음', !w.eval('JSON.stringify(FM_REGIONS_NOW())').includes('하카타'));
t('태국 구역에도 전체 지역은 있음', w.eval("FM_REGIONS_NOW()[0]") === '전체 지역');
t('환산 앞부분도 바트', w.eval('fxBoth(1000)').startsWith('1,000바트'));

/* 나라별로 다 다르게 나오는가 */
const money = w.eval(`(function(){var o={};['VN','TW','US','FR','GB'].forEach(function(c){
  fmSetCountry(c);o[c]=bgYen(1000)+'/'+fxCur();});return JSON.stringify(o);})()`);
const M = JSON.parse(money);
t('베트남은 동/VND', M.VN === '1,000동/VND');
t('대만은 대만달러/TWD', M.TW === '1,000대만달러/TWD');
t('미국은 달러/USD', M.US === '1,000달러/USD');
t('프랑스·영국은 유로/파운드', M.FR === '1,000유로/EUR' && M.GB === '1,000파운드/GBP');

/* 표에 없는 나라도 죽지는 않아야 한다 */
w.eval("foodMap.destCountry='ZZ';");
t('모르는 나라도 안 죽음', typeof w.eval('bgYen(100)') === 'string' && w.eval('bgYen(100)').length > 0);

/* ── 손으로 바꾼 통화가 우선 ─────────────────────────────────────────── */
w.eval("fmSetCountry('TH');foodMap.fxCur='USD';");
t('직접 고른 통화가 이김', w.eval('fxCur()') === 'USD');
w.eval("delete foodMap.fxCur;");

/* ── 저장해 둔 값이 목록에서 사라지면 안 된다 ─────────────────────────
   태국으로 바꿨는데 '라멘'으로 저장한 집이 있으면, 그 필터를 고를 수가 없어진다. */
w.eval(`
  foodMap.places=[{id:'z1',name:'가게',kind:'라멘',region:'수쿰윗',cat:'맛집·식당'}];
  fmSetCountry('TH');
`);
t('저장된 종류는 목록에 남음', w.eval("FM_KINDS_NOW().indexOf('라멘')") > 0);
t('저장된 구역은 목록에 뜸', w.eval("FM_REGIONS_NOW().indexOf('수쿰윗')") > 0);
t('저장된 구역도 기타 지역 앞에', w.eval("FM_REGIONS_NOW().indexOf('수쿰윗') < FM_REGIONS_NOW().indexOf('기타 지역')"));
t('목록에 겹치는 것 없음', w.eval("(function(){var a=FM_KINDS_NOW();return a.length===new Set(a).size;})()"));

/* 지금 고른 필터 값도 남아 있어야 한다 */
w.eval("foodMap.kind='야키토리';foodMap.region='텐진';");
t('고른 종류가 목록에 남음', w.eval("FM_KINDS_NOW().indexOf('야키토리')") > 0);
t('고른 구역이 목록에 남음', w.eval("FM_REGIONS_NOW().indexOf('텐진')") > 0);

/* ── 일본으로 되돌리면 원래대로 ─────────────────────────────────────── */
w.eval("foodMap.places=[];delete foodMap.kind;delete foodMap.region;fmSetCountry('JP');");
t('돌아오면 금액도 원래대로', w.eval('bgYen(80000)') === '80,000엔');
t('돌아오면 종류도 원래대로', w.eval('JSON.stringify(FM_KINDS_NOW())') === jpKinds);
t('돌아오면 구역도 원래대로', w.eval('JSON.stringify(FM_REGIONS_NOW())') === jpRegions);

/* ── 고르는 칸이 실제로 새 목록을 쓰는가 ─────────────────────────────
   함수만 고치고 화면을 안 고치면 아무 소용이 없다. */
const src = html.replace(/^.*$/m, (x) => x);
t('종류 칸이 새 목록을 씀', /fm2Opts\(FM_KINDS_NOW\(\)/.test(src));
t('구역 칸이 새 목록을 씀', /fm2Opts\(FM_REGIONS_NOW\(\)/.test(src));
t('옛 목록을 직접 쓰는 칸 없음', !/fm2Opts\(FM_KINDS[,)]/.test(src) && !/fm2Opts\(FM_REGIONS[,.)]/.test(src));

t('최종 런타임 오류 0', errs.length === 0);
if (errs.length) console.log('  ', errs.slice(0, 3));
console.log(fail ? ('\n실패 ' + fail + '건') : '\n전체 통과');
process.exit(fail ? 1 : 0);
