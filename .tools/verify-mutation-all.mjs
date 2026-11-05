#!/usr/bin/env node
/**
 * verify-mutation-all.mjs —— 自动发现变异用例并交给 mutation-verify.mjs 执行。
 *
 * 为什么要有它（2026-11-05）：
 *   `package.json` 的 `verify:mutation` 原来是一行硬编码的 50 个 `.tools/mutations-*.mjs` 清单。
 *   任何新增变异文件都要改这一行，而并发分支各自在**同一行尾部追加** ——
 *   #51 / #52 / #35 连续三次撞同一个冲突，说明这是设计缺陷，不是偶发。
 *   改成扫目录后，新增用例只要放进 `.tools/mutations-*.mjs` 就自动被执行，
 *   `package.json` 不再需要为每条用例改一次。
 *
 * 契约（与旧清单逐项等价）：
 *   · 发现规则：`.tools/` 下文件名匹配 `mutations-*.mjs` 的文件，**按文件名字典序排序**；
 *   · 集合必须与旧清单完全一致（多一个少一个都算失败，见 PR 的对照表）；
 *   · 发现的文件原样传给 `.tools/mutation-verify.mjs`（其基线先行 / 锚点 / 恢复校验语义不变）；
 *   · 发现 0 个文件 → 直接判失败（拒绝空跑假绿）。
 *
 * 用法：
 *   node .tools/verify-mutation-all.mjs           # 跑全部
 *   node .tools/verify-mutation-all.mjs --list    # 只列出发现结果（给门禁做集合校验）
 *
 * 退出码：同 mutation-verify.mjs；`--list` 恒 0（除非发现 0 个文件）。
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = path.join(REPO, '.tools');
const CASE_RE = /^mutations-.*\.mjs$/;

const files = readdirSync(TOOLS)
  .filter((f) => CASE_RE.test(f))
  .sort()
  .map((f) => '.tools/' + f);

if (process.argv.includes('--list')) {
  for (const f of files) console.log(f);
  console.log(`DISCOVERED ${files.length} files`);
  process.exit(files.length === 0 ? 2 : 0);
}

if (files.length === 0) {
  console.error('发现 0 个 mutations-*.mjs —— 拒绝空跑假绿');
  process.exit(2);
}
console.log(`DISCOVERED ${files.length} files`);
for (const f of files) console.log(`  · ${f}`);

const r = spawnSync(process.execPath, [path.join(TOOLS, 'mutation-verify.mjs'), ...files], {
  cwd: REPO,
  stdio: 'inherit',
  env: process.env
});
if (r.status === null) {
  console.error(`mutation-verify 被信号杀死/超时（signal=${r.signal}）—— 结果不确定，判失败`);
  process.exit(2);
}
process.exit(r.status);
