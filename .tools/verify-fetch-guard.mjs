#!/usr/bin/env node
/**
 * verify-fetch-guard.mjs —— fetch-data 回归闸的判定逻辑回归（2026-10-31）。
 *
 * 守的是 .tools/fetch-data.js 的 `regressDecision`（纯函数）：
 *   · 原规则：新份数 < 上一份 × 0.7 且上一份够新（<6h）→ 拒绝覆盖（防抖动劣化）
 *   · 2026-10-31 新增格式维度：上一份是**旧格式**（整份无 image 字段）时，不得靠条数
 *     压住**新格式**（带配图）快照 —— 实测盲区：凌晨抓取 207 条被 gh-pages 旧兜底
 *     417 条（无配图）压住，而配图覆盖率是发布门禁 D2 的硬要求。
 *
 * 提取方式：fetch-data.js 顶层直接 main()（无 require.main 守卫），整文件执行会联网 ——
 * 所以按源码标记切片（`function imageRatio` 起、`/** 返回 null 表示允许写入` 止），
 * 只 eval 这两个纯函数。切片标记挪动时本 harness 会以「导出缺失」FAIL，属预期。
 *
 * 用法: node .tools/verify-fetch-guard.mjs
 * 退出码: 0 全绿；1 有断言失败；2 harness 自身出错
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const src = readFileSync(path.join(ROOT, '.tools', 'fetch-data.js'), 'utf8');

const START = src.indexOf('const REGRESS_RATIO');
const END_MARK = src.indexOf('/** 返回 null 表示允许写入');
if (START < 0 || END_MARK < 0 || END_MARK <= START) {
  console.error('harness 自身出错：fetch-data.js 里找不到切片标记（REGRESS_RATIO → guardRegression 之间）');
  process.exit(2);
}
const slice = src.slice(START, END_MARK);
const sandbox = { console, JSON, Math, Date, Number, String, Array, Object, RegExp };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(slice + '\nglobalThis.__g = { regressDecision, imageRatio };', sandbox, { filename: 'fetch-data-guard-slice.js' });
const { regressDecision, imageRatio } = sandbox.__g;

let passes = 0;
let failures = 0;
const check = (name, desc, cond) => {
  if (cond === true) { passes += 1; console.log(`  PASS  ${name}  ${desc}`); }
  else { failures += 1; console.log(`  FAIL  ${name}  ${desc}`); }
};
const mk = (n, withImg) => Array.from({ length: n }, (_, i) => (withImg ? { id: i, title: `t${i}`, image: 'https://x/y.jpg' } : { id: i, title: `t${i}` }));
const HOUR = 3600 * 1000;

// ---------- 格式维度（2026-10-31 新规则） ----------
check('FG1', '旧格式上一份(417无图) 压不住 新格式抓取(207带图) → 放行（实测盲区钉死）',
  regressDecision({ items: mk(417, false) }, mk(207, true), 60 * 1000) === null);
check('FG2', '反方向是回退：有图上一份(417) 遇 无图新快照(100) → 拒绝',
  typeof regressDecision({ items: mk(417, true) }, mk(100, false), 60 * 1000) === 'string');
check('FG3', '同格式条数回归照拦：417带图 vs 100带图（<70%）→ 拒绝',
  typeof regressDecision({ items: mk(417, true) }, mk(100, true), 60 * 1000) === 'string');

// ---------- 原规则保留 ----------
check('FG4', '条数达标（≥70%）→ 放行', regressDecision({ items: mk(417, true) }, mk(300, true), 60 * 1000) === null);
check('FG5', '上一份已过新鲜窗口（≥6h）→ 放行（宁可少也不钉死陈旧快照）',
  regressDecision({ items: mk(417, true) }, mk(50, true), 6 * HOUR) === null);
check('FG6', '上一份 items 空/缺失 → 放行（无基准）',
  regressDecision({ items: [] }, mk(10, true), 60 * 1000) === null &&
  regressDecision({}, mk(10, true), 60 * 1000) === null);
check('FG7', '时钟回拨（ageMs 为负）→ 保守放行', regressDecision({ items: mk(417, true) }, mk(50, true), -1000) === null);
check('FG8', '拒绝原因人类可读（含两组条数与百分比）',
  String(regressDecision({ items: mk(100, true) }, mk(30, true), 60 * 1000)).includes('100') &&
  String(regressDecision({ items: mk(100, true) }, mk(30, true), 60 * 1000)).includes('70%'));
check('FG9', 'imageRatio 边界：空/缺失 → 0', imageRatio([]) === 0 && imageRatio(undefined) === 0);

console.log(`\nPASS ${passes} / FAIL ${failures}`);
process.exit(failures === 0 ? 0 : 1);
