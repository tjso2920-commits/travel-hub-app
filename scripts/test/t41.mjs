/**
 * 돈과 분류 — 기능 검수에서 나온 진짜 오류 둘.
 *
 * 1. **환율이 나라를 안 따라갔다.** 일본에서 환율을 받아 두고 태국으로 바꾸면
 *    엔화 환율(9.3)을 바트에 그대로 썼다. 1,000바트가 "약 9,300원" (진짜는 40,000원 안팎).
 *    화면에는 "1THB ≈ 9.3KRW" 라고 대놓고 적혔다. 글자가 어색한 것과 차원이 다르다 —
 *    돈 쓰는 판단이 틀어진다. 이제 통화 짝이 안 맞으면 **아무것도 안 보여준다.**
 *
 * 2. **분류 자동 판정이 일본 밖에서 안 먹혔다.** 실제 가게 이름으로 재 보니
 *    터키 0/6 · 베트남 1/6 · 프랑스 2/7. 137곳을 가져오면 대부분 '기타'로 몰려서
 *    분류별 묶기도 필터도 껍데기만 남았다.
 *
 * 여기서는 **실제 가게 이름**으로 잰다. 지어낸 이름으로는 이 오류가 안 잡혔다.
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

/* ── 1. 환율 ─────────────────────────────────────────────────────────── */
w.eval("foodMap.dest='후쿠오카';fmSetCountry('JP');foodMap.fx={rate:9.3,at:TODAY,src:'api',from:'JPY',to:'KRW'};save('foodmap_v1',foodMap);");
t('일본 환산 나옴', w.eval('fxBoth(10000)') === '10,000엔 (약 93,000원)');

/* 나라를 바꿀 때 담아 둔 게 있으면 "새 여행으로 시작할까요?" 를 묻는다(t46).
   여기서 보려는 것은 **취소하고 목적지만 바꿨을 때** 엔화 환율이 바트에 안 쓰이는가다. */
w.confirm = () => false;
w.eval("fmSetCountry('TH');");
t('태국 통화는 THB', w.eval('fxCur()') === 'THB');
t('엔화 환율을 바트에 안 씀', w.eval('fxRate()') === null);
t('틀린 환산 대신 아무것도 안 보임', w.eval('fxBoth(1000)') === '1,000바트');
t('환율 카드가 "다시 받기"라고 알려줌', /환율 없음|다시 받기/.test(w.eval('fxHTML()')));
t('환율 카드가 왜 없는지 설명함', w.eval('fxHTML()').includes('목적지가 바뀌어'));

w.eval("fmSetCountry('JP');");
t('일본으로 되돌아오면 원래 환율이 살아남', w.eval('fxBoth(10000)') === '10,000엔 (약 93,000원)');
w.confirm = () => true;

/* 예전에 저장된 값에는 통화 짝이 없다 — 그때는 전부 일본이었다 */
w.eval("foodMap.fx={rate:9.3,at:TODAY,src:'api'};save('foodmap_v1',foodMap);fmSetCountry('JP');");
t('짝 없는 옛 값도 일본에서는 그대로 씀', w.eval('fxRate()') === 9.3);
w.confirm = () => false;
w.eval("fmSetCountry('FR');");
t('짝 없는 옛 값을 유로에는 안 씀', w.eval('fxRate()') === null);

/* 새로 넣은 값에는 짝이 붙는가 */
w.eval("fmSetCountry('FR');fxSetRate(1450);");
t('직접 넣은 환율에 통화 짝이 붙음', w.eval("foodMap.fx.from") === 'EUR' && w.eval("foodMap.fx.to") === 'KRW');
t('유로 환산 나옴', w.eval('fxBoth(10)') === '10유로 (약 14,500원)');
w.eval("fmSetCountry('JP');");
t('유로 환율을 엔에 안 씀', w.eval('fxRate()') === null);
w.confirm = () => true;

