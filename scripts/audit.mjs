/**
 * 화면 검수 — 기능 검사가 못 잡는 것을 잡는다.
 *
 * jsdom 은 색과 크기를 계산하지 않으므로, 글자가 배경에 묻히거나 버튼이 너무 작아도
 * 기능 검사는 전부 통과한다. 이 검사는 실제 Chromium 으로 두 빌드를 띄워서
 * 모든 탭의 details 까지 펼친 뒤 다음을 본다.
 *
 *  - 명암비 3:1 미만인 글자 (반투명 배경을 실제로 합성해서 계산한다)
 *  - 44px 미만으로 누르는 것 (버튼·고르는 칸·링크·접는 제목) — 걸으면서 한 손으로 누르는 앱이다
 *  - 글씨 16px 미만인 입력칸 — 아이폰이 탭할 때 화면을 확대해 버린다
 *  - 가로 스크롤이 생기는 화면
 *  - 런타임 오류와 콘솔 오류
 *
 * 판매용은 데이터 0으로 띄운다. 구매자가 처음 보는 화면이 그 상태다.
 */
/* playwright 가 없어도 저장소가 망가지지 않게 한다. 화면 검수는 선택 도구다. */
let chromium;
try{ ({chromium}=await import('playwright')); }
catch(e){
  console.log('화면 검수 건너뜀 — playwright 가 설치돼 있지 않습니다.');
  console.log('설치: npm i -D playwright   (브라우저는 이미 있으면 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1)');
  process.exit(0);
}
import { readFileSync } from 'node:fs';
const csv=readFileSync('private/후쿠오카_137.csv');
const b=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
const bad=[];
async function run(label,file,seed){
  const p=await b.newPage({viewport:{width:390,height:844},deviceScaleFactor:2});
  const errs=[];
  p.on('pageerror',e=>errs.push(String(e).slice(0,140)));
  p.on('console',m=>{if(m.type()==='error'&&!/tile.openstreetmap|net::ERR|Failed to load/.test(m.text()))errs.push('console: '+m.text().slice(0,120));});
  await p.goto('file://'+file);
  if(seed)await p.evaluate(seed.fn,seed.arg);
  for(const t of ['collect','plan','now','jp']){
    await p.evaluate(x=>showTab(x),t); await p.waitForTimeout(250);
    // 모든 details 를 펼쳐 숨은 화면까지 본다
    await p.evaluate(()=>document.querySelectorAll('.tab.on details').forEach(d=>d.open=true));
    await p.waitForTimeout(200);
    const c=await p.evaluate(()=>{
      /* 알파를 무시하면 반투명 배경을 불투명으로 착각해 없는 문제를 만든다.
         조상 배경 위에 알파를 실제로 합성해서 최종 색을 구한다. */
      const rgba=c=>{const m=String(c).match(/[\d.]+/g);if(!m)return null;
        return [ +m[0], +m[1], +m[2], m[3]===undefined?1:+m[3] ];};
      const over=(f,b)=>[0,1,2].map(i=>f[i]*f[3]+b[i]*(1-f[3])).concat(1);
      const lum=c=>{const f=v=>{v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4)};
        return .2126*f(c[0])+.7152*f(c[1])+.0722*f(c[2]);};
      const bgOf=e=>{const stack=[];let n=e;
        while(n&&n!==document.documentElement){const c=rgba(getComputedStyle(n).backgroundColor);
          if(c&&c[3]>0){stack.push(c);if(c[3]>=1)break;} n=n.parentElement;}
        let out=[244,243,240,1];
        for(let i=stack.length-1;i>=0;i--)out=over(stack[i],out);
        return out;};
      const out=[];
      document.querySelectorAll('.tab.on *').forEach(e=>{
        const txt=(e.childNodes[0]&&e.childNodes[0].nodeType===3?e.childNodes[0].textContent:'').trim();
        if(!txt||txt.length<2)return;
        const s=getComputedStyle(e); if(s.display==='none'||s.visibility==='hidden')return;
        const fg=rgba(s.color); if(!fg)return;
        const L1=lum(over(fg,bgOf(e))),L2=lum(bgOf(e));
        const r=(Math.max(L1,L2)+.05)/(Math.min(L1,L2)+.05);
        if(r<3)out.push(txt.slice(0,20)+' ('+r.toFixed(1)+':1)');
      });
      // 가로 스크롤 = 화면 밖으로 나간 요소
      const wide=document.documentElement.scrollWidth>document.documentElement.clientWidth+2;
      // 44px 미만으로 누르는 것 — 기준은 44 다. 40 으로 봐 주면 42px 짜리가 그냥 통과한다.
      // button 만 보면 안 된다. 고르는 칸·링크·접는 제목도 손가락으로 누른다.
      const small=[...document.querySelectorAll(
        '.tab.on button, .tab.on .xaction, .tab.on select, .tab.on summary, .tab.on a, .tab.on input')]
        .filter(e=>{const r=e.getBoundingClientRect();return r.height>0&&r.width>0&&r.height<44;})
        .map(e=>(e.textContent||e.tagName).trim().slice(0,14)+' '+Math.round(e.getBoundingClientRect().height)+'px');
      // 아이폰은 입력칸 글씨가 16px 보다 작으면 탭할 때 화면을 확대해 버린다
      const zoomy=[...document.querySelectorAll('.tab.on input, .tab.on select, .tab.on textarea')]
        .filter(e=>{const r=e.getBoundingClientRect();
          return r.height>0&&parseFloat(getComputedStyle(e).fontSize)<16;})
        .map(e=>(e.className||e.tagName)+' '+getComputedStyle(e).fontSize);
      return {contrast:[...new Set(out)],over:wide,small:[...new Set(small)],zoomy:[...new Set(zoomy)]};
    });
    if(c.contrast.length||c.over||c.small.length||c.zoomy.length)
      bad.push({빌드:label,탭:t,대비:c.contrast,가로넘침:c.over,작은버튼:c.small,확대유발:c.zoomy});
  }
  if(errs.length)bad.push({빌드:label,오류:[...new Set(errs)]});
  await p.close();
}
const seed={fn:async(b64)=>{
  const bin=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));
  await fm2ImportFile(new File([bin],'후쿠오카.csv',{type:'text/csv'}),true);
  foodMap.places.forEach((x,i)=>{const h=[[33.5902,130.3986],[33.5895,130.42],[33.579,130.396]][i%3];
    x.lat=h[0]+((i%17)-8)*8e-4;x.lng=h[1]+((i%13)-6)*8e-4;});
  foodMap.selected=foodMap.places[0].id;
  fmSetHotelFromSpot();bgSetTotal(80000);bgSetDays(4);foodMap.courseStart=11;csBuild();plBuild();renderFoodMap();
}, arg:csv.toString('base64')};

