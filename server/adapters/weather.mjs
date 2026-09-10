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
 *
 * 2026-09-10 재검토(8차) 3절 — ChatGPT가 재현한 시간대 버그: 공급자의
 * `last_updated`·`hour.time`은 "목적지 현지 시각" 문자열인데 시간대
 * 표기가 전혀 없다(예: "2026-09-10 21:00"). 예전 코드는 이걸 그대로
 * `new Date(...)`로 파싱했는데, 시간대 표기가 없는 날짜-시간 문자열은
 * ECMA-262 규격상 "이 코드를 실행하는 서버의 로컬 시간대"로 해석된다
 * — 서버가 UTC로 돌면(대부분의 배포 환경) 일본 현지 21:00이 "21:00Z"
 * 로 잘못 해석되고, 화면이 다시 이걸 Asia/Tokyo로 지역화하면 실제보다
 * 9시간 더 밀린(다음날 새벽) 값이 뜬다.
 *
 * 그래서 지금은 **문자열을 절대 안 쓰고** 공급자가 함께 주는 epoch
 * 필드(last_updated_epoch·hour.time_epoch·location.localtime_epoch —
 * 전부 시간대와 무관한 절대 UTC 유닉스초)만으로 절대 시각을 만든다.
 * "오늘인지" 판정과 "지금이 목적지 현지 몇 시인지"도 서버의 로컬
 * 시간대에 기대지 않고, epoch를 location.tz_id로 다시 지역화해서
 * 계산한다(hourInTz/dateInTz). 공식 문서: https://www.weatherapi.com/docs/ */
import { config } from '../config.mjs';
import { fetchWithTimeout } from '../net.mjs';

/* 절대 시각(epoch초)을 특정 시간대의 "그 시각 몇 시"(0~23)로. 서버가
   어느 시간대로 돌든 결과가 똑같다 — Intl이 tzId 자체로 지역화하고,
   서버의 로컬 시간대는 전혀 관여하지 않는다. */
function hourInTz(epochSeconds, tzId) {
  const d = new Date(epochSeconds * 1000);
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tzId || 'UTC', hour: 'numeric', hourCycle: 'h23' });
  return Number(fmt.format(d));
}
/* 절대 시각(epoch초)을 특정 시간대의 "그 날짜"(YYYY-MM-DD)로. */
function dateInTz(epochSeconds, tzId) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tzId || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(epochSeconds * 1000));
}

/* 테스트 어댑터 — 위경도의 해시로 결정론적 합성 날씨를 만든다(실제
   네트워크 없이 서버·화면 코드 경로를 검증하기 위한 것 — 가짜로 "다
   맑음"이라고 뭉개지 않고, 흐림·비·바람이 섞인 그럴듯한 값을 만든다). */
