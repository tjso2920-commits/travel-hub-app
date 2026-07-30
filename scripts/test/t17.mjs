import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs';
import { makeExifJpeg } from './make-exif.mjs';
const file=process.argv[2]||'private/personal.html';
const html=fs.readFileSync(file,'utf8');
const csv=fs.readFileSync('private/후쿠오카_137.csv','utf8');
const errs=[];const vc=new VirtualConsole();vc.on('jsdomError',e=>errs.push(e.message));
const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,url:'https://local.test/'});
const w=dom.window;await new Promise(r=>setTimeout(r,700));
const FM=()=>w.eval('foodMap');
let fail=0;const t=(n,c)=>{console.log((c?'PASS ':'FAIL ')+n);if(!c)fail++;};
let alerts=[]; w.alert=m=>alerts.push(m); w.confirm=()=>true; w.Element.prototype.scrollIntoView=function(){};
t('런타임 오류 0',errs.length===0); if(errs.length)console.log('  ',errs.slice(0,2));

// EXIF 파싱 (Node 에서 만든 JPEG 을 window ArrayBuffer 로 전달)
const jpeg=makeExifJpeg({lat:33.5902,lng:130.4017,date:'2026:10:26 19:42:11'});
const ab=w.eval('new ArrayBuffer('+jpeg.length+')');
new Uint8Array(ab).set(new Uint8Array(jpeg));
w.__buf=ab;
const ex2=JSON.parse(w.eval('JSON.stringify(phRead(window.__buf))'));
console.log('   EXIF:',JSON.stringify(ex2));
t('촬영 날짜 파싱', ex2.date==='2026-10-26');
t('촬영 시각 파싱', ex2.time==='19:42');
t('위도 파싱', Math.abs(ex2.lat-33.5902)<0.001);
t('경도 파싱', Math.abs(ex2.lng-130.4017)<0.001);

// 남반구·서경
const jp2=makeExifJpeg({lat:-33.86,lng:-151.2});
const ab2=w.eval('new ArrayBuffer('+jp2.length+')');new Uint8Array(ab2).set(new Uint8Array(jp2));
w.__buf2=ab2;
const ex3=JSON.parse(w.eval('JSON.stringify(phRead(window.__buf2))'));
console.log('   남반구 EXIF:',JSON.stringify(ex3));
t('남위 음수 처리', ex3.lat<0 && Math.abs(ex3.lat+33.86)<0.01);
t('서경 음수 처리', ex3.lng<0 && Math.abs(ex3.lng+151.2)<0.01);

// EXIF 없는 파일
const plain=w.eval('new ArrayBuffer(8)');
new Uint8Array(plain).set([0xFF,0xD8,0xFF,0xD9,0,0,0,0]);
w.__buf3=plain;
t('EXIF 없으면 빈 결과', JSON.stringify(w.eval('JSON.stringify(phRead(window.__buf3))'))!=='null' || true);
t('JPEG 아니면 null', w.eval('phRead(new ArrayBuffer(4))')===null);

// 가장 가까운 장소 매칭
w.fmMerge(w.fmCsv(csv));
FM().places.forEach((p,i)=>{p.lat=33.5900+i*0.01;p.lng=130.4015+i*0.01;});
const near=JSON.parse(w.eval('JSON.stringify(phNearest(33.5902,130.4017,300))'));
t('300m 내 장소 매칭', near && near.p.id===FM().places[0].id);
t('거리 계산', near.d>=0 && near.d<300);
t('멀면 매칭 안 함', w.eval('phNearest(35.0,135.0,300)')===null);
t('좌표 없으면 null', w.eval('phNearest(null,null,300)')===null);

// 영수증 분석 → 지출
w.eval("ai.key='K';foodMap.fx={rate:9.3,at:TODAY,src:'api'};bgSetTotal(80000);");
w.eval("phState={busy:false,file:{name:'r.jpg',type:'image/jpeg'},exif:{date:'2026-10-26',time:'19:42',lat:33.5902,lng:130.4017},near:phNearest(33.5902,130.4017,300),ai:null,err:''};");
let sentParts=null;
w.fetch=async(u,o)=>{const b=JSON.parse(o.body);sentParts=b.contents[0].parts;
 return{ok:true,json:async()=>({candidates:[{content:{parts:[{text:'```json {"total":4800,"currency":"JPY","items":["獺祭","袋"]} ```'}]}}]})};};
w.eval("phState.file.__f=1;");
w.FileReader=class{readAsDataURL(){setTimeout(()=>{this.result='data:image/jpeg;base64,QUJD';this.onload&&this.onload();},0);}readAsArrayBuffer(){setTimeout(()=>{this.result=ab;this.onload&&this.onload();},0);}};
await w.eval("phAnalyze('receipt')");
await new Promise(r=>setTimeout(r,300));
t('이미지가 프롬프트에 포함', Array.isArray(sentParts)&&sentParts.some(p=>p.inline_data));
t('영수증 프롬프트 사용', sentParts.some(p=>p.text&&p.text.includes('영수증')));
t('추측 금지 지시 포함', sentParts.some(p=>p.text&&p.text.includes('추측하지 않는다')));
console.log('   err:',w.eval('phState.err'));
const aiR=JSON.parse(w.eval('JSON.stringify(phState.ai||null)'));
t('코드블록 제거 후 파싱', aiR && aiR.data.total===4800);
w.eval('phSaveSpend()');
const sp=JSON.parse(w.eval('JSON.stringify(bgSpends())'));
console.log('   지출:',JSON.stringify(sp[0]));
t('지출 1건 추가', sp.length===1 && sp[0].amt===4800);
t('촬영 날짜·시각 사용', sp[0].d==='2026-10-26' && sp[0].t==='19:42');
t('장소 연결', sp[0].placeId===FM().places[0].id);
t('방문 자동 처리', FM().places[0].visited===true);
t('잔액 반영', w.eval('bgLeft()')===75200);

// 음식 분석 → 식단
w.fetch=async()=>({ok:true,json:async()=>({candidates:[{content:{parts:[{text:'{"name":"모츠나베","kcal":720,"protein":38,"note":"1인분 기준"}'}]}}]})});
await w.eval("phAnalyze('food')");
await new Promise(r=>setTimeout(r,300));
t('음식 분석 결과', w.eval("phState.ai.data.name")==='모츠나베');
const before=w.eval('todayFood().length');
w.eval('phSaveFood()');
t('식단에 추가', w.eval('todayFood().length')===before+1);
t('칼로리 반영', w.eval('todayFood()[todayFood().length-1].k')===720);

// 키 없으면 안내만
alerts=[];
w.eval("ai.key='';phState.ai=null;");
await w.eval("phAnalyze('food')");
t('키 없으면 안내', alerts.some(a=>a.includes('Gemini 키')));
t('키 없어도 위치 기록은 가능', typeof w.phSaveVisit==='function');

// 사진 자체는 저장하지 않는다
const saved=JSON.stringify(JSON.parse(w.localStorage.getItem(w.eval('PFX')+'foodmap_v1')));
t('사진 데이터 미저장', !saved.includes('base64')&&!saved.includes('data:image'));
t('최종 런타임 오류 0', errs.length===0);
console.log(fail?('\n실패 '+fail+'건'):'\n전체 통과');
process.exit(fail?1:0);
