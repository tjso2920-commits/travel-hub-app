/**
 * 통역 검사.
 *
 * 가게 앞에서 쓰는 기능이라 **찾을 수 있어야** 하고, **목적지 말을 따라가야** 한다.
 * 옛 도구는 일본어로 박혀 있었다. 그게 다시 새어나오는지 본다.
 *
 * 실제 번역 품질은 여기서 못 본다(바깥 서버에 못 붙는다).
 * 여기서 보는 것은 화면·언어 연결·마이크 없는 기기에서 안 죽는지다.
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs';
const file = process.argv[2] || 'private/personal.html';
const html = fs.readFileSync(file, 'utf8');
const errs = []; const vc = new VirtualConsole();
/* showTab 안의 window.scrollTo 는 검사 환경에만 없는 것이다. 앱 문제가 아니다. */
vc.on('jsdomError', (e) => { if (!/scrollTo|Not implemented/.test(e.message)) errs.push(e.message); });
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: 'https://local.test/' });
const w = dom.window; await new Promise((r) => setTimeout(r, 700));
let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };
const alerts = [];
w.alert = (m) => alerts.push(String(m)); w.confirm = () => true;
w.Element.prototype.scrollIntoView = function () {};
const d = w.document;

t('런타임 오류 0', errs.length === 0);

/* ── 현장 탭 맨 위에 있는가 ──────────────────────────────────────────── */
w.eval("affSetDest('후쿠오카');fmSetCountry('JP');renderFoodMap();");
const now = d.getElementById('fmNow');
t('통역 카드 존재', !!d.getElementById('trCard'));
t('현장 탭 맨 위', now.firstElementChild && now.firstElementChild.id === 'trCard');
t('말하기 버튼 둘', !!d.getElementById('trMicKo') && !!d.getElementById('trMicLo'));
t('사진 버튼', now.textContent.includes('메뉴판·간판 찍기'));
t('글로 쓰기', now.textContent.includes('글로 쓰기'));
t('소리내어 읽어준다고 안내', now.textContent.includes('소리내어 읽어 줍니다'));
t('인터넷이 필요하다고 밝힘', now.textContent.includes('인터넷이 있어야 합니다'));

/* ── 목적지 말을 따라가는가 ─────────────────────────────────────────── */
t('일본이면 일본어 통역', d.getElementById('trCard').textContent.includes('일본어 통역'));
t('음성 인식 언어 일본어', w.eval('trLangCode()') === 'ja-JP');

w.eval("affSetDest('방콕');fmSetCountry('TH');renderFoodMap();");
t('태국이면 태국어 통역', d.getElementById('trCard').textContent.includes('태국어 통역'));
t('음성 인식 언어 태국어', w.eval('trLangCode()') === 'th-TH');
t('버튼 글자도 태국어', d.getElementById('trMicLo').textContent.includes('태국어'));

w.eval("affSetDest('상하이');fmSetCountry('CN');renderFoodMap();");
t('중국이면 중국어 통역', d.getElementById('trCard').textContent.includes('중국어 통역'));
t('음성 인식 언어 중국어', w.eval('trLangCode()') === 'zh-CN');

/* ── 일본어가 새어나오지 않는가 ─────────────────────────────────────── */
const nowTxt = d.getElementById('fmNow').textContent;
t('현장 탭에 한↔일 고정 문구 없음', !nowTxt.includes('한↔일'));
/* 회화팩이 없는 나라에서는 도구 화면 자체가 안 나온다. 일본으로 돌려놓고 본다. */
w.eval("affSetDest('후쿠오카');fmSetCountry('JP');showTab('jp');jpSetMode('tools');renderJapanese();");
const tools = d.getElementById('jpRoot').textContent;
t('옛 통역 카드 제거됨', !tools.includes('빠른 통역'));
t('통역 위치를 알려줌', tools.includes('지금 여행'));
t('점원 역할 문구가 나라 중립', !tools.includes('일본인 점원'));

/* ── 글로 쓰기: 어느 쪽 말인지 글자로 가른다 ────────────────────────── */
w.eval("showTab('now');renderFoodMap();");
t('한글이면 현지어로 보냄', w.eval("/[가-힣]/.test('메뉴 주세요')") === true);
t('현지 글자면 한국어로 보냄', w.eval("/[가-힣]/.test('สวัสดี')") === false);

/* ── AI 안 켜져 있으면 조용히 알려주고 안 죽는다 ────────────────────── */
alerts.length = 0;
w.eval("ai.key='';");
await w.eval('trRun("메뉴 주세요","ko2lo")');
t('키 없으면 알려줌', alerts.some((m) => m.includes('AI를 켜야')));
t('키 없어도 안 죽음', errs.length === 0);

/* ── 마이크 없는 기기에서 안 죽는다 ─────────────────────────────────── */
alerts.length = 0;
w.eval('delete window.SpeechRecognition; delete window.webkitSpeechRecognition;');
w.eval("trSpeak2('ko')");
t('음성 못 쓰면 알려줌', alerts.some((m) => m.includes('음성 인식을 지원하지 않습니다')));
t('글로 쓰기를 대안으로 안내', alerts.some((m) => m.includes('글로 쓰기')));
t('음성 없어도 안 죽음', errs.length === 0);

/* 결과 화면이 다시 그려져도 안 깨진다 */
w.eval("trShow({src:'메뉴 주세요',out:'ขอเมนูหน่อยครับ',read:'커 메누 너이 캅',note:'',speakable:false},false)");
const out = d.getElementById('trOut').textContent;
t('결과에 원문 표시', out.includes('메뉴 주세요'));
t('결과에 번역 표시', out.includes('ขอเมนูหน่อยครับ'));
t('결과에 읽는 법 표시', out.includes('커 메누 너이 캅'));

t('최종 런타임 오류 0', errs.length === 0);
if (errs.length) console.log('  ', errs.slice(0, 3));
console.log(fail ? ('\n실패 ' + fail + '건') : '\n전체 통과');
process.exit(fail ? 1 : 0);
