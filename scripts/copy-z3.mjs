#!/usr/bin/env node
// 将 z3-solver 的 emscripten 产物复制到 public/vendor。
// 这些文件必须作为独立静态资源加载（不能进 bundle）：
//   z3-built.js  在页面中以 <script> 引入，注册全局 initZ3
//   z3-built.wasm 由 z3-built.js 按同目录路径 fetch，并派生 worker
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcDir = join(root, 'node_modules', 'z3-solver', 'build');
const outDir = join(root, 'public', 'vendor');

mkdirSync(outDir, { recursive: true });
for (const file of ['z3-built.js', 'z3-built.wasm']) {
  copyFileSync(join(srcDir, file), join(outDir, file));
  console.log(`copied vendor/${file}`);
}
