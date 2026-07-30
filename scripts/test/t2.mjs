// TARGET: personal
import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs';
const file=process.argv[2]||'private/personal.html';
const html=fs.readFileSync(file,'utf8');
const csv=fs.readFileSync('private/후쿠오카_137.csv','utf8');
const errs=[]; const vc=new VirtualConsole(); vc.on('jsdomError',e=>errs.push(e.message));
const dom=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:vc,url:'https://local.test/'});
const w=dom.window;
await new Promise(r=>setTimeout(r,600));
const FM=()=>w.eval('foodMap');
let fail=0; const t=(n,c)=>{console.log((c?'PASS ':'FAIL ')+n); if(!c)fail++;};
t('런타임 오류 0', errs.length===0);

// 1. CSV 파싱
const parsed=w.fmCsv(csv);
t('CSV 137건 파싱', parsed.length===137);
t('이름 매핑(제목)', parsed[0].name==='호텔 리브맥스 후쿠오카 텐진');
t('메모 매핑', parsed[0].note.includes('숙소'));
t('URL 매핑', parsed[0].url.startsWith('https://'));
t('좌표는 비어있음', parsed.every(x=>x.lat===null&&x.lng===null));
t('경주 제외됨', !parsed.some(x=>x.name.includes('경주')));

// 2. merge
let z=w.fmMerge(parsed);
t('137건 신규 추가', z.added===137&&z.updated===0);
t('저장소 반영', FM().places.length===137);
t('좌표 없음 판정 137', w.eval('fmNoCoordCount()')===137);

// 3. 같은 CSV 재수입 → 중복 없음
z=w.fmMerge(w.fmCsv(csv));
t('재수입 중복 0', z.added===0&&z.updated===137&&FM().places.length===137);

// 4. 일괄 좌표 보강 (fetch 모킹, 3건만)
const sample=FM().places.slice(0,3);
FM().places=sample; FM().apiKey='TEST_KEY';
/* 앱이 부팅 시 렌더하므로 #fmApiKey 입력칸이 이미 존재한다.
   fmEnrichAll 은 내부에서 fmSaveApi 로 그 입력칸 값을 다시 읽으므로,
   객체에만 키를 넣으면 빈 입력칸 값으로 덮여 호출이 0건이 된다. 입력칸도 함께 채운다. */
w.eval('renderFoodMap()');
{const k=w.document.getElementById('fmApiKey');if(k)k.value='TEST_KEY';}
let calls=0, sentKeys=new Set();
w.fetch=async(url,opt)=>{
  calls++; sentKeys.add(opt.headers['X-Goog-Api-Key']);
  if(calls===2) return {ok:true,json:async()=>({places:[]})};   // 매칭 실패 케이스
  return {ok:true,json:async()=>({places:[{id:'PL'+calls,displayName:{text:'JAPANESE NAME'},formattedAddress:'福岡県福岡市中央区天神'+calls,location:{latitude:33.59+calls/1000,longitude:130.40+calls/1000},primaryType:'restaurant',rating:4.2,userRatingCount:100,googleMapsUri:'https://maps.google.com/?cid=1',businessStatus:'OPERATIONAL'}]})};
};
w.confirm=()=>true; w.eval('fxAutoTried=true');  // 환율 자동 갱신이 호출 수를 흐리지 않게 막는다
w.alert=()=>{};
const before=sample.map(p=>p.name);
await w.fmEnrichAll();
await new Promise(r=>setTimeout(r,300));
t('3건 모두 호출', calls===3);
t('키 헤더 전달', sentKeys.has('TEST_KEY'));
t('성공 2건 좌표 채워짐', FM().places.filter(p=>w.fm2HasCoords(p)).length===2);
t('실패 1건 좌표 없음 유지', FM().places[1].lat===null);
t('사용자 이름 유지(덮어쓰기 안 함)', FM().places.map(p=>p.name).join('|')===before.join('|'));
t('주소 채워짐', (FM().places[0].address||'').includes('福岡'));
t('원본 URL 보존', FM().places[0].url.includes('google.com/maps/place'));
t('canonical 링크는 별도 필드', FM().places[0].mapsUri==='https://maps.google.com/?cid=1');
t('평점 반영', FM().places[0].rating===4.2);
t('저장됨', JSON.parse(w.localStorage.getItem('cp1_foodmap_v1')).places.filter(p=>p.lat!==null).length===2);

// 5. 좌표 채운 뒤 재수입해도 중복 없음
z=w.fmMerge(w.fmCsv(csv).slice(0,3));
t('보강 후 재수입 중복 0', z.added===0&&FM().places.length===3);
t('재수입해도 좌표 유지', FM().places.filter(p=>w.fm2HasCoords(p)).length===2);

console.log(fail?('\n실패 '+fail+'건'):'\n전체 통과');
process.exit(fail?1:0);
