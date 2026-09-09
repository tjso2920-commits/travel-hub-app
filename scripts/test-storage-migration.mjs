/**
 * cp1_ → cs1_ storage 이전 검증 — 실제 Chromium.
 *
 * 2026-09-09 코드 검토: sale-mode 메타 태그만 바꾼다고 데이터가 저절로
 * 옮겨지지 않는다(그냥 다른 storage 칸을 보기 시작할 뿐). daMigrateStorage()가
 * 실제로 cp1_ 데이터를 읽어 cs1_로 옮기고, 실패해도 원본을 지키는지 여기서
 * 실제 브라우저 localStorage로 확인한다.
 *
 * src/design/index.html 은 sale-mode=false 로 고정돼 있어(현재는 개발 중
 * 화면이라 아직 그렇다), sale-mode=true 버전은 이 검사가 임시 파일로만
 * 만든다 — 저장소에 커밋하지 않고 끝나면 지운다. 같은 디렉터리(src/design/)
 * 안에 둬야 import-adapter.js·spots.js 상대 경로가 그대로 풀린다.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const designDir = path.join(process.cwd(), 'src/design');
const saleHtmlPath = path.join(designDir, '_test-sale-mode.html');
const origHtml = fs.readFileSync(path.join(designDir, 'index.html'), 'utf8');
fs.writeFileSync(saleHtmlPath, origHtml.replace('content="false"', 'content="true"'), 'utf8');

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
try {
  const p = await b.newPage({ viewport: { width: 390, height: 844 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  /* daMigrateStorage()는 페이지 스크립트가 파싱되자마자(스크립트 최하단에서)
     바로 실행되므로, page.evaluate로 나중에 흉내낸 실패를 심으면 이미 늦는다
     — addInitScript로 매 이동(reload 포함)마다 스크립트 실행 전에 먼저
     심어 둔다. localStorage 자체에 켜고 끄는 플래그를 둬서 reload에도
     살아남게 한다(window 전역은 reload로 사라진다). */
  await p.addInitScript(() => {
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (localStorage.getItem('__test_force_fail__') === '1' && String(k).indexOf('cs1_') === 0 && k !== 'cs1_migrated_v1') {
        throw new Error('저장 공간 가득 참(테스트로 흉내)');
      }
      return orig.call(this, k, v);
    };
  });

  // 1) 개인용(cp1_) 화면에서 데이터를 만들어 둔다.
  await p.goto('file://' + designDir + '/index.html');
  await p.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('cp1_foodmap_v1', JSON.stringify({ dest: '후쿠오카', places: [{ id: 'x1', name: '테스트가게' }] }));
    localStorage.setItem('cp1_jp_state_v1', JSON.stringify({ lang: 'ja' }));
  });

  // 2) 같은 파일 origin(file://.../src/design/) 안에서 sale-mode=true 화면으로 이동.
  await p.goto('file://' + saleHtmlPath);
  await p.waitForTimeout(300);
  const sameOrigin = await p.evaluate(() => localStorage.getItem('cp1_foodmap_v1') !== null);
  if (!sameOrigin) {
    console.log('건너뜀: 이 Chromium 설정에서 file:// 문서끼리 storage를 공유하지 않음(브라우저별 차이) — 실제 배포(https://)에서는 같은 origin이라 공유된다.');
  } else {
    const migrated = await p.evaluate(() => ({
      cs1: localStorage.getItem('cs1_foodmap_v1'),
      cs1State: localStorage.getItem('cs1_jp_state_v1'),
      cp1Still: localStorage.getItem('cp1_foodmap_v1'),
      flag: localStorage.getItem('cs1_migrated_v1'),
    }));
    t('sale-mode 진입 시 cp1_ 데이터가 cs1_로 실제로 옮겨짐', migrated.cs1 && JSON.parse(migrated.cs1).dest === '후쿠오카');
    t('foodmap_v1 말고 다른 cp1_ 키도 같이 옮겨짐', migrated.cs1State && JSON.parse(migrated.cs1State).lang === 'ja');
    t('원본 cp1_ 데이터는 지우지 않고 그대로 둠(복구 가능하게)', migrated.cp1Still && JSON.parse(migrated.cp1Still).dest === '후쿠오카');
    t('이전 완료 표시가 남음(매번 다시 스캔 안 하게)', migrated.flag === '1');

    // 3) 이미 옮겨진 뒤 cp1_에 새 값이 생겨도 다시 안 덮어씀(사용자가 판매용에서
    //    이미 뭔가 저장했으면 그걸 우선한다).
    await p.evaluate(() => {
      localStorage.setItem('cs1_foodmap_v1', JSON.stringify({ dest: '이미 판매용에서 저장한 값', places: [] }));
      localStorage.removeItem('cs1_migrated_v1');
      localStorage.setItem('cp1_foodmap_v1', JSON.stringify({ dest: '다른 값', places: [] }));
    });
    await p.reload();
    await p.waitForTimeout(300);
    const second = await p.evaluate(() => JSON.parse(localStorage.getItem('cs1_foodmap_v1')).dest);
    t('cs1_ 쪽에 이미 값이 있으면 안 덮어씀', second === '이미 판매용에서 저장한 값');

    // 4) 저장 실패 시 이번에 새로 쓴 cs1_ 키만 되돌리고, cp1_ 원본은 안 건드림.
    await p.evaluate(() => {
      localStorage.clear();
      localStorage.setItem('cp1_foodmap_v1', JSON.stringify({ dest: '실패 테스트', places: [] }));
      localStorage.setItem('__test_force_fail__', '1');
    });
    await p.reload();
    await p.waitForTimeout(300);
    const afterFail = await p.evaluate(() => ({
      cp1: localStorage.getItem('cp1_foodmap_v1'),
      cs1: localStorage.getItem('cs1_foodmap_v1'),
      flag: localStorage.getItem('cs1_migrated_v1'),
    }));
    t('이전 실패 시 cp1_ 원본은 그대로 남음', afterFail.cp1 && JSON.parse(afterFail.cp1).dest === '실패 테스트');
    t('이전 실패 시 cs1_에는 반쯤 쓰인 값이 안 남음', !afterFail.cs1);
    t('이전 실패 시 완료 표시를 안 남겨서 다음에 다시 시도 가능', !afterFail.flag);
  }

  t('최종 콘솔/런타임 오류 0', errs.length === 0);
  if (errs.length) console.log('  ', errs.slice(0, 5));
} finally {
  await b.close();
  fs.rmSync(saleHtmlPath, { force: true });
}

console.log(fail ? ('\n실패 ' + fail + '건') : '\n전체 통과');
process.exit(fail ? 1 : 0);
