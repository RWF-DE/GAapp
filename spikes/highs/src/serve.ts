// 静的ファイルを GitHub Pages と同じように /<repo>/ の下で配信する（gzip、max-age=600、wasm は application/wasm）
import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { extname, join, normalize } from 'node:path';

export const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.txt': 'text/plain', '.json': 'application/json' };
export type ReqLog = { url: string; status: number; type: string }[];
export async function startServer(dist: string, base: string, port: number) {
  const reqLog: ReqLog = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, `http://localhost:${port}`);
    let status = 404, type = '';
    if (url.pathname.startsWith(base)) {
      let rel = decodeURIComponent(url.pathname.slice(base.length));
      if (rel === '' || rel.endsWith('/')) rel += 'index.html';
      rel = normalize(rel).replace(/^(\.\.[/\\])+/, '');
      const p = join(dist, rel);
      if (existsSync(p) && statSync(p).isFile()) {
        status = 200; type = MIME[extname(p)] ?? 'application/octet-stream';
        const gz = /\bgzip\b/.test(String(req.headers['accept-encoding'])) && !type.startsWith('text/html');
        const headers: Record<string, string> = { 'content-type': type, 'cache-control': 'max-age=600' };
        reqLog.push({ url: url.pathname, status, type });
        if (gz) { const body = gzipSync(readFileSync(p), { level: 6 }); headers['content-encoding'] = 'gzip'; headers['content-length'] = String(body.length); res.writeHead(200, headers); res.end(body); }
        else { res.writeHead(200, headers); createReadStream(p).pipe(res); }
        return;
      }
    }
    reqLog.push({ url: url.pathname, status, type });
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found');
  });
  await new Promise<void>((r) => server.listen(port, r));
  return { server, reqLog };
}
