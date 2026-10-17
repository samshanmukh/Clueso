import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../settings.ts';
import { registerFixtureOrigin } from '../scan/scanner.ts';

const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

/** Serves /fixtures/<app>/... (labels.json is never served). Returns true if handled. */
export function serveFixture(req: http.IncomingMessage, res: http.ServerResponse, root = config.fixturesDir): boolean {
  const u = new URL(req.url ?? '/', 'http://x');
  if (!u.pathname.startsWith('/fixtures/')) return false;
  const rel = decodeURIComponent(u.pathname.slice('/fixtures/'.length));
  if (rel.includes('..') || rel.startsWith('labels') || !/^app-[a-z]\//.test(rel)) { res.writeHead(404).end(); return true; }
  let file = path.join(root, rel);
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404).end('not found'); return true; }
  res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
  return true;
}

/** Standalone fixture server on an ephemeral (or given) port. */
export function startFixtureServer(port = 0, root = config.fixturesDir): Promise<{ base: string; close: () => void }> {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => { if (!serveFixture(req, res, root)) res.writeHead(404).end(); });
    s.listen(port, '127.0.0.1', () => {
      const a = s.address() as any;
      registerFixtureOrigin(`http://localhost:${a.port}`);
      resolve({ base: `http://localhost:${a.port}/fixtures`, close: () => s.close() });
    });
  });
}
