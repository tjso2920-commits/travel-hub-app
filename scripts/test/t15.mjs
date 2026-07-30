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
w.alert=()=>{}; w.confirm=()=>true; w.Element.prototype.scrollIntoView=function(){};
t('런타임 오류 0',errs.length===0); if(errs.length)console.log('  ',errs.slice(0,2));

// 장소 0곳 = 첫 실행
w.eval('foodMap.places=[];foodMap.guideOpen=false;renderFoodMap();');
const guideTxt=()=>{const g=w.document.getElementById('fmGuide');return g?g.textContent:'';};
/* 여행 화면은 담기·일정·지금여행 3탭으로 나뉘어 있으므로 셋을 합쳐 본다 */
const mapTxt=()=>['tab-collect','tab-plan','tab-now'].map(i=>{const e=w.document.getElementById(i);return e?e.textContent:'';}).join(' ');
let body=guideTxt();
t('장소 없으면 안내 자동 표시', w.document.getElementById('fmGuide')!==null);
t('Takeout 주소 안내', body.includes('takeout.google.com'));
t('저장됨 항목 안내', body.includes('저장됨'));
t('한국어 헤더 언급', body.includes('한국어 헤더')||body.includes('제목'));
t('좌표 없어도 되는 기능 설명', body.includes('좌표가 없어도'));
t('좌표가 필요한 기능 설명', body.includes('구역 자동 묶기'));
t('데이터 로컬 저장 고지', body.includes('이 기기에만'));
t('3단계 구성', w.document.querySelectorAll('#fmGuide .fm-guide-step').length===3);
t('장소 0곳이면 닫기 버튼 없음', !/안내 닫기/.test(guideTxt()));

// 불러오기 버튼이 실제 파일 입력을 연다
let clicked=0;
const imp=w.document.getElementById('fmImp');
t('파일 입력 존재', imp!==null);
if(imp){imp.click=()=>{clicked++;};}
w.eval('fmGuideImport()');
t('불러오기 버튼이 파일 선택 실행', clicked===1);

// API 키 설정으로 이동
w.eval('fmGuideSettings()');
const apiEl=w.document.getElementById('fmApiKey');
t('키 입력칸 존재', apiEl!==null);
t('설정 details 자동 펼침', apiEl && apiEl.closest('details') && apiEl.closest('details').open===true);

// 장소가 생기면 안내가 접힌다
w.fmMerge(w.fmCsv(csv));
w.eval('renderFoodMap()');
body=guideTxt();
t('장소 생기면 안내 숨김', w.document.getElementById('fmGuide')===null);
t('다시 보기 버튼 제공', mapTxt().includes('시작 안내 다시 보기'));

// 다시 열기 / 닫기
w.eval('fmGuideToggle(true)');
t('다시 열기 동작', w.document.getElementById('fmGuide')!==null);
t('열린 상태 저장', FM().guideOpen===true);
t('장소 있으면 닫기 버튼 노출', guideTxt().includes('안내 닫기'));
w.eval('fmGuideToggle(false)');
t('닫기 동작', w.document.getElementById('fmGuide')===null && FM().guideOpen===false);

// 링크 안전성
w.eval('foodMap.places=[];renderFoodMap();');
const a=[...w.document.querySelectorAll('#fmGuide a[href]')];
t('외부 링크 https + noopener', a.length>0 && a.every(x=>x.href.startsWith('https://')&&(x.getAttribute('rel')||'').includes('noopener')));
t('최종 런타임 오류 0', errs.length===0);
console.log(fail?('\n실패 '+fail+'건'):'\n전체 통과');
process.exit(fail?1:0);