function hashOf(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function testAdapter({ lat, lng, tzId }) {
  const tz = tzId || 'Asia/Seoul';
  const h = hashOf(`${lat},${lng}`);
  const baseTemp = 10 + (h % 25); // 10~34도
  const diurnalRange = 4 + (h % 10); // 일교차 4~13도
  const feelsOffset = ((h % 7) - 3); // 체감 -3~+3도
  const rainy = h % 4 === 0; // 4곳 중 1곳 꼴로 비 오는 시나리오
  const windy = h % 5 === 0;
  const nowMs = Date.now();
  const current = {
    tempC: baseTemp,
    feelsLikeC: baseTemp + feelsOffset,
    conditionText: rainy ? '비' : (windy ? '바람 강함' : '맑음'),
    observedAtIso: new Date(nowMs).toISOString(),
  };
  const hourly = [];
  for (let i = 0; i < 4; i++) {
    hourly.push({
      hourIso: new Date(nowMs + i * 3 * 3600_000).toISOString(),
      popPercent: rainy ? 55 + (i * 5) : Math.max(0, 10 - i * 3),
      windKph: windy ? 28 + i : 10 + i,
    });
  }
  // 2026-09-10 재검토(8차) 3절 — 여행 날짜가 오늘이 아닐 수도 있으므로
  // (거리·옷차림 영상과 마찬가지로) 무료 등급이 실제로 주는 만큼인
  // 오늘+2일(총 3일)까지 합성 예보를 만들어 둔다. 실제 어댑터와 같은
  // 원칙으로 날짜도 tz 기준으로 계산한다(서버 로컬 시간대에 기대지 않음).
  const forecastDays = [{
    dateISO: dateInTz(Math.floor(nowMs / 1000), tz),
    maxC: baseTemp + Math.ceil(diurnalRange / 2),
    minC: baseTemp - Math.floor(diurnalRange / 2),
    eveningC: baseTemp - 2,
    hourly,
  }];
  for (let dayOffset = 1; dayOffset < 3; dayOffset++) {
    forecastDays.push({
      dateISO: dateInTz(Math.floor(nowMs / 1000) + dayOffset * 86400, tz),
      maxC: baseTemp + Math.ceil(diurnalRange / 2) + dayOffset,
      minC: baseTemp - Math.floor(diurnalRange / 2) + dayOffset,
      eveningC: baseTemp - 2 + dayOffset,
      hourly: [],
    });
  }
  return {
    ok: true,
    location: { name: '', tzId: tz },
    current,
    forecastDays,
    source: 'test-adapter',
  };
}

/* hourArr의 각 원소는 반드시 time_epoch(절대 UTC 유닉스초)를 들고 있어야
   한다 — 시간대 표기 없는 h.time 문자열은 여기서 절대 파싱하지 않는다
   (그게 바로 8차에서 고친 버그의 근원이다). epoch가 없는 항목은 거짓
   시각을 지어내는 것보다 안전하게 건너뛴다. */
function toHourly(hourArr, fromHourIndex) {
  const picked = [];
  for (let i = fromHourIndex; i < hourArr.length && picked.length < 6; i += 3) {
    const h = hourArr[i];
    if (!h) continue;
    const epoch = Number(h.time_epoch);
    if (!Number.isFinite(epoch)) continue;
    picked.push({
      hourIso: new Date(epoch * 1000).toISOString(),
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
    const tzId = loc.tz_id || '';
    // location.localtime_epoch는 "지금 이 순간"의 절대 유닉스초다(문자열
    // localtime과 달리 시간대와 무관) — 이걸 tzId로 지역화해서 "목적지
    // 기준 지금 몇 시·오늘이 며칠인지"를 구한다. 서버 프로세스가 어느
    // 시간대로 돌든 결과가 같다.
    const nowEpoch = Number(loc.localtime_epoch) || Math.floor(Date.now() / 1000);
    const nowLocalHour = hourInTz(nowEpoch, tzId);
    const todayLocalDate = dateInTz(nowEpoch, tzId);
    const forecastDays = days.map((d) => ({
      dateISO: d.date, // 공급자가 이미 목적지 현지 달력 기준으로 주는 값 — 재해석하지 않고 그대로 쓴다.
      maxC: d.day && d.day.maxtemp_c,
      minC: d.day && d.day.mintemp_c,
      eveningC: Array.isArray(d.hour) && d.hour[18] ? d.hour[18].temp_c : null,
      // "오늘"에 해당하는 날짜만 지금 이후 시간대로 슬라이스한다(이미
      // 지난 시간을 보여주지 않기 위해) — 판정 기준은 서버 시간대가
      // 아니라 todayLocalDate(목적지 기준 오늘)다.
      hourly: toHourly(d.hour || [], d.date === todayLocalDate ? nowLocalHour : 0),
    }));
    const observedEpoch = Number(cur.last_updated_epoch);
    return {
      ok: true,
      location: { name: loc.name || '', tzId },
      current: {
        tempC: cur.temp_c,
        feelsLikeC: cur.feelslike_c,
        conditionText: (cur.condition && cur.condition.text) || '',
        observedAtIso: Number.isFinite(observedEpoch) ? new Date(observedEpoch * 1000).toISOString() : new Date().toISOString(),
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
