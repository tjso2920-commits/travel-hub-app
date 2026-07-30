import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SOURCE = path.join(ROOT, '01_SOURCE');
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const PERSONAL = '커팅트래커_개인용.html';
const SALES = '후쿠오카_통합앱_판매용.html';

const aliases = new Map([
  ['/', PERSONAL],
  ['/index.html', PERSONAL],
  ['/personal.html', PERSONAL],
  ['/sales.html', SALES]
]);

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

function safeFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const alias = aliases.get(clean);
  if (alias) return path.join(SOURCE, alias);
  const relative = clean.replace(/^\/+/, '');
  const candidate = path.resolve(SOURCE, relative);
  return candidate === SOURCE || candidate.startsWith(`${SOURCE}${path.sep}`) ? candidate : null;
}

const server = http.createServer((request, response) => {
  let file;
  try {
    file = safeFile(request.url || '/');
  } catch {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('잘못된 요청');
    return;
  }

  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('파일을 찾을 수 없습니다');
    return;
  }

  response.writeHead(200, {
    'Content-Type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  fs.createReadStream(file).pipe(response);
});

server.listen(PORT, HOST, () => {
  console.log(`개인용: http://localhost:${PORT}/`);
  console.log(`판매용: http://localhost:${PORT}/sales.html`);
  console.log('종료: Ctrl+C');
});

