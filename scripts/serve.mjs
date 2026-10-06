#!/usr/bin/env node
// 纯 Node 静态服务器，为 Z3 WASM 的 SharedArrayBuffer 附加 COOP/COEP 响应头。
// 用法：node scripts/serve.mjs [dist 或 public 根目录] [端口]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootArg = process.argv[2] || 'dist';
const port = Number(process.argv[3] || 4173);
const root = fileURLToPath(new URL(`../${rootArg}`, import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml'
};

createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let filePath = normalize(join(root, urlPath === '/' ? 'index.html' : urlPath));
    if (!filePath.startsWith(root)) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    const data = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
      // Z3 pthreads 需要
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' });
    res.end('not found');
  }
}).listen(port, () => {
  console.log(`serving ${rootArg} at http://localhost:${port} (COOP/COEP enabled)`);
});