/* ── 2. 분류 자동 판정 ───────────────────────────────────────────────── */
const CASES = [
  /* 일본 — 원래 되던 것. 여기가 틀어지면 지금 쓰는 사람이 다친다 */
  ['寿司 さいとう', '맛집·식당'], ['ラーメン一蘭', '맛집·식당'], ['スターバックス カフェ', '카페·디저트'],
  ['居酒屋 とり金', '바·이자카야'], ['博多駅', '교통'], ['櫛田神社', '관광·명소'],
  ['ホテル日航', '숙소'], ['天然温泉 なごみ', '사우나·온천'], ['マッサージ ラフィネ', '마사지·스파'],
  ['薬局ココカラ', '약국·병원'], ['焼肉 牛角', '맛집·식당'],
  /* 프랑스 */
  ['Le Comptoir du Relais', '맛집·식당'], ['Boulangerie Poilâne', '카페·디저트'],
  ['Bar Hemingway', '바·이자카야'], ['Pharmacie Monge', '약국·병원'],
  ['Musée du Louvre', '관광·명소'], ['Hôtel Lutetia', '숙소'], ['Galeries Lafayette', '쇼핑'],
  /* 태국 */
  ['Som Tam Nua', '맛집·식당'], ['Health Land Massage', '마사지·스파'],
  ['Boots Pharmacy', '약국·병원'], ['Wat Pho Temple', '관광·명소'],
  /* 베트남 */
  ['Phở Bát Đàn', '맛집·식당'], ['Cộng Cà Phê', '카페·디저트'], ['Bia Hơi Corner', '바·이자카야'],
  ['Nhà thuốc Pharmacity', '약국·병원'], ['Chùa Một Cột', '관광·명소'],
  /* 터키 */
  ['Çiya Sofrası', '맛집·식당'], ['Mandabatmaz Kahve', '카페·디저트'], ['Meyhane Yakup', '바·이자카야'],
  ['Eczane Merkez', '약국·병원'], ['Cemberlitas Hamami', '사우나·온천'], ['Ayasofya Camii', '관광·명소'],
  /* 미국·영어권 */
  ["Joe's Pizza", '맛집·식당'], ['Blue Bottle Coffee', '카페·디저트'],
  ['The Dead Rabbit Pub', '바·이자카야'], ['CVS Pharmacy', '약국·병원'],
  ['Aire Ancient Baths', '사우나·온천'], ['Central Park', '관광·명소'], ['Ace Hotel', '숙소'],
  /* 독일·이탈리아·스페인 */
  ['Ristorante Da Vittorio', '맛집·식당'], ['Konditorei Buchwald', '카페·디저트'],
  ['Hofbräuhaus Brauerei', '바·이자카야'], ['Mercado de San Miguel', '쇼핑'],
  ['Museo del Prado', '관광·명소'], ['Apotheke am Markt', '약국·병원'],
  ['Schloss Neuschwanstein', '관광·명소'],
  /* 인니·말레이 */
  ['Warung Made', '맛집·식당'], ['Kopi Kenangan', '카페·디저트'], ['Pasar Baru', '쇼핑'],
  ['Guardian Pharmacy', '약국·병원']
];
let miss = [];
CASES.forEach(([name, want]) => {
  const got = w.eval(`fmInfer(${JSON.stringify(name)})`);
  if (got !== want) miss.push(`${name} → ${got} (기대 ${want})`);
});
t(`실제 가게 이름 ${CASES.length}개 전부 맞음`, miss.length === 0);
miss.slice(0, 8).forEach((x) => console.log('        ·', x));

/* 순서가 규칙이다 — 여기가 뒤집히면 조용히 틀린다 */
const ORDER = [
  ['Park Hotel Tokyo', '숙소'],        /* 숙소가 관광(park)보다 위 */
  ['Hotel Bar Lounge', '숙소'],        /* 숙소가 바보다 위 */
  ['Market Hotel', '숙소'],            /* 숙소가 쇼핑보다 위 */
  ['온천 스파 리조트', '사우나·온천'],   /* 온천이 마사지(스파)보다 위 */
  ['스파 리조트', '마사지·스파'],
  ['Bar à Café Rive', '카페·디저트'],  /* 카페가 바보다 위 */
  ['Museum Cafe', '카페·디저트'],
  ['Grand Central Station', '교통']    /* 교통이 관광보다 위 */
];
let omiss = [];
ORDER.forEach(([name, want]) => {
  const got = w.eval(`fmInfer(${JSON.stringify(name)})`);
  if (got !== want) omiss.push(`${name} → ${got} (기대 ${want})`);
});
t('헷갈리는 이름도 순서대로 판정', omiss.length === 0);
omiss.forEach((x) => console.log('        ·', x));

/* 아무것도 안 걸리면 기타 */
t('모르는 이름은 기타', w.eval("fmInfer('Zzxq Qq')") === '기타');
t('빈 값도 안 죽음', w.eval("fmInfer('')") === '기타' && w.eval('fmInfer(null)') === '기타');

t('최종 런타임 오류 0', errs.length === 0);
if (errs.length) console.log('  ', errs.slice(0, 3));
console.log(fail ? ('\n실패 ' + fail + '건') : '\n전체 통과');
process.exit(fail ? 1 : 0);
