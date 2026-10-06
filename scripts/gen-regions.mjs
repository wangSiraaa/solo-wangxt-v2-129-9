// 生成不规则宫：先构造蛇形 Hamiltonian path，再反复做 2-opt 矩形翻转。
// 每次翻转后都严格验证路径仍是覆盖 81 格的单条 Hamiltonian path
// （81 格不重复、相邻格正交相邻），不合法立即回滚。
// 最后沿路径每 9 格切一段；每段沿路径连通、恰好 9 格。
export function generateJigsawRegions(seed = 7, flips = 600) {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const N = 9;
  const rc = (r, c) => r * N + c;
  const rowOf = (i) => Math.floor(i / N);
  const colOf = (i) => i % N;
  const orthAdj = (u, v) => Math.abs(rowOf(u) - rowOf(v)) + Math.abs(colOf(u) - colOf(v)) === 1;

  const snake = () => {
    const p = [];
    for (let r = 0; r < 9; r++)
      for (let c = 0; c < 9; c++) p.push(rc(r, r % 2 === 0 ? c : 8 - c));
    return p;
  };

  const isHamiltonian = (p) => {
    if (p.length !== 81) return false;
    if (new Set(p).size !== 81) return false;
    for (let k = 1; k < 81; k++) if (!orthAdj(p[k - 1], p[k])) return false;
    return true;
  };

  // 候选边对（有向无关）：两条横边在任意两行、同列跨度；两条竖边同理。
  const hcands = [];
  for (let r1 = 0; r1 < 9; r1++)
    for (let r2 = r1 + 1; r2 < 9; r2++)
      for (let c1 = 0; c1 < 8; c1++)
        hcands.push([rc(r1, c1), rc(r1, c1 + 1), rc(r2, c1), rc(r2, c1 + 1)]);
  const vcands = [];
  for (let c1 = 0; c1 < 9; c1++)
    for (let c2 = c1 + 1; c2 < 9; c2++)
      for (let r1 = 0; r1 < 8; r1++)
        vcands.push([rc(r1, c1), rc(r1 + 1, c1), rc(r1, c2), rc(r1 + 1, c2)]);

  let path = snake();
  const posOf = (p) => {
    const pos = new Array(81).fill(0);
    p.forEach((cell, i) => (pos[cell] = i));
    return pos;
  };

  let accepted = 0;
  for (let round = 0; round < 12 && accepted < flips; round++) {
    const all = [...hcands, ...vcands];
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }
    for (const [a, b, c, d] of all) {
      if (accepted >= flips) break;
      const result = attemptFlip(path, a, b, c, d);
      if (result) { path = result; accepted++; }
    }
  }

  function attemptFlip(cur, a, b, c, d) {
    const pos = posOf(cur);
    if (Math.abs(pos[a] - pos[b]) !== 1) return null;
    if (Math.abs(pos[c] - pos[d]) !== 1) return null;
    // 边沿路径方向规范化
    let e1 = pos[a] < pos[b] ? [a, b] : [b, a];
    let e2 = pos[c] < pos[d] ? [c, d] : [d, c];
    if (pos[e1[0]] > pos[e2[0]]) [e1, e2] = [e2, e1];
    const [u, v] = e1;
    const [w, z] = e2;
    const i1 = pos[u], i2 = pos[v], i3 = pos[w], i4 = pos[z];
    if (!(i2 + 1 <= i3)) return null; // 已按位置排序：i1 < i2 < i3 < i4

    // 两种 2-opt 重接（去掉 uv、wz 两条边后）：
    //  A: u-w, v-z；B: u-z, v-w
    const modes = [];
    if (orthAdj(u, w) && orthAdj(v, z)) modes.push(0);
    if (orthAdj(u, z) && orthAdj(v, w)) modes.push(1);
    if (!modes.length) return null;

    for (const mode of modes) {
      const next = [...cur];
      if (mode === 0) {
        // 模式 A：反转闭区间 [i2, i3]
        //   ...u, w, reverse(i2+1..i3-1), v, z...
        //   新边 u-w（正交）、v-z（正交）
        const seg = next.slice(i2, i3 + 1);
        seg.reverse();
        for (let k = 0; k < seg.length; k++) next[i2 + k] = seg[k];
      } else {
        // 模式 B：反转闭区间 [i2, i4]
        //   ...u, z, w, reverse(i2+1..i3-1), v...
        //   新边 u-z（正交）、v-w（正交）
        const seg = next.slice(i2, i4 + 1);
        seg.reverse();
        for (let k = 0; k < seg.length; k++) next[i2 + k] = seg[k];
      }
      if (isHamiltonian(next)) return next;
    }
    return null;
  }

  const regions = new Array(81).fill(-1);
  path.forEach((cell, idx) => { regions[cell] = Math.floor(idx / 9); });
  return regions;
}
