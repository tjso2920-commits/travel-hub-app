'use strict';
/**
 * 자전거 공유 반납 포트 스냅샷을 DB로 가져오는 운영자 전용 로컬 도구.
 *
 * 00_READ_FIRST_CLAUDE.md 7·9절 — "실데이터가 공개 저장소, 정적 자산,
 * GitHub Pages 자동 배포에 포함되지 않게 하세요", "실포트 데이터는
 * 공개용 코드 ZIP에 끼워 넣지 말고 운영자 로컬 입력 방식으로
 * 연결하세요." 이 스크립트는 그 "로컬 입력 방식"이다 — 스냅샷 JSON
 * 파일 자체는 이 저장소에 커밋하지 않고, 운영자가 자기 PC/서버의
 * 로컬 경로에 따로 갖고 있다가 이 스크립트로만 DB에 넣는다.
 *
 * 실행 예:
 *   DB_PATH=/data/travelhub.db \
 *   BIKE_PORTS_SNAPSHOT_PATH=/path/to/charichari_fukuoka_ports_snapshot.json \
 *   BIKE_PORTS_PROVIDER_ID=charichari \
 *   node scripts/import-bike-ports.mjs
 *
 * 스냅샷 JSON 형식(공식 웹지도 공개 페이지 스크립트가 실제로 요청하는
 * GraphQL 응답 형태를 그대로 옮긴 것 — server/bike-share-providers.mjs
 * 에 등록된 지역(regionId)만 받아들인다):
 *   { "regionId": "FUK", "source": "...", "endpoint": "...",
 *     "retrievedAt": "...", "ports": [
 *       { "id": "FUK0004", "title": "...", "address": "...",
 *         "capacity": 13, "location": { "latitude": 33.58, "longitude": 130.42 } },
 *       ... ] }
 *
 * 검증(전부 통과해야 임포트한다 — 하나라도 실패하면 아무것도 안 바꾼다):
 * - regionId가 등록된 활성 지역인지(server/bike-share-providers.mjs)
 * - 포트 id 중복 없음
 * - 위도/경도가 유효 범위(-90~90, -180~180) 안에 있고 숫자인지
 * - title·address가 빈 문자열이 아닌지
 * 같은 provider+region으로 다시 실행하면 기존 행을 전부 지우고
 * 새 스냅샷으로 치환한다(포트가 폐쇄·이전됐을 수 있어 "합치기"가
 * 아니라 "전체 치환"이 맞다 — 스냅샷 자체가 그 시점의 전체 목록이므로).
 */
import fs from 'node:fs';
import { openDb, nowIso } from '../server/db.mjs';
import { BIKE_SHARE_PROVIDERS } from '../server/bike-share-providers.mjs';

const snapshotPath = process.env.BIKE_PORTS_SNAPSHOT_PATH;
const providerId = process.env.BIKE_PORTS_PROVIDER_ID || 'charichari';

if (!snapshotPath) {
  console.error('BIKE_PORTS_SNAPSHOT_PATH 환경변수가 필요합니다(로컬 스냅샷 JSON 파일 경로).');
  process.exit(1);
}
if (!fs.existsSync(snapshotPath)) {
  console.error(`스냅샷 파일을 찾을 수 없습니다: ${snapshotPath}`);
  process.exit(1);
}
if (!process.env.DB_PATH) {
  console.error('DB_PATH 환경변수가 필요합니다(실제 서버가 쓰는 DB 경로와 같아야 합니다).');
  process.exit(1);
}

let snapshot;
try {
  snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
} catch (e) {
  console.error(`스냅샷 파일을 JSON으로 읽지 못했습니다: ${e.message}`);
  process.exit(1);
}

const regionCode = String(snapshot.regionId || '').trim();
const provider = BIKE_SHARE_PROVIDERS[providerId];
if (!provider || !provider.regions[regionCode]) {
  console.error(`등록되지 않은 사업자/지역입니다(provider=${providerId}, region=${regionCode}) — server/bike-share-providers.mjs에 먼저 등록·검증한 뒤 다시 시도하세요.`);
  process.exit(1);
}

const ports = Array.isArray(snapshot.ports) ? snapshot.ports : [];
if (!ports.length) {
  console.error('스냅샷에 ports 배열이 없거나 비어 있습니다.');
  process.exit(1);
}

function isValidLatLng(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

const seenIds = new Set();
const validated = [];
for (const p of ports) {
  const id = String(p.id || '').trim();
  const title = String(p.title || '').trim();
  const address = String(p.address || '').trim();
  const lat = p.location && Number(p.location.latitude);
  const lng = p.location && Number(p.location.longitude);
  const capacity = p.capacity === undefined || p.capacity === null ? null : Number(p.capacity);
  if (!id) { console.error('id가 없는 포트 항목이 있습니다 — 임포트를 중단합니다.'); process.exit(1); }
  if (seenIds.has(id)) { console.error(`포트 id가 중복됩니다: ${id} — 임포트를 중단합니다.`); process.exit(1); }
  seenIds.add(id);
  if (!title || !address) { console.error(`title/address가 비어 있는 포트가 있습니다(id=${id}) — 임포트를 중단합니다.`); process.exit(1); }
  if (!isValidLatLng(lat, lng)) { console.error(`좌표가 유효하지 않은 포트가 있습니다(id=${id}) — 임포트를 중단합니다.`); process.exit(1); }
  validated.push({ id, title, address, capacity, lat, lng });
}

const db = openDb();
const now = nowIso();
db.exec('BEGIN');
try {
  db.prepare('DELETE FROM bike_share_ports WHERE provider_id = ? AND region_code = ?').run(providerId, regionCode);
  const insert = db.prepare(`
    INSERT INTO bike_share_ports (provider_id, region_code, port_id, title, address, capacity, lat, lng, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const p of validated) {
    insert.run(providerId, regionCode, p.id, p.title, p.address, p.capacity, p.lat, p.lng, now);
  }
  db.prepare(`
    INSERT INTO bike_share_import_meta (provider_id, region_code, source_url, endpoint, retrieved_at, port_count, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider_id, region_code) DO UPDATE SET
      source_url = excluded.source_url, endpoint = excluded.endpoint, retrieved_at = excluded.retrieved_at,
      port_count = excluded.port_count, imported_at = excluded.imported_at
  `).run(providerId, regionCode, snapshot.source || null, snapshot.endpoint || null, snapshot.retrievedAt || null, validated.length, now);
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  console.error(`DB 반영 중 오류로 전체 롤백했습니다: ${e.message}`);
  process.exit(1);
}

console.log(`임포트 완료: provider=${providerId} region=${regionCode} 포트=${validated.length}건 (기준 시각: ${snapshot.retrievedAt || '알 수 없음'})`);
