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
 * 2026-09-11 재검토(14차) 5절 — 추가:
 *  7) ChatGPT 재현 — 실제로 잘 재생되고 있는(4초보다 긴) 문장이 4초
 *     타이머 때문에 "재생 실패"로 잘못 전환되지 않음(가짜 speech
 *     이벤트로 재현: 재생 중 → 4초 경과 → 정상 유지).
 *  8) 한 문장이 재생 중일 때 다른 문장 버튼을 누르면, 이전 버튼이
 *     원래(듣기) 상태로 복구되고 새 버튼이 재생 중 상태가 됨.
 *  9) 시트를 닫으면(재생 중이어도) 실제로 음성 재생이 취소됨(정리).
 *  10) 한글 발음(kr)이 가나 읽기(reading)와 서로 다른 별도 필드로
 *      실제로 화면에 보임(주석-구현 불일치 재현 차단).
 *  11) 🔍 크게 보기를 누르면 확대 오버레이가 뜨고 닫으면 사라짐.
 *  12) 도시명이 목록에 없어도 country가 "일본"이면 여행 도구 화면에
 *      일본어 도구가 노출됨(도시명 매칭만이 아니라 국가 정보 우선).
 *      반대로 일본 목적지가 전혀 없으면 도구가 안 보임.
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
  } else if (stubSpeech === 'long') {
    // 2026-09-11 재검토(14차) 5절 — 실제 재생이 4초보다 오래 이어지는
    // 상황과, 재생 중에 다른 버튼을 눌러 cancel()이 호출되는 상황을
    // 둘 다 재현한다. onstart 이후 onend를 스스로는 절대 안 부르고
    // (테스트가 직접 끝내거나, cancel이 호출될 때만 onerror로 끝남),
    // cancel()은 실제 브라우저처럼 "지금 말하던 중이던 발화"에
    // onerror를 실제로 통지한다.
    await page.addInitScript(() => {
      window.__speakCalls = [];
      window.__cancelCalls = 0;
      let current = null;
      class FakeUtterance { constructor(text) { this.text = text; this.lang = ''; this.rate = 1; this.voice = null; this.onstart = null; this.onend = null; this.onerror = null; this._done = false; } }
      window.SpeechSynthesisUtterance = FakeUtterance;
      Object.defineProperty(window, 'speechSynthesis', {
        configurable: true,
        value: {
          getVoices: () => [{ name: 'Fake JA Voice', lang: 'ja-JP' }],
          cancel: () => {
            window.__cancelCalls++;
            if (current && !current._done) { current._done = true; if (current.onerror) current.onerror(); }
            current = null;
          },
          speak: (u) => {
            window.__speakCalls.push({ text: u.text });
            current = u;
            setTimeout(() => { if (!u._done && u.onstart) u.onstart(); }, 10);
          },
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

// =====================================================================
// 7) ChatGPT 재현 — 4초보다 길게 재생 중인 문장이 4초 타이머 때문에
//    "재생 실패"로 잘못 전환되지 않음.
// =====================================================================
{
  const { page } = await newPage('long');
  await page.evaluate(() => phrasebookSheet());
  await page.waitForTimeout(150);
  await page.click('[data-speak="order-1"]');
  await page.waitForTimeout(150); // onstart가 실제로 옴 → "재생 중" 상태.
  const midLabel = await page.evaluate(() => document.querySelector('[data-speak="order-1"]').textContent);
  t('7) onstart 이후 실제로 "재생 중" 상태가 됨', midLabel.includes('재생 중'));
  await page.waitForTimeout(4300); // 예전 버그의 4초 타이머가 살아있었다면 여기서 실패로 바뀌었을 시간.
  const afterLabel = await page.evaluate(() => document.querySelector('[data-speak="order-1"]').textContent);
  t('7) 4초가 지나도 여전히 "재생 중"이지 "재생 실패"로 안 바뀜(타이머 분리 확인)', afterLabel.includes('재생 중') && !afterLabel.includes('실패'));
  await page.close();
}

// =====================================================================
// 8) 재생 중 다른 문장 버튼을 누르면 이전 버튼이 원래 상태로 복구됨.
// =====================================================================
{
  const { page } = await newPage('long');
  await page.evaluate(() => phrasebookSheet());
  await page.waitForTimeout(150);
  await page.click('[data-speak="order-1"]');
  await page.waitForTimeout(150);
  const aPlaying = await page.evaluate(() => document.querySelector('[data-speak="order-1"]').textContent.includes('재생 중'));
  t('8) 준비 확인 — A가 실제로 재생 중 상태임', aPlaying);

  await page.click('[data-speak="order-2"]');
  await page.waitForTimeout(20); // 복구는 클릭과 동시에 동기적으로 일어나야 한다(이벤트 순서에 의존 안 함).
  const aAfterSwitch = await page.evaluate(() => document.querySelector('[data-speak="order-1"]').textContent);
  t('8) 다른 버튼을 누르면 이전 버튼(A)이 즉시 원래(듣기) 상태로 복구됨', aAfterSwitch.includes('듣기') && !aAfterSwitch.includes('재생 중'));
  await page.waitForTimeout(150);
  const bPlaying = await page.evaluate(() => document.querySelector('[data-speak="order-2"]').textContent.includes('재생 중'));
  t('8) 새로 누른 버튼(B)은 정상적으로 재생 중 상태가 됨', bPlaying);
  const cancelCalls = await page.evaluate(() => window.__cancelCalls);
  t('8) 전환 과정에서 실제로 이전 재생이 취소됨(cancel 호출됨)', cancelCalls >= 1);
  await page.close();
}

// =====================================================================
// 9) 시트를 닫으면 재생 중이어도 실제로 음성이 취소됨(정리).
// =====================================================================
{
  const { page } = await newPage('long');
  await page.evaluate(() => phrasebookSheet());
  await page.waitForTimeout(150);
  await page.click('[data-speak="order-1"]');
  await page.waitForTimeout(150);
  const cancelBefore = await page.evaluate(() => window.__cancelCalls);
  await page.evaluate(() => { const c = document.getElementById('close'); if (c) c.click(); });
  await page.waitForTimeout(50);
  const cancelAfter = await page.evaluate(() => window.__cancelCalls);
  t('9) 시트를 닫으면 재생 중이던 음성이 실제로 취소됨', cancelAfter > cancelBefore);
  await page.close();
}

// =====================================================================
// 10) 한글 발음(kr)이 가나 읽기(reading)와 서로 다른 별도 필드로 실제로
//     화면에 보임 — 예전 주석·구현 불일치(reading이 가나인데 "한글로
//     변환"이라고 주석에 적혀 있던 문제)의 재현 차단.
// =====================================================================
{
  const { page } = await newPage('full');
  await page.evaluate(() => phrasebookSheet());
  await page.waitForTimeout(150);
  const rows = await page.evaluate(() => Array.from(document.querySelectorAll('.phrase-row')).map((el) => ({
    reading: el.querySelector('.phrase-reading').textContent,
    kr: el.querySelector('.phrase-kr') ? el.querySelector('.phrase-kr').textContent : null,
  })));
  t('10) 모든 항목에 한글 발음(.phrase-kr) 요소가 실제로 존재함', rows.every((r) => r.kr !== null));
  t('10) 한글 발음이 비어있지 않음', rows.every((r) => r.kr.trim().length > 0));
  t('10) 한글 발음이 가나 읽기와 서로 다른 값임(같은 필드 재사용 아님)', rows.every((r) => r.kr !== r.reading));
  // 가나(히라가나/가타카나) 문자가 한글 발음 칸에는 안 섞여 있어야
  // 진짜로 한글로 옮겨진 것이다.
  t('10) 한글 발음 칸에 가나 문자가 섞여 있지 않음', rows.every((r) => !/[぀-ヿ]/.test(r.kr)));
  await page.close();
}

// =====================================================================
// 11) 🔍 크게 보기 — 확대 오버레이가 뜨고 닫으면 사라짐.
// =====================================================================
{
  const { page } = await newPage('full');
  await page.evaluate(() => phrasebookSheet());
  await page.waitForTimeout(150);
  await page.click('[data-large="order-1"]');
  await page.waitForTimeout(50);
  const overlayShown = await page.evaluate(() => {
    const el = document.getElementById('phraseLargeOverlay');
    return !!el && !el.hidden && el.textContent.includes('이거 주세요');
  });
  t('11) 크게 보기를 누르면 오버레이에 그 문장이 크게 뜸', overlayShown);
  await page.evaluate(() => document.querySelector('#phraseLargeOverlay [data-large-close]').click());
  await page.waitForTimeout(50);
  const overlayHidden = await page.evaluate(() => document.getElementById('phraseLargeOverlay').hidden === true);
  t('11) 닫으면 오버레이가 실제로 사라짐', overlayHidden);
  await page.close();
}

// =====================================================================
// 12) 도시명이 목록에 없어도 country가 "일본"이면 여행 도구에 노출됨
//     (국가 정보 우선). 일본 목적지가 전혀 없으면 도구가 안 보임.
// =====================================================================
{
  const { page } = await newPage('full');
  await page.evaluate(() => {
    foodMap.places = [{ id: 'unk1', name: '이름모를도시가게', cat: '맛집·식당', catConfirmed: true, city: '나가사키', cityKnown: true, cityConfirmed: true, sourceLists: [], tags: [] }];
    A.saveFoodMap(foodMap);
  });
  await page.reload();
  await page.waitForTimeout(200);
  await page.evaluate(() => { cities[0].country = '일본'; }); // 도시명(나가사키)은 JP_CITIES 목록에 없지만 country로 판정돼야 한다.
  await page.evaluate(() => profile());
  await page.waitForTimeout(150);
  await page.click('[data-tools-open]');
  await page.waitForTimeout(150);
  const shownByCountry = await page.evaluate(() => !!document.querySelector('[data-tool="jp-phrasebook"]'));
  t('12) 도시명이 목록에 없어도 country="일본"이면 도구가 노출됨', shownByCountry);
  await page.evaluate(() => { const c = document.getElementById('close'); if (c) c.click(); });

  await page.evaluate(() => { cities[0].country = '베트남'; });
  await page.evaluate(() => profile());
  await page.waitForTimeout(150);
  await page.click('[data-tools-open]');
  await page.waitForTimeout(150);
  const hiddenWhenNotJapan = await page.evaluate(() => !document.querySelector('[data-tool="jp-phrasebook"]'));
  t('12) 일본 목적지가 전혀 없으면 도구가 안 보임', hiddenWhenNotJapan);
  await page.close();
}

console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
await b.close();
process.exit(fail ? 1 : 0);
