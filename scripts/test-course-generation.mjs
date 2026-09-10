/**
 * 실제 코스 생성 검증 — 실제 Chromium.
 *
 * 2026-09-09 코드 검토(로드맵 ⑥): "직선거리 정렬을 실제 최단 동선으로
 * 표시하지 마세요. 도보 우선 실제 경로부터 완성하고, 다른 수단은 연결된
 * 범위만 제공하세요. 좌표 없는 장소를 조용히 빼지 마세요. 저장 코스는
 * 새로고침 후에도 유지돼야 합니다."
 *
 * 이 샌드박스는 외부 네트워크(router.project-osrm.org)가 조직 정책으로
 * 막혀 있어 실제 공개 서버 연결 자체는 여기서 확인할 수 없다(진짜 최종
 * 사용자 브라우저는 이 샌드박스 프록시를 거치지 않는다 — 별도 한계로
 * 남긴다). 대신 page.route()로 그 서버 응답을 실제 모양대로 흉내 내
 * (1) 실제 경로가 성공하는 경우 (2) 실패해서 직선거리 추정으로 정직하게
 * 넘어가는 경우 둘 다 실제 코드 경로로 검증한다.
 */
import { chromium } from 'playwright';

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage({ viewport: { width: 390, height: 844 } });
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
p.on('dialog', (d) => d.dismiss());

async function seedPlaces(withRealRoute) {
  await p.unroute('https://router.project-osrm.org/**').catch(() => {});
  if (withRealRoute) {
    await p.route('https://router.project-osrm.org/**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        /* 2026-09-09 코드 검토(2차): OSRM Trip 서비스는 roundtrip=false에
           destination을 안 주는(기본값 any) 조합이 공식적으로 지원되지
           않는다(project-osrm.org 문서 참고) — course.js를 공식 지원
           조합인 roundtrip=true&source=first로 고쳤다. roundtrip=true는
           출발지로 돌아오는 마지막 구간까지 포함해 legs를 돌려주므로
           (입력 좌표 3개 = origin+c2+c3 → legs 3개: origin→p1, p1→p2,
           p2→origin) 모의 응답도 실제 모양대로 닫힌 구간을 포함한다.
           course.js가 이 마지막 구간을 잘라내고 쓴다. */
        body: JSON.stringify({
          code: 'Ok',
          trips: [{ distance: 2700, duration: 2160, legs: [{ distance: 500, duration: 400 }, { distance: 1000, duration: 800 }, { distance: 1200, duration: 960 }] }],
          waypoints: [{ waypoint_index: 0 }, { waypoint_index: 2 }, { waypoint_index: 1 }],
        }),
      });
    });
  } else {
    await p.route('https://router.project-osrm.org/**', (route) => route.abort('failed'));
  }
  await p.evaluate(() => {
    foodMap.lic = { name: 'q', date: '2026-01-01' };
    foodMap.places = [
      { id: 'c1', name: '커피집', lat: 33.590, lng: 130.400, cat: '카페·디저트', catConfirmed: true, sourceLists: [] },
      { id: 'c2', name: '라멘집', lat: 33.591, lng: 130.402, cat: '맛집·식당', catConfirmed: true, sourceLists: [] },
      { id: 'c3', name: '전망대', lat: 33.593, lng: 130.405, cat: '관광·명소', catConfirmed: true, sourceLists: [] },
      { id: 'c4', name: '좌표없는가게', lat: null, lng: null, cat: '기타', sourceLists: [] },
    ];
    delete foodMap.course;
    delete foodMap.courses; // 2026-09-10(멀티데이): 저장된 날짜 목록도 같이 초기화해야
    // showRoute()가 이전 시나리오의 코스를 이 도시 것으로 찾아내 "동선
    // 선택" 화면 대신 "저장된 코스" 화면으로 건너뛰지 않는다.
    A.saveFoodMap(foodMap);
  });
}

await p.goto('file://' + process.cwd() + '/src/design/index.html');
await p.waitForTimeout(300);

// --- 실제 경로 성공 케이스 ---
await seedPlaces(true);
await p.reload();
await p.waitForTimeout(300);
await p.evaluate(() => { ['c1', 'c2', 'c3', 'c4'].forEach((id) => route.add(id)); });
await p.evaluate(() => showRoute());
await p.waitForTimeout(200);
await p.click('[data-build-course]');
await p.waitForTimeout(200);
await p.click('[data-start-pick="c1"]');
await p.waitForTimeout(800);
const detailReal = await p.textContent('#sheetContent');
t('실제 경로 성공 시 "실제 도보 경로 기준"으로 정직하게 표시', detailReal.includes('실제 도보 경로 기준'));
t('직선거리 추정이라고 잘못 표시하지 않음', !detailReal.includes('직선거리 기준으로 추정'));
t('좌표 없는 곳은 조용히 안 빠지고 이유와 함께 보여짐', detailReal.includes('좌표없는가게') && detailReal.includes('빠진 곳'));
const savedCourse1 = await p.evaluate(() => foodMap.course);
t('routedReal=true로 저장됨', savedCourse1.routedReal === true);
t('출발지로 고른 곳은 코스의 정거장 목록에서 빠짐(출발지 자체는 목적지가 아님)', !savedCourse1.stops.some((s) => s.id === 'c1'));
t('좌표 있는 나머지 2곳은 정거장으로 들어감', savedCourse1.stops.length === 2);
await p.evaluate(() => document.getElementById('close').click());
await p.waitForTimeout(150);

