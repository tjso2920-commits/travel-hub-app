'use strict';
/**
 * 자전거 공유 반납 포트 안내 — 사업자→지역→포트 구조.
 *
 * 00_READ_FIRST_CLAUDE.md(챠리챠리 최종 통합본) 7절 — "사업자→지역→포트
 * 구조로 분리하고 화면에 FUK/후쿠오카를 반복 하드코딩하지 마세요. 현재는
 * 검증한 FUK만 활성화하세요. 다른 지역 코드를 추측해 지원 표시하지
 * 마세요." — 이 파일 하나가 "지금 실제로 켠 지역"의 유일한 근거다.
 * 서버 라우트(routes/bike-ports.mjs)와 클라이언트(bike-ports.js)는
 * 전부 이 표를 통해서만 활성 여부를 판정하고, 어디에도 "FUK"·"후쿠오카"
 * 문자열을 직접 다시 적지 않는다.
 *
 * 새 지역·사업자를 실제로 추가할 때는: (1) 그 지역 스냅샷을 실제로
 * 확보·검증하고, (2) 상업적 재사용 조건을 확인한 뒤, (3) 여기에 항목을
 * 추가하고 active:true로 바꾼다 — 그 전까지는 절대 active로 두지 않는다.
 */
export const BIKE_SHARE_PROVIDERS = {
  charichari: {
    displayName: 'charichari',
    regions: {
      FUK: {
        active: true,
        // 목적지 도시 이름이 이 목록 중 하나와 일치하면(대소문자 무시)
        // 이 지역이 활성화된 것으로 본다 — 국가 필드 기반 판정이 아니라
        // 이 서비스가 도시 단위로 운영되기 때문이다.
        cityNames: ['후쿠오카', 'fukuoka'],
        officialMapUrl: 'https://charichari.bike/en/map?region=FUK',
      },
    },
  },
};

export function activeBikeShareRegions() {
  const out = [];
  for (const [providerId, provider] of Object.entries(BIKE_SHARE_PROVIDERS)) {
    for (const [regionCode, region] of Object.entries(provider.regions)) {
      if (region.active) {
        out.push({ providerId, regionCode, cityNames: region.cityNames.slice(), officialMapUrl: region.officialMapUrl });
      }
    }
  }
  return out;
}

export function isRegionActive(providerId, regionCode) {
  const p = BIKE_SHARE_PROVIDERS[providerId];
  const r = p && p.regions[regionCode];
  return !!(r && r.active);
}

export function officialMapUrlFor(providerId, regionCode) {
  const p = BIKE_SHARE_PROVIDERS[providerId];
  const r = p && p.regions[regionCode];
  return (r && r.officialMapUrl) || null;
}

/* cityName으로 활성 지역을 찾는다(클라이언트가 도시 이름만 갖고 있을
   때 쓴다 — 서버가 유일한 판정 기준을 갖고, 클라이언트는 이 결과만
   그대로 따른다). 못 찾으면 null. */
export function activeRegionForCityName(cityName) {
  const needle = String(cityName || '').trim().toLowerCase();
  if (!needle) return null;
  for (const region of activeBikeShareRegions()) {
    if (region.cityNames.some((n) => n.toLowerCase() === needle)) return region;
  }
  return null;
}
