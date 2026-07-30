// TARGET: sales
import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs';
const file=process.argv[2]||'private/personal.html';
const html=fs.readFileSync(file,'utf8');
const csv=fs.readFileSync('private/후쿠오카_137.csv','utf8');
const errs=[];const vc=new VirtualConsole();vc.on('jsdomError',e=>errs.push(e.message));
const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,url:'https://local.test/'});
const w=dom.window;await new Promise(r=>setTimeout(r,700));
const FM=()=>w.eval('foodMap');
let fail=0;const t=(n,c)=>{console.log((c?'PASS ':'FAIL ')+n);if(!c)fail++;};
w.alert=()=>{};
t('런타임 오류 0',errs.length===0, errs.slice(0,2));
if(errs.length)console.log('  ',errs.slice(0,2));
t('판매 모드', w.eval('SALE_MODE')===true);
t('저장소 접두어 분리', w.eval('PFX')==='cs1_');
const tabs=[...w.document.querySelectorAll('.tab')].map(x=>x.id);
console.log('   탭:',tabs.join(','));
t('운동2 탭 없음', !tabs.includes('tab-train2'));
t('필수 탭 유지', ['tab-train','tab-log','tab-cal','tab-jp','tab-map','tab-guide'].every(x=>tabs.includes(x)));
t('내비에 운동2 버튼 없음', !w.document.body.innerHTML.includes('>운동2<'));

// 오늘 만든 기능이 전부 넘어왔는지
w.fmMerge(w.fmCsv(csv));
t('한국어 CSV 137건 임포트', FM().places.length===137);
FM().places.forEach((p,i)=>{const h=[[33.5902,130.3986],[33.5895,130.4200],[33.5790,130.3960]][i%3];p.lat=h[0]+((i%17)-8)*0.0004;p.lng=h[1]+((i%13)-6)*0.0004;});
w.eval('renderFoodMap()');
t('구역 자동 묶기', JSON.parse(w.eval('JSON.stringify(fm2Clusters().map(c=>c.members.length))')).length>=3);
t('분포 지도 렌더', w.document.getElementById('fmOverview').innerHTML.includes('<circle'));
t('좌표 판정 수정본', w.eval('fm2HasCoords({lat:null,lng:null})')===false);
FM().selected=FM().places[0].id; w.eval('fmSetHotelFromSpot()');
t('추정 소요시간', w.eval('fm2EtaTxt(foodMap.places[1])').includes('도보'));
t('대중교통 딥링크', w.eval("fmDirectionsLink(foodMap.places[1],'transit')").includes('travelmode=transit'));
t('좌표 일괄 채우기 존재', typeof w.fmEnrichAll==='function');
t('숙소 지정 존재', typeof w.fmSetHotelFromSpot==='function');
t('일본어 90일', w.eval('JP_LIMIT')===90);
t('문법 교재 유지', typeof w.jpGrammarBookHTML==='function');
t('후리가나 유지', typeof w.jpRuby==='function');
t('실시간 GPS 유지', html.includes('navigator.geolocation.watchPosition'));

// 백업
w.eval("exportData=exportData;");
let cap=null;
w.URL.createObjectURL=(b)=>{cap=b;return 'blob:x';};
w.eval('save("jp_state_v1",{pointer:9});exportData();');
t('백업 함수 동작', cap!==null);
t('백업에 운동2 필드 없음', !html.includes('workout2Data,'));

// 개인정보
for(const s of ['스태프밀','윤식','96 → 80','F&B 경력자','十年以上','workout2_snap_v1'])
  t('개인정보 제외: '+s, !html.includes(s));
t('API 키 하드코딩 없음', !/AIza[0-9A-Za-z_-]{25,}/.test(html));
t('최종 런타임 오류 0', errs.length===0);
console.log(fail?('\n실패 '+fail+'건'):'\n전체 통과');
process.exit(fail?1:0);
