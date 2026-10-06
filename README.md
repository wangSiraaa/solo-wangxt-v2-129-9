# 不规则宫温度计 数独作者工作室（Thermo-Jigsaw Sudoku Studio）

纯浏览器运行的**逻辑谜题作者工具**（不是给玩家只求解一次答案的工具）。
作者在 9×9 画布上编辑**不规则宫（jigsaw regions）**、**提示数字**与
**温度计（thermometers）**约束，由内置的 **Z3 WASM** 在本地检查
**可解性**与**唯一解**；题稿保存在浏览器 **IndexedDB**，**无后台服务**。

## 核心设计：唯一解必须"排除首解再求"

检查流程（`src/lib/solver.ts`）对题目做**两次** SAT 检查：

1. `check 1`：
   - `unsat` → **无解**，同时提取导致矛盾的约束组（unsat core）；
   - `unknown` → **未判定**（超时），如实显示；
   - `sat` → 得到首解 M1，**此时不能宣称唯一**。
2. 追加"至少有一格取与 M1 不同的值"这一析取（`∨ ¬x[i][M1[i]]`）后 `check 2`：
   - `unsat` → M1 之外不存在解 ⇒ **唯一解**；
   - `sat` → 得到第二个不同的解 ⇒ **多解**；
   - `unknown` → 已找到一个解但无法在时限内排除其他解 ⇒ **未判定**。

任何一次 `check` 超时都显示"未判定"，绝不把"只找到一次结果"当成唯一。

## 求解前的结构校验（`src/lib/puzzle.ts`）

在调用 Z3 之前先做与可解性无关的"语法层"校验，错误会在画布高亮：

- **宫区覆盖**：每格归属 0–8 号宫；每宫恰好 9 格且**边连通**；无空宫。
- **格子范围**：提示值必须是 0–9 的整数；宫编号在 0–8 内；下标合法。
- **温度计自交规则**：路径长度 ≥ 2；无越界格；**同一支温度计中格子不得重复
  （自交）**；相邻步必须上下左右正交相邻（不可斜走/跨步）。

## 矛盾核（unsat core）

每个人类可读的约束块（某条提示、温度计某段、行/列/宫数字覆盖等）通过
`solver.addAndTrack(expr, label)` 挂一个布尔标签。无解时用
`solver.unsatCore()` 取回一组**足以导致矛盾的约束**，在面板中列出并可定位到格子。

例如无解题样例的矛盾核精确为：

- 提示 `R1C1 = 9`
- 温度计 `R1C1 < R2C1（水银柱自泡端严格递增）`

（9 之后没有更大数字，二者直接冲突。）

## 改一个提示 → 旧结论失效

每次检查记录所针对题面的指纹（`puzzleFingerprint`）。题面一旦改动（哪怕只改一个
提示、一格宫色或一支温度计），`EditorState.revalidate()` 立即把结论复位为
"未检查"，必须重新运行检查。`src/lib/state.test.ts` 覆盖了这一规则。

## 导出题面不泄露答案层

- IndexedDB 草稿（`DraftRecord`）保存作者私有数据：题面 + 最近一次检查结论（可能
  含首解）+ 指纹，全部只在本地。
- `exportPuzzle()` 导出的题面 JSON 只含 `regions / givens / thermometers`
  （`kind: "puzzle"`），**不含** `solution / witness / lastCheck` 等任何答案层字段；
  有单测断言导出对象的键集合。

## 内置样例（均经 Z3 双重 check 验证）

- **标准题**：真·不规则宫 + 2 支温度计 + 13 个提示 → `unique`。
- **无解题**：bulb 给定 9 与递增温度计矛盾 → `unsat`（含矛盾核）。
- **多解题**：仅 2 个提示、无温度计 → 排除首解后仍有二解，`multiple`。
- 生成脚本还验证：把标准题的一个提示改成别的值后，判定从 `unique` 变为
  `multiple/unsat`，即旧结论失效。

样例数据由脚本生成并固化：

```bash
node scripts/gen-samples.mjs   # 生成不规则宫、最小化提示，双重 check 验证后写 src/lib/sample-data.ts
```

不规则宫通过"蛇形 Hamiltonian path + 矩形 2-opt 翻转 + 每 9 格切段"构造，
保证每宫 9 格且边连通；并且**只保留经 Z3 证明存在数独解的分区**（任意"9 个
连通 9 格宫"的分区并不一定可解——本项目在构造时就筛掉了这种分区）。

## 技术栈

- Svelte 5（runes）+ TypeScript 编辑界面
- Canvas 2D 绘制格线、不规则宫边界、温度计（泡/管/帽）与高亮
- `z3-solver` 的 WASM（pthreads）构建做 SAT 判定
- IndexedDB 保存题稿；JSON 导入/导出题面
- Vite 构建、Vitest 单测

## 运行

```bash
npm install        # 会自动把 z3 的 wasm 产物复制到 public/vendor
npm run dev        # 开发服务器（已带 COOP/COEP 头）
npm test           # 21 个单测（含 Z3 对三类样例的判定）
npm run check      # svelte-check 类型检查
npm run build      # 产出 dist/
node scripts/serve.mjs dist   # 以 COOP/COEP 头本地预览
```

> Z3 的 pthreads WASM 需要 `SharedArrayBuffer`，页面必须带
> `Cross-Origin-Opener-Policy: same-origin` 与
> `Cross-Origin-Embedder-Policy: require-corp` 响应头。`vite dev` 与
> `scripts/serve.mjs` 都已配置；若部署到其它静态主机，请自行加上这两个响应头。
> `z3-built.js` / `z3-built.wasm` 必须作为独立静态资源由 `index.html` 直接加载，
> 不能被打包器合并。

## 目录

```
src/lib/puzzle.ts        # 领域模型 + 结构校验 + 导入导出
src/lib/solver.ts        # Bool CNF 编码、addAndTrack 标注、两次 check、矛盾核
src/lib/z3-init.ts       # 浏览器(全局 initZ3)/Node 双入口初始化
src/lib/samples.ts       # 三类样例
src/lib/sample-data.ts   # 生成脚本固化的数据（无答案层）
src/lib/storage.ts       # IndexedDB 题稿
src/lib/state.svelte.ts  # 编辑器状态、指纹失效
src/components/*         # Canvas / 工具栏 / 检查面板 / 草稿 / 导入导出
scripts/gen-regions.mjs  # 不规则宫生成
scripts/gen-samples.mjs  # 样例生成 + 双重 check 验证
scripts/copy-z3.mjs      # 复制 wasm 产物
scripts/serve.mjs        # 带 COOP/COEP 头的静态服务器
```
