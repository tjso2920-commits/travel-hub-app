'use strict';
/**
 * 날씨 조회 어댑터(2026-09-10 재검토 7차 4절 — 착장 판단용 날씨 카드).
 *
 * 공급자: WeatherAPI.com 무료 등급. 공식 가격표(https://www.weatherapi.com/pricing.aspx)
 * 로 확인한 조건 — 상업적 사용 허용, 월 100,000회, 현재 날씨+3일 예보
 * 포함(https://www.weatherapi.com/docs/). 서버가 키를 들고 있고 소비자는
 * 절대 키를 입력하지 않는다(place-lookup.mjs·routing.mjs와 같은 원칙).
 *
 * 응답을 화면이 바로 쓰기 좋은 정규화된 형태로 통일한다(실제 어댑터든
 * 테스트 어댑터든 같은 모양을 돌려준다):
 *   { ok, location:{name, tzId}, current:{tempC, feelsLikeC, conditionText,
 *     observedAtIso}, forecastDays:[{ dateISO, maxC, minC, eveningC,
 *     hourly:[{hourIso, popPercent, windKph}] }, ...최대 3일], source }
 * forecastDays[0]이 "오늘"(공급자가 판단한 이 위치의 현지 오늘)이다.
 *
 * "현재 날씨"와 "예보"를 절대 섞지 않는다 — current는 지금 이 순간의
 * 관측치(observedAtIso = 공급자가 실제로 갱신한 시각)이고, forecastDays는
 * 예보다. 화면(weather-card.js)이 이 둘을 분명히 구분해서 표시한다.
 */
import { config } from '../config.mjs';
import { fetchWithTimeout } from '../net.mjs';

/* 테스트 어댑터 — 위경도의 해시로 결정론적 합성 날씨를 만든다(실제
   네트워크 없이 서버·화면 코드 경로를 검증하기 위한 것 — 가짜로 "다
   맑음"이라고 뭉개지 않고, 흐림·비·바람이 섞인 그럴듯한 값을 만든다). */
function hashOf(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function testAdapter({ lat, lng, tzId }) {
  const h = hashOf(`${lat},${lng}`);
  const baseTemp = 10 + (h % 25); // 10~34도
  const diurnalRange = 4 + (h % 10); // 일교차 4~13도
  const feelsOffset = ((h % 7) - 3); // 체감 -3~+3도
  const rainy = h % 4 === 0; // 4곳 중 1곳 꼴로 비 오는 시나리오
  const windy = h % 5 === 0;
  const now = new Date();
  const current = {
    tempC: baseTemp,
    feelsLikeC: baseTemp + feelsOffset,
    conditionText: rainy ? '비' : (windy ? '바람 강함' : '맑음'),
    observedAtIso: now.toISOString(),
  };
  const hourly = [];
  for (let i = 0; i < 4; i++) {
    hourly.push({
      hourIso: new Date(now.getTime() + i * 3 * 3600_000).toISOString(),
      popPercent: rainy ? 55 + (i * 5) : Math.max(0, 10 - i * 3),
      windKph: windy ? 28 + i : 10 + i,
    });
  }
  return {
    ok: true,
    location: { name: '', tzId: tzId || 'Asia/Seoul' },
    current,
    forecastDays: [{
      dateISO: now.toISOString().slice(0, 10),
      maxC: baseTemp + Math.ceil(diurnalRange / 2),
      minC: baseTemp - Math.floor(diurnalRange / 2),
      eveningC: baseTemp - 2,
      hourly,
    }],
    source: 'test-adapter',
  };
}

function toHourly(hourArr, fromHourIndex) {
  const picked = [];
  for (let i = fromHourIndex; i < hourArr.length && picked.length < 6; i += 3) {
    const h = hourArr[i];
    if (!h) continue;
    picked.push({
      hourIso: new Date(h.time.replace(' ', 'T') + ':00').toISOString(),
      popPercent: Number(h.chance_of_rain) || 0,
      windKph: Number(h.wind_kph) || 0,
    });
  }
  return picked;
}

async function realAdapter({ lat, lng }) {
  const key = config.weather.apiKey;
  if (!key) return { ok: false, reason: 'no-api-key-configured' };
  try {
    const res = await fetchWithTimeout(
      `${config.weather.apiBase}/forecast.json?key=${encodeURIComponent(key)}&q=${lat},${lng}&days=3&aqi=no&alerts=no&lang=ko`,
      { method: 'GET' },
      config.externalRequestTimeoutMs,
    );
    if (!res.ok) return { ok: false, reason: 'http-error', status: res.status };
    const data = await res.json();
    const loc = data.location || {};
    const cur = data.current || {};
    const days = (data.forecast && data.forecast.forecastday) || [];
    if (!days.length) return { ok: false, reason: 'no-forecast-data' };
    const nowLocalHour = new Date(loc.localtime ? loc.localtime.replace(' ', 'T') + ':00' : Date.now()).getHours();
    const forecastDays = days.map((d, i) => ({
      dateISO: d.date,
      maxC: d.day && d.day.maxtemp_c,
      minC: d.day && d.day.mintemp_c,
      eveningC: Array.isArray(d.hour) && d.hour[18] ? d.hour[18].temp_c : null,
      hourly: toHourly(d.hour || [], i === 0 ? nowLocalHour : 0),
    }));
    return {
      ok: true,
      location: { name: loc.name || '', tzId: loc.tz_id || '' },
      current: {
        tempC: cur.temp_c,
        feelsLikeC: cur.feelslike_c,
        conditionText: (cur.condition && cur.condition.text) || '',
        observedAtIso: cur.last_updated ? new Date(cur.last_updated.replace(' ', 'T') + ':00').toISOString() : new Date().toISOString(),
      },
      forecastDays,
      source: 'weatherapi',
    };
  } catch (e) {
    return { ok: false, reason: 'network-error' };
  }
}

export async function lookupWeather(params) {
  if (config.services.weather === 'real') return realAdapter(params);
  // 운영인데 키가 없으면(unavailable) 조용히 가짜 데이터로 넘어가지
  // 않는다 — place-lookup.mjs와 같은 원칙.
  if (config.isProd) return { ok: false, reason: 'weather-unavailable' };
  return testAdapter(params);
}
