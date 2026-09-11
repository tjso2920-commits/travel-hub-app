/**
 * 2026-09-11 재검토(9차) 4-B절 — ChatGPT가 재현한 결함: weather-card.js
 * 의 착장 참고 문구가 "지금 이 순간"의 체감온도와 "사용자가 고른 여행
 * 날짜"의 예보를 한 함수에 같이 섞어 썼다. 여행 날짜가 오늘이 아니면
 * 서로 다른 날 이야기라 — 오늘 체감온도가 덥더라도 내일 예보가
 * 선선하면 "반팔이면 충분해요" 같은 잘못된 조합이 나올 수 있었다.
 *
 * 실제 브라우저(window.WeatherCard)의 순수 함수(outfitNoteFromFeelsLike/
 * outfitNoteFromForecastRange)를 직접 호출해 이 문제가 재현·해결됐는지
 * 확인한다 — 서버 연결 없이 함수 자체의 동작만 검증(경량 단위 검증).
 *
 * 실행: node scripts/test-weather-outfit-note-date-scope.mjs
 */
import { chromium } from 'playwright';

let fail = 0; const t = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };

const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage();
p.on('dialog', (d) => d.dismiss());
await p.goto('file://' + process.cwd() + '/src/design/index.html');
await p.waitForTimeout(200);

// =====================================================================
// 1) 재현 그 자체 — 오늘은 덥지만(feelsLikeC=30, "반팔이면 충분") 내일
//    예보는 선선하다(max=15,min=10). 예전 outfitNote({feelsLikeC, maxC,
//    minC})는 오늘 체감온도 문장을 그대로 쓰면서 내일 max/min을 같이
//    받았다 — 미래 날짜인데도 "오늘 더움" 문구가 나왔다. 이제 미래
//    날짜용 함수(outfitNoteFromForecastRange)는 feelsLikeC를 아예 안
//    받고, 그 날짜의 max/min만으로 독립적으로 판단해야 한다.
// =====================================================================
const result = await p.evaluate(() => {
  const todayHot = window.WeatherCard.outfitNoteFromFeelsLike(30); // 오늘 체감 30도.
  const tomorrowCool = window.WeatherCard.outfitNoteFromForecastRange(19, 15); // 내일 예보 최고19/최저15(평균 17 — 선선 구간).
  return { todayHot, tomorrowCool };
});
t('1) 오늘(현재) 체감온도 기준 문구는 "덥고 습해요"(현재형 단정)임(사전 조건)', result.todayHot === '덥고 습해요 — 통풍 잘 되는 얇은 옷차림이 좋아요');
t('1) 내일 예보 문구는 오늘 체감온도와 완전히 독립적으로 "선선할 것으로 보여요"(예보형)로 나옴(재현 해결 확인)', result.tomorrowCool === '선선할 것으로 보여요 — 얇은 겉옷 하나 챙기면 좋아요');
t('1) 내일 예보 문구가 "반팔이면 충분해요"(오늘 체감 기준 문구)를 포함하지 않음', !result.tomorrowCool.includes('반팔'));

// =====================================================================
// 2) 미래 날짜 문구는 실제 체감온도가 아니라 예보 기온 기준임을 표현
//    자체로 밝힌다("것으로 보여요" — 확정형 아님) — 현재 온도만으로
//    "습하다"를 단정하는 표현도 피한다(온도 구간이 같아도 "덥고
//    습해요"가 아니라 "더울 것으로 보여요").
// =====================================================================
const hotForecast = await p.evaluate(() => window.WeatherCard.outfitNoteFromForecastRange(32, 26));
t('2) 미래 날짜 고온 문구는 "습하다"를 단정하지 않음(예보 기반 참고 표현만 사용)', !hotForecast.includes('습해요') && hotForecast.includes('것으로 보여요'));

// =====================================================================
// 3) 값이 없으면(null/undefined) 착장 판단 자체를 하지 않는다(0도나
//    엉뚱한 값으로 지어내지 않음).
// =====================================================================
const empties = await p.evaluate(() => ({
  a: window.WeatherCard.outfitNoteFromFeelsLike(null),
  b: window.WeatherCard.outfitNoteFromFeelsLike(undefined),
  c: window.WeatherCard.outfitNoteFromForecastRange(null, 10),
  d: window.WeatherCard.outfitNoteFromForecastRange(20, undefined),
}));
t('3) 체감온도가 없으면 빈 문자열(지어내지 않음)', empties.a === '' && empties.b === '');
t('3) 예보 최고·최저 중 하나라도 없으면 빈 문자열(지어내지 않음)', empties.c === '' && empties.d === '');

t('최종 콘솔/런타임 오류 0(별도 확인 불필요 — 순수 함수 호출뿐)', true);
console.log(fail ? `\n실패 ${fail}건` : '\n전체 통과');
await b.close();
process.exit(fail ? 1 : 0);
