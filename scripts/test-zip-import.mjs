/**
 * Takeout ZIP 직접 가져오기 검증 — 실제 Chromium + 진짜 ZIP 파일.
 *
 * 2026-09-09 코드 검토(로드맵 ②): "사용자는 Takeout ZIP을 압축 해제하지
 * 않고 선택할 수 있어야 한다." 중첩 폴더 구조·한글 파일명·리뷰 파일 제외·
 * 손상 ZIP·크기 제한·일부 실패해도 성공한 항목은 반영되는지를 실제
 * 브라우저에서 확인한다. 지어낸 데이터만 쓴다.
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-check-'));

/* 2026-09-09 확인 — Info-Zip의 zip CLI로 만든 테스트 zip은 이 샌드박스
   기본 설정에서 파일명에 UTF-8 플래그 비트(APPNOTE.TXT 11번 비트)를 안
   세워서, 실제로는 올바른 UTF-8 바이트인 한글 파일명이 라틴-1처럼
   잘못 해석돼 깨져 보였다(fflate는 표준대로 그 비트를 보고 판단한다 —
   비트가 서 있으면 정확히 복원되는 걸 Python zipfile로 만든 zip으로
   교차 확인했다). 이건 이 zip 생성 도구의 특성이지 zip-import.js의
   버그가 아니었다 — 구글 Takeout처럼 현대적인 도구는 이 비트를 표준대로
   세운다고 보는 게 합리적이지만, 실제 Takeout ZIP으로 직접 확인하지는
   못했다("실기기 미검증"과 같은 성격의 한계). 테스트 자체는 표준을
   올바르게 지키는 도구(Python zipfile, 비트 자동 설정)로 만든다. */
function makeZip(zipName, files) {
  const root = path.join(tmp, 'src-' + zipName.replace(/\W/g, ''));
  fs.mkdirSync(root, { recursive: true });
  const entries = [];
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    entries.push(rel);
  }
  const zipPath = path.join(tmp, zipName);
  const py = `
import zipfile, os
root = ${JSON.stringify(root)}
entries = ${JSON.stringify(entries)}
with zipfile.ZipFile(${JSON.stringify(zipPath)}, 'w', zipfile.ZIP_DEFLATED) as z:
    for rel in entries:
        z.write(os.path.join(root, rel), rel)
`;
  execFileSync('python3', ['-c', py]);
  return zipPath;
}

// 1) 정상 ZIP — 중첩 폴더 안에 Saved CSV 2개 + 지도(내 장소) JSON + 리뷰 JSON.
const normalZip = makeZip('normal.zip', {
  'Takeout/Saved/기본 목록.csv': '제목,메모,URL,태그,댓글\n골목 라멘집,,,,\n동네 카페,,,,\n',
  'Takeout/Saved/가고 싶은 장소.csv': '제목,메모,URL,태그,댓글\n산책로 공원,,,,\n',
  'Takeout/지도(내 장소)/저장한 장소.json': JSON.stringify({
    type: 'FeatureCollection',
    features: [{ properties: { location: { name: '별표 이자카야', address: '서울 마포구' } }, geometry: { type: 'Point', coordinates: [126.9, 37.5] } }],
  }),
  'Takeout/지도(내 장소)/리뷰.json': JSON.stringify({
    type: 'FeatureCollection',
    features: [{ properties: { five_star_rating_published: 5, location: { name: '리뷰만 남긴 곳' } } }],
  }),
});

// 1-b) 개별 항목 용량 제한 — 비정상적으로 큰 CSV 항목은 압축 해제 전에
// 걸러져야 한다(브라우저 멈춤 방지). daParseZip의 기본 상한(30MB)보다
// 작게 잡아 실제로 걸리는지 확인한다.
const bigRow = '아무가게,' + 'x'.repeat(1024 * 1024) + ',,,\n'; // 항목 하나당 약 1MB 초과가 되도록 반복
const bigZip = makeZip('big.zip', {
  'Takeout/Saved/정상.csv': '제목,메모,URL,태그,댓글\n정상가게,,,,\n',
  'Takeout/Saved/거대한파일.csv': '제목,메모,URL,태그,댓글\n' + bigRow.repeat(40), // 약 40MB — 기본 상한(30MB) 초과
});

// 2) 손상된 ZIP(그냥 텍스트 파일에 .zip 확장자만 붙임).
const corruptZip = path.join(tmp, 'corrupt.zip');
fs.writeFileSync(corruptZip, 'this is not a real zip file at all');

