/**
 * Zero-dependency, loopback-only server for Playwright against the official
 * Angular build. It exposes only apps/web/dist/blog-web/browser; no API,
 * database, authentication, session or public deployment is started.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../apps/web/dist/blog-web/browser/', import.meta.url)));
const types = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.webp', 'image/webp'],
  ['.woff2', 'font/woff2'],
]);
const server = createServer(async (request, response) => {
  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const normalized = decodeURIComponent(pathname);
    if (normalized.includes('\0')) {
      response.writeHead(400).end();
      return;
    }
    const destination = resolve(root, '.' + normalized);
    if (destination !== root && !destination.startsWith(root + sep)) {
      response.writeHead(403).end();
      return;
    }
    let candidate = destination === root ? resolve(root, 'index.html') : destination;
    try {
      const info = await stat(candidate);
      if (!info.isFile()) throw new Error('not a file');
    } catch {
      if (extname(normalized)) {
        response.writeHead(404).end();
        return;
      }
      candidate = resolve(root, 'index.html'); // Angular's client-side /admin
    }
    const data = await readFile(candidate);
    response.writeHead(200, {
      'Content-Type': types.get(extname(candidate)) ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(request.method === 'HEAD' ? undefined : data);
  } catch (error) {
    console.error('Static test server error:', error instanceof Error ? error.message : 'unknown');
    response.writeHead(500).end();
  }
});
server.listen(4173, '127.0.0.1', () => {
  process.stdout.write('Playwright CMS preview at http://127.0.0.1:4173\n');
});
