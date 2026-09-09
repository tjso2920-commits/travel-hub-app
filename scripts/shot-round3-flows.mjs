/**
 * docs/DESIGN_INTEGRATION_REPORT.md 3차 갱신용 비교 스크린샷 — 지어낸
 * 데이터만 쓴다(실제 장소명 없음). 이번 라운드에 새로 붙인 화면 3장:
 *  1) 실제 코스 생성 결과(도보 실제 경로 vs 직선거리 추정 구분 표시)
 *  2) ZIP 가져오기 결과(파일별 성공/실패/제외 이유)
 *  3) 위치 확인 필요(축약 링크) 안내
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shot3-'));
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage({ viewport: { width: 390, height: 844 } });
p.on('dialog', (d) => d.dismiss());

await p.goto('file://' + process.cwd() + '/src/design/index.html');
await p.waitForTimeout(300);

// 1) 코스 생성 결과 — OSRM 응답을 흉내 내 실제 경로 성공 케이스를 찍는다
await p.route('https://router.project-osrm.org/**', (route) => {
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      code: 'Ok',
      trips: [{ distance: 2100, duration: 1500, legs: [{ distance: 700, duration: 500 }, { distance: 1400, duration: 1000 }] }],
      waypoints: [{ waypoint_index: 0 }, { waypoint_index: 2 }, { waypoint_index: 1 }],
    }),
  });
});
await p.evaluate(() => {
  foodMap.lic = { name: 'q', date: '2026-01-01' };
  foodMap.places = [
    { id: 'c1', name: '아침 커피집', lat: 33.590, lng: 130.400, cat: '카페·디저트', catConfirmed: true, sourceLists: [] },
    { id: 'c2', name: '점심 라멘집', lat: 33.591, lng: 130.402, cat: '맛집·식당', catConfirmed: true, sourceLists: [] },
    { id: 'c3', name: '오후 전망대', lat: 33.593, lng: 130.405, cat: '관광·명소', catConfirmed: true, sourceLists: [] },
    { id: 'c4', name: '좌표 확인 필요한 곳', lat: null, lng: null, cat: '기타', sourceLists: [] },
  ];
  delete foodMap.course;
  A.saveFoodMap(foodMap);
});
await p.reload();
await p.waitForTimeout(300);
await p.evaluate(() => { ['c1', 'c2', 'c3', 'c4'].forEach((id) => route.add(id)); showRoute(); });
await p.waitForTimeout(200);
await p.click('[data-build-course]');
await p.waitForTimeout(200);
await p.click('[data-start-pick="c1"]');
await p.waitForTimeout(800);
await p.screenshot({ path: 'docs/screenshots/after_실제코스생성.png' });
await p.evaluate(() => document.getElementById('close').click());
await p.waitForTimeout(200);
await p.unroute('https://router.project-osrm.org/**');

// 2) ZIP 가져오기 결과
const { execFileSync } = await import('node:child_process');
const zipRoot = path.join(tmp, 'src');
fs.mkdirSync(path.join(zipRoot, 'Takeout/Saved'), { recursive: true });
fs.mkdirSync(path.join(zipRoot, 'Takeout/지도(내 장소)'), { recursive: true });
fs.writeFileSync(path.join(zipRoot, 'Takeout/Saved/기본 목록.csv'), '제목,메모,URL,태그,댓글\n골목 라멘집,,,,\n동네 카페,,,,\n');
fs.writeFileSync(path.join(zipRoot, 'Takeout/Saved/가고 싶은 장소.csv'), '제목,메모,URL,태그,댓글\n산책로 공원,,,,\n');
fs.writeFileSync(path.join(zipRoot, 'Takeout/지도(내 장소)/저장한 장소.json'), JSON.stringify({ type: 'FeatureCollection', features: [{ properties: { location: { name: '별표 이자카야', address: '서울 마포구' } }, geometry: { type: 'Point', coordinates: [126.9, 37.5] } }] }));
fs.writeFileSync(path.join(zipRoot, 'Takeout/지도(내 장소)/리뷰.json'), JSON.stringify({ type: 'FeatureCollection', features: [{ properties: { five_star_rating_published: 5, location: { name: '리뷰만 남긴 곳' } } }] }));
const zipPath = path.join(tmp, 'demo.zip');
execFileSync('python3', ['-c', `
import zipfile, os
root = ${JSON.stringify(zipRoot)}
with zipfile.ZipFile(${JSON.stringify(zipPath)}, 'w', zipfile.ZIP_DEFLATED) as z:
    for base, _, files in os.walk(root):
        for f in files:
            full = os.path.join(base, f)
            z.write(full, os.path.relpath(full, root))
`]);
await p.evaluate(() => {
  foodMap.places = [];
  delete foodMap.course;
  A.saveFoodMap(foodMap);
});
await p.reload();
await p.waitForTimeout(300);
await p.click('[data-add]');
const [fc] = await Promise.all([p.waitForEvent('filechooser'), p.click('#realFileBtn')]);
await fc.setFiles(zipPath);
await p.waitForTimeout(1200);
await p.screenshot({ path: 'docs/screenshots/after_ZIP가져오기결과.png' });
await p.evaluate(() => document.getElementById('close').click());
await p.waitForTimeout(200);

// 3) 위치 확인 필요(축약 링크) 안내
await p.evaluate(() => {
  foodMap.places.push({ id: 'lk1', name: '축약 링크로 저장한 가게', url: 'https://goo.gl/maps/abcXYZ123', lat: null, lng: null, cat: '기타', sourceLists: [] });
  A.saveFoodMap(foodMap);
});
await p.reload();
await p.waitForTimeout(300);
const lookupId = await p.evaluate(() => {
  const d = foodMap.places.find((x) => x.name === '축약 링크로 저장한 가게');
  return d ? d.id : null;
});
await p.evaluate((id) => { detail(id); }, lookupId);
await p.waitForTimeout(200);
await p.evaluate(() => { document.getElementById('sheet')?.scrollTo(0, 999); });
await p.waitForTimeout(150);
await p.screenshot({ path: 'docs/screenshots/after_위치확인필요.png' });

await b.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('스크린샷 3장 저장 완료 (지어낸 데이터만 사용)');
