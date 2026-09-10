'use strict';
/**
 * Takeout ZIP 직접 가져오기 — 사용자가 미리 압축을 풀 필요가 없게 한다.
 *
 * 2026-09-09 코드 검토(로드맵 ②): "사용자는 Takeout ZIP을 압축 해제하지
 * 않고 선택할 수 있어야 한다." 중첩 폴더 안의 Saved CSV와 지도(내 장소)의
 * 저장 장소 JSON을 찾고, 리뷰는 제외한다.
 *
 * 2026-09-09 코드 검토(2차) — 이전 버전의 한계 3가지, 전부 이번에 고침:
 *
 * 1) **파일명만으로 걸렀다.** 확장자가 csv/json이고 파일명에 "review"가
 *    없으면 전부 통과시켰다 — Gmail·Google Photos·캘린더 등 계정 전체
 *    Takeout ZIP 안의 다른 서비스 파일(예: 캘린더 일정을 담은 .json,
 *    사진 메타데이터 .json)도 그대로 압축을 풀어버렸다. 이번엔 파일명뿐
 *    아니라 **경로**(어느 폴더 안에 있는지)까지 같이 본다 —
 *    Saved/저장됨/Maps(your places)/지도(내 장소) 폴더 안에 있는
 *    csv·json만 압축을 푼다(daIsPlacesPath). 내용 구조까지 맞는지는
 *    압축을 푼 뒤 daCsv/daJsonPlaces가 알아서 걸러낸다(맞는 열이
 *    하나도 없으면 빈 결과로 끝난다 — 이중 방어).
 * 2) **전체 압축해제량 상한이 없었다.** 항목 하나당 30MB, 개수 500개
 *    상한은 있었지만, 500개×30MB에 가깝게 쌓이면 압축을 풀어야 하는
 *    총량이 매우 커질 수 있었다. 전체 압축해제량 상한(기본 200MB)을
 *    추가해 그 합을 넘으면 남은 항목은 더 이상 안 푼다.
 * 3) **타임아웃이 "결과만 먼저 포기"였다.** 이전엔 `setTimeout`이
 *    실패 결과를 먼저 돌려줄 뿐, `fflate.unzip()` 내부에서 실제로 돌고
 *    있는 압축 해제 작업 자체는 멈추지 않았다(비동기 콜백이 나중에
 *    도착해도 그냥 버려질 뿐, 그때까지 CPU는 계속 쓰고 있었다).
 *    이번엔 fflate의 **스트리밍 API**(`fflate.Unzip` + `fflate.UnzipInflate`)
 *    로 다시 짰다 — 압축 해제를 우리가 항목 단위로 직접 통제하므로,
 *    시간 예산을 넘기면 그 시점부터 남은 항목은 애초에 `file.start()`를
 *    부르지 않는다(진짜로 작업 자체가 시작되지 않는다 — 이미 시작한
 *    항목까지 멈추는 건 아니지만, 항목 하나당 크기 상한이 있어 그 하나가
 *    끝없이 도는 일은 없다).
 *
 * 안전장치(대용량·손상 ZIP·브라우저 멈춤 방지):
 *  - 압축 파일 자체 크기 상한(기본 300MB) — 이보다 크면 열어보지도 않는다.
 *  - 경로+파일명으로 대상을 먼저 좁힌다(Saved/Maps 관련 폴더 + csv/json).
 *  - 개별 항목 압축 해제 후 크기 상한(기본 30MB).
 *  - 전체 항목 압축 해제 후 총량 상한(기본 200MB, 새로 추가).
 *  - 처리할 항목 개수 상한(기본 500개).
 *  - 시간 제한(기본 60초) — 이 시점 이후로는 새 항목의 압축 해제 자체를
 *    시작하지 않는다(위 3번 참고).
 *
 * **검증 한계**: 이 파일은 합성(직접 만든) ZIP 픽스처로만 검증했다 —
 * 사용자의 실제 개인 Takeout ZIP 전체를 테스트 재료로 요청하지 않는다는
 * 원칙 때문에, 실제 Google Takeout이 만드는 정확한 폴더명(로케일·시점에
 * 따라 조금씩 다를 수 있다)으로 실제 검증은 못 했다 — daIsPlacesPath가
 * 예상한 폴더명과 실제 사용자가 받는 폴더명이 다르면 정상 파일이
 * 걸러질 수 있다는 뜻이다. 실사용에서 이런 보고가 오면 패턴을 넓혀야 한다.
 *
 * 실패 원인을 구분해서 돌려준다 — "무슨 파일이 왜 빠졌는지"를 화면에서
 * 보여주기 위해서다(요청하신 "파일별 결과·제외 이유·저장 성공 표시").
 */
function daIsZipFile(file) {
  return !!file && (/\.zip$/i.test(file.name || '') || file.type === 'application/zip' || file.type === 'application/x-zip-compressed');
}

/* 이 경로가 "저장한 장소" 관련 Takeout 폴더 안에 있는지 본다(파일명이
   아니라 디렉터리 경로 기준). Saved/저장(됨)/Maps.../지도(내 장소) 계열
   폴더 이름 중 하나를 경로 세그먼트로 포함해야 한다 — Gmail·Photos·
   Calendar 같은 다른 서비스 폴더는 이 이름을 안 쓰므로 걸러진다. */