// --- 새로고침해도 코스가 유지되는지 ---
await p.reload();
await p.waitForTimeout(300);
await p.evaluate(() => showRoute());
await p.waitForTimeout(150);
const afterReload = await p.textContent('#sheetContent');
t('새로고침 후에도 저장된 코스가 다시 보임(재생성 안 해도 됨)', afterReload.includes('실제 도보 경로 기준'));
await p.evaluate(() => document.getElementById('close').click());
await p.waitForTimeout(150);
await p.unroute('https://router.project-osrm.org/**');

// --- 실제 경로 연결 실패 → 직선거리 추정으로 정직하게 전환 ---
await seedPlaces(false);
await p.reload();
await p.waitForTimeout(300);
await p.evaluate(() => { ['c1', 'c2', 'c3'].forEach((id) => route.add(id)); });
await p.evaluate(() => showRoute());
await p.waitForTimeout(200);
await p.click('[data-build-course]');
await p.waitForTimeout(200);
await p.click('[data-start-pick="c1"]');
await p.waitForTimeout(9000);
const detailFallback = await p.textContent('#sheetContent');
t('실제 경로 연결 실패 시 직선거리 추정이라고 정직하게 표시', detailFallback.includes('직선거리 기준으로 추정'));
const savedCourse2 = await p.evaluate(() => foodMap.course);
t('routedReal=false로 저장됨(성공한 척 안 함)', savedCourse2.routedReal === false);
t('실패해도 방문 순서 자체는 만들어짐(원래 순서 그대로 방치 안 함)', savedCourse2.stops.length === 2);
await p.evaluate(() => document.getElementById('close').click());

// --- 현재 위치(GPS)를 출발지로 쓰는 경로도 확인 ---
await p.context().grantPermissions(['geolocation']);
await p.context().setGeolocation({ latitude: 33.589, longitude: 130.399 });
await seedPlaces(true);
await p.reload();
await p.waitForTimeout(300);
await p.evaluate(() => { ['c1', 'c2'].forEach((id) => route.add(id)); });
await p.evaluate(() => showRoute());
await p.waitForTimeout(200);
await p.click('[data-build-course]');
await p.waitForTimeout(200);
await p.click('[data-start-gps]');
await p.waitForTimeout(1500);
const detailGps = await p.textContent('#sheetContent');
t('GPS 현재 위치를 출발지로 써도 코스가 만들어짐(API 키 없이 브라우저 위치 기능만 사용)', detailGps.includes('도보 이동'));
const savedCourseGps = await p.evaluate(() => foodMap.course);
t('GPS 출발일 때는 담아 둔 곳 전부가 정거장이 됨(출발지 자체가 목록에 없으므로)', savedCourseGps.stops.length === 2);
await p.evaluate(() => document.getElementById('close').click());

// --- 2026-09-09 코드 검토(2차): 속도 타당성 검사 — 도보라기엔 너무 빠른
// (자동차 프로필로 잘못 응답한 것으로 의심되는) 응답은 "실제 경로 성공"
// 으로 인정하지 않고 직선거리 추정으로 넘어가야 한다. ---
await p.unroute('https://router.project-osrm.org/**').catch(() => {});
await p.route('https://router.project-osrm.org/**', (route) => {
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    // 500m를 4초에(시속 450km) — 명백히 도보가 아니다.
    body: JSON.stringify({
      code: 'Ok',
      trips: [{ distance: 2700, duration: 12, legs: [{ distance: 500, duration: 4 }, { distance: 1000, duration: 8 }, { distance: 1200, duration: 9.6 }] }],
      waypoints: [{ waypoint_index: 0 }, { waypoint_index: 2 }, { waypoint_index: 1 }],
    }),
  });
});
await p.evaluate(() => {
  foodMap.lic = { name: 'q', date: '2026-01-01' };
  foodMap.places = [
    { id: 'c1', name: '커피집', lat: 33.590, lng: 130.400, cat: '카페·디저트', catConfirmed: true, sourceLists: [] },
    { id: 'c2', name: '라멘집', lat: 33.591, lng: 130.402, cat: '맛집·식당', catConfirmed: true, sourceLists: [] },
    { id: 'c3', name: '전망대', lat: 33.593, lng: 130.405, cat: '관광·명소', catConfirmed: true, sourceLists: [] },
  ];
  delete foodMap.course;
  delete foodMap.courses;
  A.saveFoodMap(foodMap);
});
await p.reload();
await p.waitForTimeout(300);
await p.evaluate(() => { ['c1', 'c2', 'c3'].forEach((id) => route.add(id)); });
await p.evaluate(() => showRoute());
await p.waitForTimeout(200);
await p.click('[data-build-course]');
await p.waitForTimeout(200);
await p.click('[data-start-pick="c1"]');
await p.waitForTimeout(800);
const detailImplausible = await p.textContent('#sheetContent');
t('말이 안 되는 속도(도보로 보기엔 너무 빠름) 응답은 실제 경로로 인정 안 함', detailImplausible.includes('직선거리 기준으로 추정'));
const savedCourseImplausible = await p.evaluate(() => foodMap.course);
t('비정상 속도 응답은 routedReal=false로 저장됨', savedCourseImplausible.routedReal === false);
await p.evaluate(() => document.getElementById('close').click());
await p.unroute('https://router.project-osrm.org/**').catch(() => {});

