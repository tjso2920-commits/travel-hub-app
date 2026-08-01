/**
 * 나라별 회화팩 검사.
 *
 * 제일 중요한 것은 **일본어가 그대로인지**다. 첫 손님은 후쿠오카 가는 사람들이고,
 * 다른 나라 대응을 넣다가 일본어 교재를 깨뜨리면 그게 진짜 사고다.
 *
 * 그다음이 다른 나라 — 팩이 없으면 만들라고 안내하는가, 만들면 같은 틀로 돌아가는가,
 * 외운 문장이 나라끼리 안 섞이는가.
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs';
const file = process.argv[2] || 'private/personal.html';
const html = fs.readFileSync(file, 'utf8');
const errs = []; const vc = new VirtualConsole();
vc.on('jsdomError', (e) => errs.push(e.message));
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: 'https://local.test/' });
const w = dom.window; await new Promise((r) => setTimeout(r, 700));
let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };
w.alert = () => {}; w.confirm = () => true; w.Element.prototype.scrollIntoView = function () {};
const d = w.document;

t('런타임 오류 0', errs.length === 0);

/* ── 일본은 하나도 안 바뀌어야 한다 ──────────────────────────────────── */
w.eval("affSetDest('후쿠오카');fmSetCountry('JP');renderJapanese();");
t('일본이면 일본어', w.eval('jpLang()') === 'ja' && w.eval('jpIsJa()') === true);
t('일본은 손으로 쓴 교재 13주차', w.eval('LW().length') === 13);
t('일본은 팩 만들 필요 없음', w.eval('jpHasPack()') === true);
t('탭 이름 일본어', d.getElementById('tabJp').textContent === '일본어');
t('문장 id 접두사 없음', w.eval("jpLineId(0,3)") === 'w0l3');
t('예전 id 그대로 찾아짐', w.eval("!!jpFindLine('w0l3')") === true);
const jaLine = w.eval("JSON.stringify(jpSession(0).lines[0].v)");
t('일본어 문장 6개', w.eval('jpSession(0).lines.length') === 6);
t('일본어 문장에 한자·가나', /[぀-ヿ一-龯]/.test(jaLine));
t('문법 카드 나옴', d.getElementById('jpRoot').textContent.includes('GRAMMAR'));

/* ── 다른 나라 — 팩이 없으면 만들라고 해야 한다 ──────────────────────── */
w.eval("affSetDest('방콕');fmSetCountry('TH');renderJapanese();");
t('태국이면 태국어', w.eval('jpLang()') === 'th');
t('탭 이름 태국어', d.getElementById('tabJp').textContent === '태국어');
t('아직 팩 없음', w.eval('jpHasPack()') === false);
const need = d.getElementById('jpRoot').textContent;
t('만들라고 안내', need.includes('회화팩 만들기'));
t('AI가 만든다고 정직하게 밝힘', need.includes('AI가 만듭니다'));
t('일본어도 감수 안 받았다고 밝힘', need.includes('원어민 감수는 받지 않았습니다'));
t('사람이 썼다는 거짓말 없음', !need.includes('사람이 직접 쓰'));
t('AI 꺼져 있으면 알려줌', need.includes('AI가 꺼져 있습니다'));
t('팩 없어도 오류 0', errs.length === 0);

/* 팩 없을 때 다른 모드로 가도 안 죽어야 한다 */
for (const m of ['review', 'audio', 'info', 'bed', 'tools']) {
  w.eval("jpSetMode('" + m + "')");
}
t('팩 없이 모드 전환해도 오류 0', errs.length === 0);
w.eval("jpSetMode('today')");

/* ── 팩을 넣으면 같은 틀로 돌아가야 한다 ─────────────────────────────── */
w.eval(`
  const weeks=[];
  for(let x=0;x<13;x++){
    const l=[];
    for(let i=0;i<8;i++)l.push({j:'สวัสดี'+x+i,k:'사왓디'+x+i,m:'안녕하세요'+x+i});
    weeks.push({t:'주차'+x,s:['가','나','다','라','마','바','사','아'],l:l});
  }
  jpLangPack()['th']={weeks:weeks,at:'2026-08-01',dest:'방콕',ai:true};
  save('jp_packs_v1',jpAIPacks);
  renderJapanese();
`);
t('팩 인식', w.eval('jpHasPack()') === true && w.eval('LW().length') === 13);
t('태국어 문장 6개', w.eval('jpSession(0).lines.length') === 6);
t('문장 id에 나라 접두사', w.eval("jpLineId(0,3)") === 'th:w0l3');
t('접두사 id로 찾아짐', w.eval("!!jpFindLine('th:w0l3')") === true);
t('일본어 id는 여전히 일본어를 가리킴', /[぀-ヿ一-龯]/.test(w.eval("JSON.stringify(jpFindLine('w0l3'))")));