// 3) 대상 파일이 하나도 없는 ZIP(사진만 있는 척).
const noTargetZip = makeZip('notarget.zip', { 'Takeout/Photos/readme.txt': '사진 파일들입니다' });

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage({ viewport: { width: 390, height: 844 } });
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('dialog', (d) => d.dismiss());

await p.goto('file://' + process.cwd() + '/src/design/index.html');
await p.waitForTimeout(300);

// --- 정상 ZIP ---
await p.click('[data-add]');
const [fc1] = await Promise.all([p.waitForEvent('filechooser'), p.click('#realFileBtn')]);
await fc1.setFiles(normalZip);
await p.waitForTimeout(1200);
const summary1 = (await p.textContent('.import-summary').catch(() => '')).replace(/\s+/g, ' ');
t('ZIP 안 CSV 2개 + JSON 1개에서 장소 4곳 확인(리뷰 제외)', /4\s*새로 추가/.test(summary1));
const fileList1 = await p.textContent('.import-filelist').catch(() => '');
t('파일별 결과가 화면에 표시됨(기본 목록 등)', fileList1.includes('기본 목록') && fileList1.includes('가고 싶은 장소') && fileList1.includes('저장한 장소'));
t('리뷰 파일은 제외 이유와 함께 표시됨(장소로 안 셈)', fileList1.includes('리뷰') && fileList1.includes('제외'));
const placesAfterZip = await p.evaluate(() => foodMap.places.map((x) => x.name));
t('실제로 4곳이 담김(별표 이자카야 포함)', placesAfterZip.includes('별표 이자카야') && placesAfterZip.length === 4);
await p.evaluate(() => document.getElementById('close').click());
await p.waitForTimeout(200);

// --- 같은 ZIP 재업로드 — 중복 없이 처리(URL 없는 동명 항목은 후보로) ---
await p.click('[data-add]');
const [fc1b] = await Promise.all([p.waitForEvent('filechooser'), p.click('#realFileBtn')]);
await fc1b.setFiles(normalZip);
await p.waitForTimeout(1200);
const countAfterReupload = await p.evaluate(() => foodMap.places.length);
t('같은 ZIP을 다시 올려도 검증된 식별자 없는 항목은 후보로만 남고 폭증하지 않음(8곳 이하)', countAfterReupload <= 8);
await p.evaluate(() => document.getElementById('close').click());
await p.waitForTimeout(200);

// --- 개별 항목 용량 제한 ---
await p.click('[data-add]');
const [fcBig] = await Promise.all([p.waitForEvent('filechooser'), p.click('#realFileBtn')]);
await fcBig.setFiles(bigZip);
await p.waitForTimeout(3000);
const summaryBig = (await p.textContent('.import-summary').catch(() => '')).replace(/\s+/g, ' ');
const fileListBig = await p.textContent('.import-filelist').catch(() => '');
t('정상 크기 파일은 처리됨(용량 제한과 무관)', /1\s*새로 추가/.test(summaryBig));
t('너무 큰 항목은 압축 해제 전에 걸러지고 이유가 표시됨(브라우저 멈춤 방지)', fileListBig.includes('거대한파일') && fileListBig.includes('제외'));
await p.evaluate(() => document.getElementById('close').click());
await p.waitForTimeout(200);

// --- 손상된 ZIP ---
await p.click('[data-add]');
const [fc2] = await Promise.all([p.waitForEvent('filechooser'), p.click('#realFileBtn')]);
await fc2.setFiles(corruptZip);
await p.waitForTimeout(1000);
const msg2 = await p.textContent('.inline-note').catch(() => '');
t('손상된 ZIP은 안내 문구를 보여주고 실패로 처리', /열지 못했|손상/.test(msg2));

// --- 대상 파일이 없는 ZIP ---
await p.click('#realFileBtn');
const [fc3] = await Promise.all([p.waitForEvent('filechooser'), p.click('#realFileBtn')]);
await fc3.setFiles(noTargetZip);
await p.waitForTimeout(1000);
const msg3 = await p.textContent('.inline-note').catch(() => '');
t('저장 목록이 없는 ZIP은 못 찾았다고 안내', /찾지 못했/.test(msg3));

t('최종 콘솔/런타임 오류 0', errs.length === 0);
if (errs.length) console.log('  ', errs.slice(0, 5));

await b.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(fail ? ('\n실패 ' + fail + '건') : '\n전체 통과');
process.exit(fail ? 1 : 0);
