/**
 * 2026-09-11 재검토(10차) 6절 — AI 원가 검증 보고를 위한 ①~④ 항목
 * (전체 장소 수·규칙 해결 수·AI 처리 대상 수·배치 요청 수) 산출.
 *
 * **중요**: 이 스크립트가 만드는 입력은 합성(synthetic) 데이터다.
 * 실제 고객이 Google Maps에 저장한 장소 이름 분포와 다를 수 있다 —
 * "합성 데이터의 분류 성공률을 실제 고객 평균으로 일반화하지 마"라는
 * 지시에 따라, 이 결과는 "우리 코드가 실제로 어떻게 동작하는가"를
 * 보여줄 뿐 실사용 성공률의 근거로 쓰면 안 된다(docs/BUSINESS_DECISIONS.md
 * 10차 갱신에 그대로 이렇게 명시한다).
 *
 * 실행: node scripts/analyze-classification-rate.mjs
 */
import { chromium } from 'playwright';

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage();
await p.goto('file://' + process.cwd() + '/src/design/index.html');
await p.waitForTimeout(200);

// 여러 나라·업종을 섞은 합성 이름 목록 — "일본 중심 21개"에 갇히지
// 않는다는 지시를 검증에도 반영해, 의도적으로 다국어·다업종을 섞었다.
// 각 항목은 [name, note, address] 형태.
const CLEAR_NAMES = [
  ['스미비 야키토리 이자카야', '', '후쿠오카시'],
  ['스시 마사', '', '도쿄'],
  ['Ramen Ichiban', '', 'Tokyo'],
  ['starbucks coffee', '', 'seoul'],
  ['Trattoria Roma', '', 'Rome'],
  ['Le Bistro Parisien', '', 'Paris'],
  ['Taco Loco', '', 'Mexico City'],
  ['Pad Thai Kitchen', '', 'Bangkok'],
  ['Nha Hang Pho 24', '', 'Hanoi'],
  ['Curry House Delhi', '', 'Mumbai'],
  ['Hotel Bella Vista', '', 'Barcelona'],
  ['호텔 신라', '', '서울'],
  ['Fukuoka Airport', '', '후쿠오카'],
  ['하카타역', '', '후쿠오카'],
  ['Louvre Museum', '', 'Paris'],
  ['남산타워', '', '서울'],
  ['이자카야 토리', '', '오사카'],
  ['居酒屋 花子', '', '大阪'],
  ['Massage Thai Spa', '', 'Chiang Mai'],
  ['온천 료칸', '', '벳푸'],
  ['田中酒屋', '', '東京'],
  ['Shopping Mall Central', '', 'Singapore'],
  ['편의점 GS25', '', '서울'],
  ['Pharmacy Boots', '', 'London'],
  ['Dim Sum Palace', '', 'Hong Kong'],
];
// 이름만으로는 업종을 짐작할 근거가 거의 없는(=AI 후보가 될) 합성 이름들.
const AMBIGUOUS_NAMES = [
  ['하나', '', ''], ['모모', '', ''], ['별빛', '', ''], ['소울', '', ''],
  ['블루문', '', ''], ['라운지 7', '', ''], ['공간', '', ''], ['더 플레이스', '', ''],
  ['오늘의 기록', '', ''], ['902호', '', ''], ['그날의 온도', '', ''], ['안녕', '', ''],
];

function buildCsvRows(n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    // 약 70%는 근거가 뚜렷한 이름, 30%는 애매한 이름 — 실사용 분포를
    // 안다고 주장하지 않는 임의 비율(문서에도 그대로 밝힌다).
    const pool = (i % 10 < 7) ? CLEAR_NAMES : AMBIGUOUS_NAMES;
    const [name, note, address] = pool[i % pool.length];
    rows.push(`${name}${i},${note},${address}`); // 이름 뒤에 인덱스를 붙여 중복 병합을 방지(각각 별개 장소로 취급).
  }
  return 'name,note,address\n' + rows.join('\n');
}

async function analyze(n) {
  return p.evaluate((csv) => {
    const places = [];
    A.merge(A.parseCsv(csv), 'src', places, 'batch1');
    const total = places.length;
    const ruleResolved = places.filter((x) => x.cat !== '기타' || (x.tags && x.tags.length > 0)).length;
    const unresolved = total - ruleResolved;
    return { total, ruleResolved, unresolved };
  }, buildCsvRows(n));
}

const results = {};
for (const n of [50, 160, 300]) {
  results[n] = await analyze(n);
}
// "이후 3곳 추가" 시나리오 — 이미 160곳을 가져온 뒤 3곳을 더 추가하는
// 경우, 새로 추가된 3곳만 분류 대상이 된다(기존 160곳은 이미 분류·
// 캐시돼 있어 재처리 안 함 — 10차 6절 "신규·변경된 항목 중 미해결
// 항목만 배치 처리").
results['+3'] = await analyze(3);

const AI_MAX_ITEMS_PER_BATCH = 20; // config.mjs aiClassify.maxItemsPerBatch 기본값과 동일하게 맞춤.
for (const key of Object.keys(results)) {
  const r = results[key];
  r.batchRequests = Math.ceil(r.unresolved / AI_MAX_ITEMS_PER_BATCH) || 0;
}

console.log(JSON.stringify(results, null, 2));
await b.close();