await run('개인용(데이터 137)',process.cwd()+'/private/personal.html',seed);
await run('판매용(데이터 0)',process.cwd()+'/src/index.html',null);

/* ── 화면 크기·글씨 크기를 바꿔 가며 한 번 더 ────────────────────────────
   위 검사는 390px 기본 글씨 한 가지만 본다. 실제로는 작은 폰(SE 320·375)을
   쓰는 사람이 있고, 나이 있는 구매자는 아이폰 설정에서 글씨를 키워 놓는다.
   그때 가로로 삐져나가거나 누르는 것이 44px 아래로 눌리는지 본다. */
const SIZES=[['아이폰 SE1',320,100],['아이폰 SE2/3',375,100],
 ['글씨 140%',390,140],['작은 폰+큰 글씨',375,130]];
for(const [label,wpx,scale] of SIZES){
  const p=await b.newPage({viewport:{width:wpx,height:844},deviceScaleFactor:2});
  await p.goto('file://'+process.cwd()+'/src/index.html');
  await p.evaluate(sc=>{
    document.documentElement.style.fontSize=(16*sc/100)+'px';
    window.alert=()=>{};
    const sp=document.getElementById('splash'); if(sp&&sp.parentNode)sp.parentNode.removeChild(sp);
    foodMap.setupSeen=true; foodMap.setupDone=true; save('foodmap_v1',foodMap);
    startApp(); if(typeof setupClose==='function')setupClose();
  },scale);
  await p.waitForTimeout(250);
  for(const t of ['collect','plan','now','jp']){
    await p.evaluate(x=>{showTab(x); x==='jp'?renderJapanese():renderFoodMap();},t);
    await p.waitForTimeout(200);
    await p.evaluate(()=>document.querySelectorAll('.tab.on details').forEach(d=>d.open=true));
    await p.waitForTimeout(150);
    const c=await p.evaluate(w=>({
      over:document.documentElement.scrollWidth>w+2,
      small:[...new Set([...document.querySelectorAll(
        '.tab.on button, .tab.on select, .tab.on summary, .tab.on a, .tab.on input')]
        .filter(e=>{const r=e.getBoundingClientRect();return r.height>0&&r.width>0&&r.height<44;})
        .map(e=>(e.textContent||e.tagName).trim().slice(0,12)+' '+Math.round(e.getBoundingClientRect().height)+'px'))]
    }),wpx);
    if(c.over||c.small.length)bad.push({크기:label+' '+wpx+'px/'+scale+'%',탭:t,가로넘침:c.over,작은버튼:c.small});
  }
  await p.close();
}
await b.close();
if(bad.length){console.log(JSON.stringify(bad,null,1));console.log('\n화면 검수 실패 '+bad.length+'건');process.exit(1);}
console.log('화면 검수 통과 — 대비·터치영역·가로넘침·오류 없음');
