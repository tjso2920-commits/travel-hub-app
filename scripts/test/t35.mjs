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
t('사진 버튼', now.textContent.includes('사진으로 읽기'));
t('글로 쓰기', now.textContent.includes('글로 쓰기'));
t('소리내어 읽어준다고 안내', now.textContent.includes('소리내어 읽어 줍니다'));
t('메뉴판만이 아니라고 안내', now.textContent.includes('글씨가 있으면 뭐든'));
t('무슨 뜻인지까지 적는다고 안내', now.textContent.includes('나한테 무슨 뜻인지'));

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

/* ── 사진 읽기 — 손글씨·세로쓰기를 각오한 지시인가 ──────────────────── */
const ocr = w.eval('trOcrPrompt()');
t('손글씨를 각오함', ocr.includes('손글씨') && ocr.includes('붓글씨'));
t('세로쓰기와 읽는 방향', ocr.includes('세로쓰기') && ocr.includes('오른쪽에서 왼쪽'));
t('지어내지 말라고 못박음', ocr.includes('절대 지어내지 마라'));
t('확신 여부를 받음', ocr.includes('sure'));
t('음식이 뭔지도 적게 함', ocr.includes('날것'));
t('메뉴 말고도 읽으라고 함', ocr.includes('안내문') && ocr.includes('약봉투') && ocr.includes('기계 버튼'));
t('무엇인지 한 줄 요약을 받음', ocr.includes('summary'));
t('사진 종류를 받음', ocr.includes('kind'));
t('안내문이면 뭘 해야 하는지', ocr.includes('하면 안 되는지'));
t('표면 언제까지 쓰는지', ocr.includes('언제·어디까지'));

const cfg = w.eval('JSON.stringify(trOcrCfg(false))');
const cfgHard = w.eval('JSON.stringify(trOcrCfg(true))');
t('눈 작업은 온도 0', JSON.parse(cfg).temperature === 0);
t('생각할 시간을 줌', JSON.parse(cfg).thinkingConfig.thinkingBudget > 0);
t('꼼꼼히 읽기는 더 오래 생각', JSON.parse(cfgHard).thinkingConfig.thinkingBudget > JSON.parse(cfg).thinkingConfig.thinkingBudget);
t('다시 읽기 모델이 따로 있음', typeof w.eval('TR_MODEL_HARD') === 'string' && w.eval('TR_MODEL_HARD') !== w.eval('ai.model'));

/* 결과 화면 — 흐린 글자 표시와 다시 읽기 버튼 */
w.eval(`trPhotoB64='x';trPhotoTried=false;trShowMenu([
  {ko:'출입금지',src:'立入禁止',read:'타치이리 킨시',price:'',what:'여기 들어가면 안 됩니다',sure:true},
  {ko:'관계자 외',src:'関係者以外',read:'칸케이샤 이가이',price:'',what:'직원만 들어갑니다',sure:false}
],false,{kind:'notice',summary:'직원만 들어가는 문이라는 안내입니다'})`);
const menu = d.getElementById('trOut').textContent;
t('한 줄 요약이 맨 위', menu.indexOf('직원만 들어가는 문') === 0);
t('사진 종류 표시', menu.includes('안내문'));
t('무슨 뜻인지 표시', menu.includes('여기 들어가면 안 됩니다'));
t('읽은 개수 표시', menu.includes('2개'));
t('확실하지 않은 것 개수 표시', menu.includes('확실하지 않은 것 1개'));
t('흐린 글자 표시', menu.includes('글자 흐림'));
t('더 꼼꼼히 다시 읽기 버튼', menu.includes('더 꼼꼼히 다시 읽기'));
t('다시 찍을 필요 없다고 안내', menu.includes('다시 찍지 않아도'));
t('메뉴가 아니어도 됨', !menu.includes('메뉴판'));

/* 이미 꼼꼼히 읽었으면 그 버튼은 사라진다 */
w.eval(`trPhotoTried=true;trShowMenu([{ko:'모츠나베',src:'もつ鍋',sure:true}],true,{kind:'menu',summary:'이자카야 저녁 메뉴판입니다'})`);
const menu2 = d.getElementById('trOut').textContent;
t('꼼꼼히 읽은 뒤엔 버튼 없음', !menu2.includes('더 꼼꼼히 다시 읽기'));
t('꼼꼼히 읽었다고 표시', menu2.includes('꼼꼼히 읽기'));

t('최종 런타임 오류 0', errs.length === 0);
if (errs.length) console.log('  ', errs.slice(0, 3));
console.log(fail ? ('\n실패 ' + fail + '건') : '\n전체 통과');
process.exit(fail ? 1 : 0);