// --- 가용 시간(분)을 넘겨 받으면 실제로 코스 길이를 제한해야 한다
// (예전엔 입력만 읽고 계산에는 안 썼다) ---
await p.route('https://router.project-osrm.org/**', (route) => route.abort('failed')); // 직선거리 추정 경로로 단순화해 검사
await p.evaluate(() => {
  foodMap.lic = { name: 'q', date: '2026-01-01' };
  foodMap.places = [
    { id: 'b1', name: '출발점', lat: 33.590, lng: 130.400, cat: '카페·디저트', catConfirmed: true, sourceLists: [] },
    { id: 'b2', name: '가까운곳', lat: 33.591, lng: 130.401, cat: '맛집·식당', catConfirmed: true, sourceLists: [] },
    { id: 'b3', name: '먼곳', lat: 33.750, lng: 130.550, cat: '관광·명소', catConfirmed: true, sourceLists: [] },
  ];
  delete foodMap.course;
  delete foodMap.courses;
  A.saveFoodMap(foodMap);
});
await p.reload();
await p.waitForTimeout(300);
await p.evaluate(() => { ['b1', 'b2', 'b3'].forEach((id) => route.add(id)); });
await p.evaluate(() => showRoute());
await p.waitForTimeout(200);
await p.click('[data-build-course]');
await p.waitForTimeout(200);
await p.fill('#courseMinutes', '60'); // b2(도보 몇 분+체류 40분)는 들어가고, b3(17km 넘게 떨어짐)는 못 들어갈 시간
await p.click('[data-start-pick="b1"]');
await p.waitForTimeout(800);
const detailBudget = await p.textContent('#sheetContent');
t('가용 시간을 넘겨 못 들르는 곳은 "시간 안에 못 들름"으로 따로 표시', detailBudget.includes('가용 시간 안에'));
const savedCourseBudget = await p.evaluate(() => foodMap.course);
t('가용 시간을 넘는 먼 곳은 정거장에서 빠짐', !savedCourseBudget.stops.some((s) => s.id === 'b3'));
t('시간 안에 드는 가까운 곳은 그대로 들어감', savedCourseBudget.stops.some((s) => s.id === 'b2'));
t('시간 이유로 뺀 곳은 excludedReasons에 time-budget으로 남음', savedCourseBudget.excludedReasons && savedCourseBudget.excludedReasons.b3 === 'time-budget');
await p.evaluate(() => document.getElementById('close').click());

// --- "새로 만들기"는 실제로 새 코스가 완성되기 전까지 기존 코스를
// 지우면 안 된다(취소하면 이전 코스가 그대로 남아야 한다) ---
await p.evaluate(() => showRoute());
await p.waitForTimeout(150);
const beforeNewCourse = await p.evaluate(() => foodMap.course);
await p.click('[data-course-new]');
await p.waitForTimeout(150);
t('"새로 만들기"를 누른 직후에도(아직 새 코스 완성 전) 기존 코스가 안 지워짐', JSON.stringify(await p.evaluate(() => foodMap.course)) === JSON.stringify(beforeNewCourse));
await p.evaluate(() => document.getElementById('close').click()); // 출발지 시트를 취소
await p.waitForTimeout(150);
t('출발지 시트를 취소해도 기존 코스가 그대로 남음', JSON.stringify(await p.evaluate(() => foodMap.course)) === JSON.stringify(beforeNewCourse));
await p.unroute('https://router.project-osrm.org/**').catch(() => {});

t('최종 콘솔/런타임 오류 0', errs.length === 0);
if (errs.length) console.log('  ', errs.slice(0, 5));

await b.close();
console.log(fail ? ('\n실패 ' + fail + '건') : '\n전체 통과');
process.exit(fail ? 1 : 0);
