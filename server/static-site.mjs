'use strict';
/**
 * 화면 파일(src/) 내보내기 — 2026-09-22(18차) 2·9절.
 *
 * 판매용 새 앱(src/design/)은 로그인·결제·동기화를 이 서버의 /api/…에
 * 같은 주소(같은 origin)로 요청한다. 그래서 "대표 주소 하나로 새 앱이
 * 열리고 API도 되는" 구성은 화면과 API가 한 서버(또는 한 주소 뒤)에 있어야
 * 한다. 이 모듈은 SERVE_STATIC=true일 때만 켜지고(기본 꺼짐 — 예전 동작
 * 그대로), 켜면:
 *   - "/"  → 302 "/design/"  (대표 주소 = 새 앱)
 *   - "/design" → 302 "/design/"  (상대경로 자산이 맞게 풀리도록)
 *   - "/design/" → design/index.html
 *   - 그 밖의 경로는 src/ 안의 실제 파일만(경로 탈출·숨김 파일 거부)
 * 옛 앱(src/index.html)과 그 사용자 데이터는 지우거나 옮기지 않았다 —
 * 대표 주소에서 안내하지 않을 뿐, 주소를 직접 열면 그대로 열린다.
 * 결제 복귀(successUrl = 지금 페이지 경로 + ?tossResult=…)·공유 수신
 * (design/manifest의 share_target "./index.html")·설치형 앱 시작 경로
 * (start_url "./index.html")는 전부 /design/ 아래 상대경로라 그대로 동작한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const STATIC_ROOT = path.resolve(HERE, '..', 'src');

const REDIRECTS = new Map([['/', '/design/'], ['/design', '/design/']]);
const ALIASES = new Map([['/design/', 'design/index.html']]);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function resolveSafe(pathname) {
  let clean;
  try { clean = decodeURIComponent(pathname); } catch (e) { return null; }
  if (clean.includes('\0')) return null;
  const rel = (ALIASES.get(clean) || clean).replace(/^\/+/, '');
  if (rel.split('/').some((seg) => seg.startsWith('.'))) return null; // 숨김 파일·상위 경로 거부
  const full = path.resolve(STATIC_ROOT, rel);
  if (full !== STATIC_ROOT && !full.startsWith(STATIC_ROOT + path.sep)) return null;
  return full;
}

/* 처리했으면 true. /api/… 는 절대 여기서 처리하지 않는다(호출부가 거른다). */
export function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const target = REDIRECTS.get(url.pathname);
  if (target) {
    // 쿼리(결제 복귀·공유 수신 값)는 그대로 넘긴다.
    res.writeHead(302, { Location: target + (url.search || ''), 'Cache-Control': 'no-cache' });
    res.end();
    return true;
  }
  const full = resolveSafe(url.pathname);
  if (!full) return false;
  let stat;
  try { stat = fs.statSync(full); } catch (e) { return false; }
  if (!stat.isFile()) return false;
  const ext = path.extname(full).toLowerCase();
  const type = MIME[ext];
  if (!type) return false;
  // 화면 문서·서비스워커는 매번 새로 확인(배포 직후 옛 버전 고착 방지),
  // 나머지(스크립트·스타일은 ?v=로 버전이 바뀜)는 짧게만 캐시.
  const cache = (ext === '.html' || ext === '.webmanifest' || path.basename(full) === 'sw.js') ? 'no-cache' : 'public, max-age=300';
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' });
  if (req.method === 'HEAD') { res.end(); return true; }
  fs.createReadStream(full).pipe(res);
  return true;
}
