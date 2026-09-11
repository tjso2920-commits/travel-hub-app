/**
 * 2026-09-11 재검토(13차) 5절 — 일본어 실전 회화("여기서 쓸 말") 화면
 * 연결 검증(실제 Chromium):
 *  1) 일본 목적지 장소 상세에서만 "여기서 쓸 말" 버튼이 보임(다른
 *     나라 장소에는 안 보임).
 *  2) "여기서 쓸 말"을 열면 카테고리별(주문·계산·이동·숙소·재질문)
 *     문장이 실제로 보이고, 원문·발음·뜻이 각각 있음.
 *  3) 🔊 듣기를 누르면 실제로 SpeechSynthesis.speak가 호출됨(클릭
 *     시에만 재생 — 화면을 열자마자 자동재생 안 함).
 *  4) 음성 합성을 지원하지 않는 환경(speechSynthesis 없음)에서는
 *     "지원 안 함" 상태를 정직하게 보여줌(조용히 아무 일도 안
 *     일어나는 게 아니라 실제로 안내함).
 *  5) 재생 실패(onerror)가 나면 버튼이 다시 누를 수 있는 상태로
 *     복구됨(무한 "재생 중" 상태에 갇히지 않음).
 *  6) 프로필 화면 → "여행 도구" → 일본어로 한마디로도 같은 화면을
 *     열 수 있음.
 *
 * 실행: node scripts/test-phrasebook.mjs
 */
import { chromium } from 'playwright';

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

async function newPage(stubSpeech) {
  const errs = [];
  const page = await b.newPage();
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  if (stubSpeech === 'full') {
    // 실제 speechSynthesis가 없는 이 서버리스 Chromium 환경에서도, 클릭
    // → speak() 호출이라는 연결 자체는 진짜로 검증하고 싶으므로 최소
    // stub을 주입한다(호출 여부·인자를 기록하는 용도일 뿐, 발음 자체를
    // 대신 판정하지 않는다 — 문장 내용의 정확성은 코드 리뷰로 확인함).
    await page.addInitScript(() => {
      window.__speakCalls = [];
      class FakeUtterance { constructor(text) { this.text = text; this.lang = ''; this.rate = 1; this.voice = null; this.onstart = null; this.onend = null; this.onerror = null; } }
      window.SpeechSynthesisUtterance = FakeUtterance;
      // 실제 Chromium의 window.speechSynthesis는 일반 대입으로는 안 바뀐다
      // (읽기전용 접근자) — defineProperty로 강제로 덮어써야 한다.
      Object.defineProperty(window, 'speechSynthesis', {
        configurable: true,
        value: {
          getVoices: () => [{ name: 'Fake JA Voice', lang: 'ja-JP' }],
          cancel: () => {},
          speak: (u) => { window.__speakCalls.push({ text: u.text, lang: u.lang }); setTimeout(() => { if (u.onstart) u.onstart(); setTimeout(() => { if (u.onend) u.onend(); }, 30); }, 10); },
        },
      });
    });
  } else if (stubSpeech === 'error') {
    await page.addInitScript(() => {
      window.__speakCalls = [];
      class FakeUtterance { constructor(text) { this.text = text; this.onerror = null; this.onstart = null; this.onend = null; } }
      window.SpeechSynthesisUtterance = FakeUtterance;
      Object.defineProperty(window, 'speechSynthesis', {
        configurable: true,
        value: {
          getVoices: () => [],
          cancel: () => {},
          speak: (u) => { window.__speakCalls.push({ text: u.text }); setTimeout(() => { if (u.onerror) u.onerror(); }, 10); },
        },
      });
    });
  } else if (stubSpeech === 'unsupported') {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: undefined });
      Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: undefined });
    });
  }
  await page.goto('file://' + process.cwd() + '/src/design/index.html');
  await page.waitForTimeout(200);
  return { page, errs };
}

// =====================================================================
// 1) 일본 목적지에서만 버튼이 보임 — 다른 나라 장소에는 안 보임.
// =====================================================================
{
  const { page, errs } = await newPage('full');
  await page.evaluate(() => {
    foodMap.places = [
      { id: 'jp1', name: '후쿠오카가게', cat: '맛집·식당', catConfirmed: true, city: '후쿠오카', cityKnown: true, cityConfirmed: true, sourceLists: [], tags: [] },
      { id: 'th1', name: '방콕가게', cat: '맛집·식당', catConfirmed: true, city: '방콕', cityKnown: true, cityConfirmed: true, sourceLists: [], tags: [] },
    ];
    A.saveFoodMap(foodMap);
  });
  await page.reload();
  await page.waitForTimeout(200);
  await page.evaluate(() => { city = '후쿠오카'; updateCity(); detail('jp1'); });
  await page.waitForTimeout(150);
  const jpHasBtn = await page.evaluate(() => !!document.querySelector('[data-open-phrasebook]'));
  t('1) 일본 목적지(후쿠오카) 장소 상세에는 "여기서 쓸 말" 버튼이 보임', jpHasBtn);
  await page.evaluate(() => { const c = document.getElementById('close'); if (c) c.click(); });

  await page.evaluate(() => { city = '방콕'; updateCity(); detail('th1'); });
  await page.waitForTimeout(150);
  const thHasBtn = await page.evaluate(() => !!document.querySelector('[data-open-phrasebook]'));
  t('1) 일본이 아닌 목적지(방콕) 장소 상세에는 버튼이 안 보임', !thHasBtn);

  await page.close();
}

