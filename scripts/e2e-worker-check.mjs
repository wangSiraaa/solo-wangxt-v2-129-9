#!/usr/bin/env node
// 端到端冒烟：真实 Chromium 验证"Worker 中的可取消双次检查"。
// 前置：npm run build（产出 dist/）；浏览器由 `npx playwright install chromium` 提供。
// 运行：node scripts/e2e-worker-check.mjs
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const PORT = 4100 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${PORT}`;

function startServer() {
  const srv = spawn(process.execPath, ['scripts/serve.mjs', 'dist', String(PORT)], {
    stdio: 'pipe'
  });
  return new Promise((resolve, reject) => {
    srv.stdout.on('data', (d) => {
      if (String(d).includes('serving')) resolve(srv);
    });
    srv.stderr.on('data', (d) => process.stderr.write(d));
    srv.on('error', reject);
    srv.on('exit', (code) => reject(new Error(`server exited early (${code})`)));
    setTimeout(() => reject(new Error('server start timeout')), 10000);
  });
}

let passed = 0;
function ok(name, cond, extra = '') {
  if (!cond) {
    console.error(`  ✗ ${name} ${extra}`);
    process.exitCode = 1;
    throw new Error(`断言失败: ${name}`);
  }
  console.log(`  ✓ ${name}`);
  passed++;
}

const server = await startServer();
const browser = await chromium.launch();
try {
  const page = await (await browser.newContext()).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });

  const checkBtn = () => page.getByRole('button', { name: '检查可解性与唯一解' });
  const cancelBtn = () => page.getByRole('button', { name: '取消', exact: true });

  // ---- A. 正常唯一解样例：两次检查都完成，判定唯一 ----
  console.log('A. 唯一解样例完成两次检查');
  await page.goto(BASE);
  await checkBtn().waitFor({ timeout: 60000 }); // 等 Worker 内 Z3 就绪
  await checkBtn().click();
  await page.locator('.badge.unique').waitFor({ timeout: 60000 });
  ok('唯一解徽章出现', await page.locator('.badge.unique').isVisible());

  // ---- B. 取消第二次检查：只记录"未判定" ----
  console.log('B. 取消检查 -> 未判定');
  await checkBtn().click();
  await cancelBtn().waitFor({ timeout: 10000 });
  // 让任务进入 check1/check2 阶段再取消（Z3 求解中，Worker 被 terminate）
  await page.locator('.phase').waitFor({ timeout: 10000 });
  await cancelBtn().click();
  await page.locator('.badge.unknown').waitFor({ timeout: 10000 });
  ok('取消后显示未判定', await page.locator('.badge.unknown').isVisible());
  ok(
    '提示"检查已取消"',
    await page.getByText('检查已取消', { exact: false }).first().isVisible()
  );

  // ---- C. 检查期间修改题面：旧结果不得回写 ----
  console.log('C. 检查中修改题面 -> 旧结果丢弃');
  await checkBtn().click();
  await cancelBtn().waitFor({ timeout: 10000 });
  const canvas = page.locator('canvas[role="grid"]');
  await canvas.click({ position: { x: 28, y: 28 } }); // 选中 R1C1
  await page.keyboard.press('5'); // 改动一个提示 => 旧任务作废
  await delay(2000); // 等足够久（一次完整求解的时间），确认没有旧结果回写
  ok('修改后无结论徽章残留', (await page.locator('.badge').count()) === 0);

  // ---- D. 草稿保存/刷新：只保留与指纹相符的结论 ----
  console.log('D. 草稿结论与指纹绑定');
  // C 中改过题面，先重新载入唯一解样例（同时验证换题会作废旧任务）
  await page.getByRole('button', { name: '载入标准题' }).click();
  await checkBtn().click();
  await page.locator('.badge.unique').waitFor({ timeout: 60000 });
  await page.getByRole('button', { name: '保存' }).click();
  await page.getByText('已保存', { exact: false }).waitFor({ timeout: 10000 });
  await page.reload();
  await page.locator('.drafts .open').first().click();
  await page.locator('.badge.unique').waitFor({ timeout: 10000 });
  ok('刷新后重开草稿：指纹相符，唯一解结论恢复', true);

  // 改动题面再保存：结论应与旧指纹一起失效
  await canvas.click({ position: { x: 28, y: 28 } });
  await page.keyboard.press('6');
  await page.getByRole('button', { name: '保存' }).click();
  await page.getByText('已保存', { exact: false }).waitFor({ timeout: 10000 });
  await page.reload();
  await page.locator('.drafts .open').first().click();
  await delay(500);
  ok('题面变更后：旧结论不再恢复', (await page.locator('.badge').count()) === 0);

  const fatal = errors.filter((e) => !e.includes('favicon'));
  ok('无页面级 JS 错误', fatal.length === 0, fatal.join('\n'));

  console.log(`\n全部通过（${passed} 项断言）`);
} finally {
  await browser.close();
  server.kill();
}
