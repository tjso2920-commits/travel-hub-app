import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs';
const file=process.argv[2]||'private/personal.html';
const html=fs.readFileSync(file,'utf8');
const errs=[];const vc=new VirtualConsole();vc.on('jsdomError',e=>errs.push(e.message));
const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,url:'https://local.test/'});
const w=dom.window;await new Promise(r=>setTimeout(r,700));
const FM=()=>w.eval('foodMap');
let fail=0;const t=(n,c)=>{console.log((c?'PASS ':'FAIL ')+n);if(!c)fail++;};
let alerts=[]; w.alert=m=>alerts.push(m);
t('런타임 오류 0',errs.length===0); if(errs.length)console.log('  ',errs.slice(0,2));

// 플랫폼 판정
t('유튜브 판정', w.eval("ibDetectPlatform('https://youtu.be/xyz')")==='유튜브');
t('틱톡 판정', w.eval("ibDetectPlatform('https://www.tiktok.com/@a/video/1')")==='틱톡');
t('인스타 판정', w.eval("ibDetectPlatform('https://www.instagram.com/reel/abc/')")==='인스타그램');
t('구글맵 판정', w.eval("ibDetectPlatform('https://maps.app.goo.gl/xyz')")==='구글맵');
t('기타 웹 판정', w.eval("ibDetectPlatform('https://example.com/post/1')")==='웹');

w.eval('renderFoodMap()');

// 담기
w.document.getElementById('ibUrl').value='https://www.instagram.com/reel/abc123/';
w.document.getElementById('ibNote').value='텐진 이자카야, 사장님이 스시 장인 출신이라고 함';
w.eval('ibAdd()');
t('인박스에 담김', FM().inbox.length===1);
t('URL 저장', FM().inbox[0].url==='https://www.instagram.com/reel/abc123/');
t('메모 저장', FM().inbox[0].note.includes('이자카야'));
t('입력칸 초기화', w.document.getElementById('ibUrl').value==='');

const id=FM().inbox[0].id;

// 빈 URL 거부
alerts=[];
w.eval('ibAdd()');
t('빈 URL 거부', alerts.length===1 && FM().inbox.length===1);

// 키 없을 때 추정 시도 → 안내만, 죽지 않음
alerts=[];
await w.eval(`ibGuess('${id}')`);
t('키 없으면 안내', alerts.some(a=>a.includes('Gemini 키')));
t('키 없어도 앱 생존', errs.length===0);

// 키 있을 때 AI 추정
let sentText=null;
w.eval("ai.key='TESTKEY';");
w.fetch=async(u,o)=>{sentText=JSON.parse(o.body).contents[0].parts[0].text;
 return{ok:true,json:async()=>({candidates:[{content:{parts:[{text:'```json {"name":"이자카야 스시장인","city":"후쿠오카","country":"일본","confidence":"보통"} ```'}]}}]})};};
await w.eval(`ibGuess('${id}')`);
t('추정 요청에 메모 포함', sentText!==null && sentText.includes('스시 장인'));
t('추정 결과 이름 저장', FM().inbox[0].guess.name==='이자카야 스시장인');
t('추정 결과 도시·국가', FM().inbox[0].guess.city==='후쿠오카' && FM().inbox[0].guess.country==='일본');

// 실패 시에도 죽지 않음
w.fetch=async()=>{throw new Error('네트워크 끊김');};
await w.eval(`ibGuess('${id}')`);
t('추정 실패해도 앱 생존', errs.length===0 && !!FM().inbox[0].guess);
t('실패 사유 기록', !!FM().inbox[0].guess.err);

// 다시 성공 케이스로 복구 후 확정
w.fetch=async()=>({ok:true,json:async()=>({candidates:[{content:{parts:[{text:'{"name":"이자카야 스시장인","city":"후쿠오카","country":"일본","confidence":"보통"}'}]}}]})});
await w.eval(`ibGuess('${id}')`);
const before=FM().places.length;
w.eval(`ibConfirm('${id}')`);
t('확정 후 인박스에서 제거', FM().inbox.length===0);
t('확정 후 장소로 추가', FM().places.length===before+1);
const p=FM().places[0];
t('장소 이름 반영', p.name==='이자카야 스시장인');
t('원본 링크 보존', p.sourceUrl==='https://www.instagram.com/reel/abc123/');
t('원본 플랫폼 보존', p.sourcePlatform==='인스타그램');
t('저장 이유 보존', p.sourceNote.includes('스시 장인'));
t('좌표는 비어 있음(추가 보강 필요)', p.lat===null && p.lng===null);

// 이름 없이 확정 시도 → 거부
w.document.getElementById('ibUrl').value='https://www.tiktok.com/@b/video/2';
w.eval('ibAdd()');
const id2=FM().inbox[0].id;
alerts=[];
w.eval(`ibConfirm('${id2}')`);
t('이름 없으면 확정 거부', alerts.length===1 && FM().inbox.length===1);

// 삭제
w.eval(`ibDelete('${id2}')`);
t('삭제됨', FM().inbox.length===0);

// 백업 포함 확인
w.document.getElementById('ibUrl').value='https://youtu.be/zzz';
w.eval('ibAdd()');
let cap=null;
w.URL.createObjectURL=(b)=>{cap=JSON.parse(b.a?b.a[0]:'{}');return 'blob:x';};
w.Blob=function(a){this.a=a;};
w.eval('exportData()');
t('백업에 인박스 포함', Array.isArray(cap.foodMap.inbox) && cap.foodMap.inbox.length===1);
t('백업에 API 키 없음', cap.foodMap.apiKey===undefined);

t('최종 런타임 오류 0', errs.length===0);
console.log(fail?('\n실패 '+fail+'건'):'\n전체 통과');
process.exit(fail?1:0);