// =====================================================================
// 2) 화면을 열면 카테고리별 문장이 실제로 보임(원문·발음·뜻 각각 있음).
// =====================================================================
{
  const { page, errs } = await newPage('full');
  await page.evaluate(() => phrasebookSheet());
  await page.waitForTimeout(150);
  const rows = await page.evaluate(() => Array.from(document.querySelectorAll('.phrase-row')).map((el) => ({
    jp: el.querySelector('.phrase-jp').textContent,
    reading: el.querySelector('.phrase-reading').textContent,
    ko: el.querySelector('.phrase-ko').textContent,
  })));
  t('2) 문장이 실제로 여러 개 보임', rows.length >= 8);
  t('2) 모든 항목에 원문·발음·뜻이 다 있음(비어있지 않음)', rows.every((r) => r.jp.trim() && r.reading.trim() && r.ko.trim()));
  const cats = await page.evaluate(() => Array.from(document.querySelectorAll('.phrase-cat-title')).map((el) => el.textContent));
  t('2) 요구된 다섯 상황(주문·계산·이동·숙소·재질문)이 전부 있음', ['주문할 때', '계산할 때', '이동할 때', '숙소에서', '다시 물을 때'].every((c) => cats.includes(c)));
  t('2) 화면을 열자마자 자동으로 speak가 호출되지 않음(클릭 시에만 재생)', (await page.evaluate(() => window.__speakCalls.length)) === 0);
  await page.close();
}

// =====================================================================
// 3) 🔊 듣기를 누르면 실제로 speak가 호출됨.
// =====================================================================
{
  const { page } = await newPage('full');
  await page.evaluate(() => phrasebookSheet());
  await page.waitForTimeout(150);
  await page.click('[data-speak="order-1"]');
  await page.waitForTimeout(100);
  const calls = await page.evaluate(() => window.__speakCalls);
  t('3) 듣기를 누르면 실제로 speak가 호출됨', calls.length === 1);
  t('3) 해당 문장의 원문 텍스트로 호출됨', calls[0] && calls[0].text === 'これをください。');
  await page.waitForTimeout(100);
  const btnLabelAfterEnd = await page.evaluate(() => document.querySelector('[data-speak="order-1"]').textContent);
  t('3) 재생이 끝나면 버튼이 원래 상태로 돌아옴', btnLabelAfterEnd.includes('듣기') && !btnLabelAfterEnd.includes('재생 중'));
  await page.close();
}

// =====================================================================
// 4) 음성 합성 미지원 환경 — 정직하게 "지원 안 함" 상태를 보여줌.
// =====================================================================
{
  const { page, errs } = await newPage('unsupported');
  await page.evaluate(() => phrasebookSheet());
  await page.waitForTimeout(150);
  await page.click('[data-speak="order-1"]');
  await page.waitForTimeout(100);
  const label = await page.evaluate(() => document.querySelector('[data-speak="order-1"]').textContent);
  t('4) 음성 미지원 환경에서는 정직하게 "지원하지 않는다"고 알림', label.includes('지원'));
  t('4) 콘솔/런타임 오류로 이어지지 않음', errs.length === 0);
  await page.close();
}

// =====================================================================
// 5) 재생 실패(onerror) — 버튼이 다시 누를 수 있는 상태로 복구됨.
// =====================================================================
{
  const { page } = await newPage('error');
  await page.evaluate(() => phrasebookSheet());
  await page.waitForTimeout(150);
  await page.click('[data-speak="order-1"]');
  await page.waitForTimeout(100);
  const btn = await page.evaluate(() => ({ text: document.querySelector('[data-speak="order-1"]').textContent, disabled: document.querySelector('[data-speak="order-1"]').disabled }));
  t('5) 재생 실패 시 실패를 알리고 버튼이 다시 눌릴 수 있는 상태임', btn.text.includes('실패') && btn.disabled === false);
  await page.close();
}

// =====================================================================
// 6) 프로필 → 여행 도구 → 일본어로 한마디로도 같은 화면을 열 수 있음.
// =====================================================================
{
  const { page } = await newPage('full');
  await page.evaluate(() => profile());
  await page.waitForTimeout(150);
  await page.click('[data-tools-open]');
  await page.waitForTimeout(150);
  const toolBtnVisible = await page.evaluate(() => !!document.querySelector('[data-tool="jp-phrasebook"]'));
  t('6) 여행 도구 화면에 일본어 도구 항목이 보임', toolBtnVisible);
  await page.click('[data-tool="jp-phrasebook"]');
  await page.waitForTimeout(150);
  const phraseVisible = await page.evaluate(() => document.querySelectorAll('.phrase-row').length >= 8);
  t('6) 눌러서 실제로 같은 회화 화면이 열림', phraseVisible);
  await page.close();
}

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
await b.close();
process.exit(fail ? 1 : 0);