const pane = d.getElementById('jpRoot').textContent;
t('태국어 화면에 문법 카드 없음', !pane.includes('GRAMMAR'));
t('태국어 화면에 N3 얘기 없음', !pane.includes('N3'));
t('AI가 만든 것이라고 표시', pane.includes('AI가 만든 회화팩'));
t('일본 전용 문구가 안 새어나옴', !pane.includes('하카타벤'));
t('음성도 목적지 말로', w.eval("JP_TTS_LANG[jpLang()]") === 'th-TH');
t('완료 버튼 있음', pane.includes('완료 → 다음 팩'));
t('어색한 문장 고치는 버튼', pane.includes('어색해요'));
t('사람이 본 적 없음을 밝힘', pane.includes('사람이 본 적은 없습니다'));
t('사람이 썼다고 주장하지 않음', !pane.includes('사람이 직접'));
t('말하는 사람 표시', pane.includes('말하는 사람'));

/* ── 품질 장치 ───────────────────────────────────────────────────────── */
t('성별 기본값 있음', ['m','f'].indexOf(w.eval('jpSpeaker()')) >= 0);
w.eval("jpSetSpeaker('f')");
t('성별 바뀜', w.eval('jpSpeaker()') === 'f' && w.eval('jpSpeakerTxt()') === '여성');
t('시키는 말에 성별이 들어감', w.eval('jpGenRules()').includes('여성'));
t('시키는 말이 번역투를 금지', w.eval('jpGenRules()').includes('번역투'));
t('시키는 말이 로마자 표기를 금지', w.eval('jpGenRules()').includes('로마자'));
w.eval("jpSetSpeaker('m')");

/* 쓰레기 문장은 걸러져야 한다 */
const cleaned = w.eval(`JSON.stringify(jpCleanLines([
  {j:'สวัสดีครับ',k:'사왓디 캅',m:'안녕하세요'},
  {j:'안녕하세요',k:'안녕',m:'한글이 섞임'},
  {j:'สวัสดีครับ',k:'사왓디 캅',m:'앞과 겹침'},
  {j:'',k:'',m:'빈 줄'},
  {j:'ก'.repeat(90),k:'긴문장',m:'너무 김'},
  {j:'ขอบคุณครับ',k:'컵쿤 캅',m:'감사합니다'}
]))`);
const arr = JSON.parse(cleaned);
t('걸러내고 2개만 남음', arr.length === 2);
t('한글 섞인 원문 제거', !arr.some((x) => /[가-힣]/.test(x.j)));
t('겹치는 문장 제거', new Set(arr.map((x) => x.j)).size === arr.length);
t('너무 긴 문장 제거', !arr.some((x) => x.j.length > 60));
t('다시 만들기 있음', pane.includes('회화팩 지우고 다시 만들기'));

/* 진도·복습이 같은 틀로 돌아가는가 */
const before = w.eval('jpState.pointer||0');
w.eval('jpCompleteSession()');
t('완료하면 진도 1 오름', w.eval('jpState.pointer') === before + 1);
t('외운 문장이 복습에 쌓임', Object.keys(w.eval('jpState.srs')).some((k) => k.indexOf('th:') === 0));
t('복습 목록이 태국어를 찾아냄', w.eval('jpDue().length') > 0);

/* 팩을 지우면 그 나라 복습만 사라져야 한다 */
w.eval("jpState.srs['w0l0']={box:0,due:'2026-01-01',seen:1};save('jp_state_v1',jpState);");
w.eval('jpDropPack()');
t('팩 지워짐', w.eval('jpHasPack()') === false);
t('그 나라 복습만 사라짐', !Object.keys(w.eval('jpState.srs')).some((k) => k.indexOf('th:') === 0));
t('일본어 복습은 남음', w.eval("!!jpState.srs['w0l0']") === true);

/* ── 나라를 되돌리면 일본어가 그대로 살아 있어야 한다 ────────────────── */
w.eval("affSetDest('후쿠오카');fmSetCountry('JP');renderJapanese();");
t('일본어 교재 복귀', w.eval('LW().length') === 13 && w.eval('jpIsJa()') === true);
t('탭 이름 복귀', d.getElementById('tabJp').textContent === '일본어');
t('일본어 문장 그대로', w.eval("JSON.stringify(jpSession(0).lines[0].v)") === jaLine);

t('최종 런타임 오류 0', errs.length === 0);
if (errs.length) console.log('  ', errs.slice(0, 3));
console.log(fail ? ('\n실패 ' + fail + '건') : '\n전체 통과');
process.exit(fail ? 1 : 0);