function daIsPlacesPath(name) {
  const dir = String(name || '').replace(/\/[^/]*$/, '');
  return /(^|\/)(saved|maps(?:\s*\([^)]*\))?|지도(?:\s*\([^)]*\))?|저장(?:됨)?)(\/|$)/i.test(dir);
}

function daParseZip(file, opts) {
  opts = opts || {};
  const MAX_ZIP_BYTES = opts.maxZipBytes || 300 * 1024 * 1024;
  const MAX_ENTRY_BYTES = opts.maxEntryBytes || 30 * 1024 * 1024;
  const MAX_ENTRIES = opts.maxEntries || 500;
  const MAX_TOTAL_BYTES = opts.maxTotalBytes || 200 * 1024 * 1024;
  const TIMEOUT_MS = opts.timeoutMs || 60000;

  if (typeof fflate === 'undefined' || !fflate.Unzip || !fflate.UnzipInflate || !fflate.strFromU8) {
    return Promise.resolve({ ok: false, reason: 'no-zip-support', files: [], skipped: [] });
  }
  if (!file || !file.size) {
    return Promise.resolve({ ok: false, reason: 'empty', files: [], skipped: [] });
  }
  if (file.size > MAX_ZIP_BYTES) {
    return Promise.resolve({ ok: false, reason: 'zip-too-large', files: [], skipped: [] });
  }

  return file.arrayBuffer().then((buf) => {
    const skipped = [];
    const files = [];
    let u8;
    try { u8 = new Uint8Array(buf); } catch (e) { return { ok: false, reason: 'corrupt', files: [], skipped }; }

    const deadline = Date.now() + TIMEOUT_MS;
    let acceptedCount = 0;
    let totalBytes = 0;
    let timedOut = false;

    /* fflate.Unzip.push()는 zip 구조가 아예 아닌 데이터를 줘도 던지지
       않는다 — 그냥 onfile을 한 번도 안 부르고 조용히 끝난다(실제
       확인함). 그래서 "손상된 zip"과 "유효한 zip인데 대상 파일이
       하나도 없음"을 구분하려면 onfile이 몇 번이라도 불렸는지를
       따로 세야 한다 — 한 번도 안 불렸으면 애초에 zip 구조를 못
       읽은 것으로 본다(진짜 손상). */
    let anyEntrySeen = false;
    const unzipper = new fflate.Unzip();
    unzipper.register(fflate.UnzipInflate);
    unzipper.onfile = (f) => {
      anyEntrySeen = true;
      const name = f.name || '';
      if (!name || /\/$/.test(name)) return; // 디렉터리 항목
      const base = name.split('/').pop();
      const isCsv = /\.csv$/i.test(base);
      const isJson = /\.json$/i.test(base);
      if (!isCsv && !isJson) return; // 대상 확장자가 아니면 애초에 start()를 안 부른다
      if (!daIsPlacesPath(name)) { skipped.push({ name, reason: 'not-places-path' }); return; }
      if (isJson && /(review|리뷰)/i.test(base)) { skipped.push({ name, reason: 'review-file' }); return; }
      if (f.originalSize && f.originalSize > MAX_ENTRY_BYTES) { skipped.push({ name, reason: 'entry-too-large' }); return; }
      if (acceptedCount >= MAX_ENTRIES) { skipped.push({ name, reason: 'too-many-entries' }); return; }
      if (f.originalSize && totalBytes + f.originalSize > MAX_TOTAL_BYTES) { skipped.push({ name, reason: 'total-size-exceeded' }); return; }
      /* 시간 예산을 넘긴 뒤로는 새 항목의 압축 해제 자체를 시작하지
         않는다 — 이게 실제 "중단"이다(결과만 포기하는 게 아니라). */
      if (Date.now() > deadline) { timedOut = true; skipped.push({ name, reason: 'timeout' }); return; }
      acceptedCount++;
      totalBytes += f.originalSize || 0;
      const chunks = [];
      f.ondata = (err, data, final) => {
        if (err) { skipped.push({ name, reason: 'decode-failed' }); return; }
        if (data && data.length) chunks.push(data);
        if (final) {
          try {
            let merged = chunks.length === 1 ? chunks[0] : new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
            if (chunks.length !== 1) { let off = 0; chunks.forEach((c) => { merged.set(c, off); off += c.length; }); }
            const text = fflate.strFromU8(merged);
            files.push({ name, text, kind: isCsv ? 'csv' : 'json' });
          } catch (e2) {
            skipped.push({ name, reason: 'decode-failed' });
          }
        }
      };
      try { f.start(); } catch (e3) { skipped.push({ name, reason: 'decode-failed' }); }
    };

    try {
      unzipper.push(u8, true);
    } catch (e) {
      return { ok: false, reason: 'corrupt', error: String((e && e.message) || e), files: [], skipped };
    }
    if (!anyEntrySeen) return { ok: false, reason: 'corrupt', error: 'no zip entries found', files: [], skipped };
    if (!files.length && !skipped.length) return { ok: false, reason: 'no-target-files', files: [], skipped };
    return { ok: true, files, skipped, timedOut };
  }).catch(() => ({ ok: false, reason: 'read-failed', files: [], skipped: [] }));
}

window.ZipImport = { isZipFile: daIsZipFile, parseZip: daParseZip, isPlacesPath: daIsPlacesPath };
