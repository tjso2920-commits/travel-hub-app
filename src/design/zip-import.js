'use strict';
/**
 * Takeout ZIP 직접 가져오기 — 사용자가 미리 압축을 풀 필요가 없게 한다.
 *
 * 2026-09-09 코드 검토(로드맵 ②): "사용자는 Takeout ZIP을 압축 해제하지
 * 않고 선택할 수 있어야 한다." 중첩 폴더 안의 Saved CSV와 지도(내 장소)의
 * 저장 장소 JSON을 찾고, 리뷰는 제외한다.
 *
 * 안전장치(대용량·손상 ZIP·브라우저 멈춤 방지):
 *  - 압축 파일 자체 크기 상한(기본 300MB) — 이보다 크면 열어보지도 않는다.
 *  - 압축 해제 "전에" 파일명을 보고 걸러낸다(fflate의 filter 콜백) —
 *    사진·다른 서비스 데이터처럼 우리가 안 쓰는 대용량 항목은 애초에
 *    압축을 풀지 않는다. 이게 진짜 안전장치다 — 다 풀고 나서 버리면
 *    이미 브라우저가 멈춘 뒤다.
 *  - 개별 항목 압축 해제 후 크기 상한(기본 30MB) — Saved 목록 CSV/JSON은
 *    이보다 훨씬 작다. 폭탄(zip bomb) 항목을 걸러낸다.
 *  - 처리할 항목 개수 상한(기본 500개) — 이 이상은 안 본다.
 *  - 시간 제한(기본 60초) — 손상된 zip이 안 끝나고 멈춰 있지 않게 한다.
 *
 * 실패 원인을 구분해서 돌려준다 — "무슨 파일이 왜 빠졌는지"를 화면에서
 * 보여주기 위해서다(요청하신 "파일별 결과·제외 이유·저장 성공 표시").
 */
function daIsZipFile(file) {
  return !!file && (/\.zip$/i.test(file.name || '') || file.type === 'application/zip' || file.type === 'application/x-zip-compressed');
}

function daParseZip(file, opts) {
  opts = opts || {};
  const MAX_ZIP_BYTES = opts.maxZipBytes || 300 * 1024 * 1024;
  const MAX_ENTRY_BYTES = opts.maxEntryBytes || 30 * 1024 * 1024;
  const MAX_ENTRIES = opts.maxEntries || 500;
  const TIMEOUT_MS = opts.timeoutMs || 60000;

  if (typeof fflate === 'undefined' || !fflate.unzip) {
    return Promise.resolve({ ok: false, reason: 'no-zip-support', files: [], skipped: [] });
  }
  if (!file || !file.size) {
    return Promise.resolve({ ok: false, reason: 'empty', files: [], skipped: [] });
  }
  if (file.size > MAX_ZIP_BYTES) {
    return Promise.resolve({ ok: false, reason: 'zip-too-large', files: [], skipped: [] });
  }

  return file.arrayBuffer().then((buf) => new Promise((resolve) => {
    const skipped = [];
    let decompressedCount = 0;
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout', files: [], skipped }), TIMEOUT_MS);

    let u8;
    try { u8 = new Uint8Array(buf); } catch (e) { finish({ ok: false, reason: 'corrupt', files: [], skipped }); return; }

    try {
      fflate.unzip(u8, {
        filter(f) {
          const name = f.name || '';
          if (!name || /\/$/.test(name)) return false;
          const base = name.split('/').pop();
          const isCsv = /\.csv$/i.test(base);
          const isJson = /\.json$/i.test(base);
          if (!isCsv && !isJson) return false;
          /* 리뷰 파일명은 애초에 압축을 풀지 않는다(내용 기반 제외는
             daJsonPlaces의 daIsReviewFeature가 이중으로 한 번 더 본다 —
             파일명이 애매해도 실제 리뷰 데이터는 결국 제외된다). */
          if (isJson && /(review|리뷰)/i.test(base)) { skipped.push({ name, reason: 'review-file' }); return false; }
          if (f.originalSize > MAX_ENTRY_BYTES) { skipped.push({ name, reason: 'entry-too-large' }); return false; }
          if (decompressedCount >= MAX_ENTRIES) { skipped.push({ name, reason: 'too-many-entries' }); return false; }
          decompressedCount++;
          return true;
        },
      }, (err, unzipped) => {
        if (err) { finish({ ok: false, reason: 'corrupt', error: String((err && err.message) || err), files: [], skipped }); return; }
        const files = [];
        Object.keys(unzipped || {}).forEach((name) => {
          try {
            const text = fflate.strFromU8(unzipped[name]);
            files.push({ name, text, kind: /\.csv$/i.test(name) ? 'csv' : 'json' });
          } catch (e) {
            skipped.push({ name, reason: 'decode-failed' });
          }
        });
        if (!files.length && !skipped.length) { finish({ ok: false, reason: 'no-target-files', files: [], skipped }); return; }
        finish({ ok: true, files, skipped });
      });
    } catch (e) {
      finish({ ok: false, reason: 'corrupt', error: String((e && e.message) || e), files: [], skipped });
    }
  })).catch(() => ({ ok: false, reason: 'read-failed', files: [], skipped: [] }));
}

window.ZipImport = { isZipFile: daIsZipFile, parseZip: daParseZip };
