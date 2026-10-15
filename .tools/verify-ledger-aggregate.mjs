#!/usr/bin/env node
/**
 * verify-ledger-aggregate.mjs —— 记账聚合逻辑回归。
 *
 * 为什么必须测：记账算错钱是**用户直接受损**的错误（不像 UI 色差）——
 * 少算/多算会让用户按错误数字做消费决策。且晨报卡片与记账页**共用**这份聚合，
 * 一处错则两处一起错。
 *
 * 重点覆盖三类容易出错的：
 *   1. **浮点** ——0.1+0.2 必须等于 0.30，不能是 0.30000000000000004
 *   2. **跨月/跨年边界** —— 1 月的上月是「去年 12 月」，手写字符串减法必错
 *   3. **语义边界** —— 昨日支出为 0 时delta 必须是 null（不能报百分比）
 *
 * 编译方式同 verify-extract-coerce.mjs：esbuild 编译 **src 源码**再跑。
 * ⚠️ 不要从 dist 抠源码 —— terser 会重命名字局变量（2026-10-15 踩过）。
 *
 * 用法: node .tools/verify-ledger-aggregate.mjs [--json]
 * 退出码: 0 = 全通过；1 = 有用例失败；2 = harness 自身出错
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import esbuild from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src', 'utils', 'ledgerAggregate.ts');
const asJson = process.argv.includes('--json');

const source = readFileSync(SRC, 'utf8');

/**
 * 直接**整体编译** src/utils/ledgerAggregate.ts（追加一段取导出的尾巴）。
 *
 * ⚠️ 为什么不用「按函数名截源码再拼」（另一个 harness 用的做法）：
 *   这份文件里有 `): { id: string; name: string; ... } {` 这种**跨行返回类型标注**，
 *   按大括号配平截取会在函数体开始前就归零 → 截出残缺代码 →
 *   求值报 "resolveCategory is not defined"（2026-10-15 踩了两次才对）。
 *   该模块**只有一条 `import type`**（编译时擦除，零运行时依赖），
 *   所以能直接整体编译 —— 不需要任何截取技巧，稳得多。
 */
const HARNESS_TAIL = `
globalThis.__lg = { todayStr, currentMonthStr, prevMonthStr, yesterdayStr, filterByRange, summarize, buildTodayBrief, resolveCategory };
`;

const built = await esbuild.build({
  stdin: { contents: source + HARNESS_TAIL, loader: 'ts', resolveDir: path.dirname(SRC) },
  bundle: true,
  format: 'iife',
  platform: 'neutral',
  write: false,
  minify: false,
  treeShaking: false
}).catch((e) => {
  console.error('[FAIL] esbuild 失败：', e && e.message ? e.message : e);
  process.exit(2);
});

const sandbox = { console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
try {
  vm.runInContext(built.outputFiles[0].text, sandbox);
} catch (e) {
  console.error('[FAIL] 求值失败：', e && e.message ? e.message : e);
  process.exit(2);
}
const lg = sandbox.__lg;
if (!lg || typeof lg.summarize !== 'function') {
  console.error('[FAIL] 被测函数未就绪 —— harness 没跑到被测逻辑（这是 harness 问题，不是通过）。');
  process.exit(2);
}

/* ── 用例 ──────────────────────────────────────────────────── */
const results = [];
/**
 * ⚠️ 判据必须是 `ok === true`，**不能写 `!!ok`**（2026-10-15 在另一个 harness 上栽过）：
 *   失败分支返回的是说明原因的字符串，非空字符串 truthy → 失败被判成 PASS。
 *   这里统一只接受 `true`；非true 一律算失败并把内容当原因。 */
function t(name, fn) {
  try {
    const ok = fn();
    if (ok === true) results.push({ name, pass: true, why: '' });
    else results.push({ name, pass: false, why: ok ? String(ok) : `returned: ${String(ok)}` });
  } catch (e) {
    results.push({ name, pass: false, why: `threw: ${e.message}` });
  }
}

/** 造一条条目（测试内部用，与生产类型结构一致） */
const E = (amount, kind, date, categoryId = 'cat_food', id = 'x') => ({
  id, amount, kind, categoryId, date, createdAt: '2026-01-01T00:00:00.000Z'
});

/* 浮点 —— 记账最直接的算错风险 */
t('0.1 + 0.2 不产生浮点噪声（= 0.3）', () => {
  const r = lg.summarize([E(0.1, 'expense', '2026-01-01'), E(0.2, 'expense', '2026-01-01')]);
  return r.expense === 0.3 || `got ${r.expense}`;
});
t('多笔小数累加精确到分（0.01×3 = 0.03）', () => {
  const r = lg.summarize([E(0.01,'expense','2026-01-01'),E(0.01,'expense','2026-01-01'),E(0.01,'expense','2026-01-01')]);
  return r.expense === 0.03 || `got ${r.expense}`;
});
t('19.99 不会显示成 20.00 误差', () => {
  const r = lg.summarize([E(19.99, 'expense', '2026-01-01'), E(0.01, 'expense', '2026-01-01')]);
  return r.expense === 20 || `got ${r.expense}`;
});
t('金额四舍五入到分（3.456 → 3.46）', () => {
  const r = lg.summarize([E(3.456, 'expense', '2026-01-01')]);
  return r.expense === 3.46 || `got ${r.expense}`;
});
t('极小金额（0.001）四舍五入后为 0，不进榜', () => {
  const r = lg.summarize([E(0.001, 'expense', '2026-01-01')]);
  return r.expense === 0 && r.byCategory.length === 0 || `expense=${r.expense} cats=${r.byCategory.length}`;
});

/* 收支方向 */
t('收入不进支出合计', () => {
  const r = lg.summarize([E(100, 'income', '2026-01-01'), E(30, 'expense', '2026-01-01')]);
  return r.expense === 30 && r.income === 100 || `exp=${r.expense} inc=${r.income}`;
});
t('expenseCount 只数支出笔数', () => {
  const r = lg.summarize([E(10,'expense','2026-01-01'),E(20,'expense','2026-01-01'),E(99,'income','2026-01-01')]);
  return r.expenseCount === 2 || `got ${r.expenseCount}`;
});

/* 非法输入防护 */
t('0 元条目被忽略', () => {
  const r = lg.summarize([E(0, 'expense', '2026-01-01')]);
  return r.expense === 0 && r.expenseCount === 0 || `exp=${r.expense} n=${r.expenseCount}`;
});
t('负数条目被忽略（金额恒正）', () => {
  const r = lg.summarize([E(-50, 'expense', '2026-01-01')]);
  return r.expense === 0 || `got ${r.expense}`;
});
t('NaN 条目被忽略（不会污染整个和）', () => {
  const r = lg.summarize([E(NaN, 'expense', '2026-01-01'), E(10, 'expense', '2026-01-01')]);
  return r.expense === 10 || `got ${r.expense}`;
});
t('null / undefined 条目不崩', () => {
  const r = lg.summarize([null, undefined, E(10, 'expense', '2026-01-01')]);
  return r.expense === 10 || `got ${r.expense}`;
});

/* 分类分布 */
t('byCategory 按金额降序', () => {
  const r = lg.summarize([
    E(10, 'expense', '2026-01-01', 'a'), E(30, 'expense', '2026-01-01', 'b'), E(20, 'expense', '2026-01-01', 'c')
  ]);
  return r.byCategory.length === 3 && r.byCategory[0].categoryId === 'b' && r.byCategory[1].categoryId === 'c'
    || JSON.stringify(r.byCategory);
});
t('同分类多笔累加金额与笔数', () => {
  const r = lg.summarize([E(10,'expense','2026-01-01','a'), E(15,'expense','2026-01-01','a')]);
  return r.byCategory.length === 1 && r.byCategory[0].amount === 25 && r.byCategory[0].count === 2
    || JSON.stringify(r.byCategory[0]);
});
t('收入不出现在 byCategory（那是支出榜）', () => {
  const r = lg.summarize([E(100, 'income', '2026-01-01', 'salary')]);
  return r.byCategory.length === 0 || JSON.stringify(r.byCategory);
});

/* 日期区间 */
t('区间是闭区间（含起含止）', () => {
  const list = [E(1,'expense','2026-01-01'), E(2,'expense','2026-01-02'), E(3,'expense','2026-01-03')];
  return lg.filterByRange(list, '2026-01-01', '2026-01-02').length === 2 || '闭区间断言失败';
});
t('起止颠倒 → 空数组', () => {
  return lg.filterByRange([E(1,'expense','2026-01-01')], '2026-01-05', '2026-01-01').length === 0 || '应为空';
});
t('空 from/to → 空数组', () => {
  return lg.filterByRange([E(1,'expense','2026-01-01')], '', '').length === 0 || '应为空';
});

/* 跨月跨年边界 —— 手写字符串减法必错的地方 */
t('prevMonthStr：1 月 → 去年 12 月', () => {
  return lg.prevMonthStr(new Date(2026, 0, 15)) === '2025-12' || lg.prevMonthStr(new Date(2026, 0, 15));
});
t('prevMonthStr：3 月 → 2 月', () => {
  return lg.prevMonthStr(new Date(2026, 2, 15)) === '2026-02' || lg.prevMonthStr(new Date(2026, 2, 15));
});
t('prevMonthStr：12 月 → 11 月（同年内）', () => {
  return lg.prevMonthStr(new Date(2026, 11, 15)) === '2026-11' || lg.prevMonthStr(new Date(2026, 11, 15));
});
t('yesterdayStr：1 月 1 日 → 去年 12 月 31 日', () => {
  return lg.yesterdayStr(new Date(2026, 0, 1)) === '2025-12-31' || lg.yesterdayStr(new Date(2026, 0, 1));
});
t('yesterdayStr：3 月 1 日 → 2 月 28 日', () => {
  return lg.yesterdayStr(new Date(2026, 2, 1)) === '2026-02-28' || lg.yesterdayStr(new Date(2026, 2, 1));
});
t('todayStr 零填充（月份为 1 月 → 01）', () => {
  return lg.todayStr(new Date(2026, 0, 5)) === '2026-01-05' || lg.todayStr(new Date(2026, 0, 5));
});
t('currentMonthStr 格式 YYYY-MM', () => {
  return lg.currentMonthStr(new Date(2026, 8, 5)) === '2026-09' || lg.currentMonthStr(new Date(2026, 8, 5));
});

/* 预算判定 */
t('超日预算：严格大于才算超', () => {
  return lg.summarize([E(101,'expense','2026-01-01')], { daily: 100 }).overDaily === true || '应超';
});
t('恰好等于预算 → 不算超', () => {
  return lg.summarize([E(100,'expense','2026-01-01')], { daily: 100 }).overDaily === false || '等于不应算超';
});
t('未设预算 → 不算超', () => {
  return lg.summarize([E(9999,'expense','2026-01-01')], {}).overDaily === false || '未设不应算超';
});
t('只设月预算时daily 不误判', () => {
  return lg.summarize([E(50,'expense','2026-01-01')], { monthly: 100 }).overDaily === false || 'daily 不该超';
});
t('日预算与月预算独立判定', () => {
  const r = lg.summarize([E(150,'expense','2026-01-01')], { daily: 100, monthly: 200 });
  return r.overDaily === true && r.overMonthly === false || `d=${r.overDaily} m=${r.overMonthly}`;
});
t('**收入不抵扣预算**（超支按毛支出算）', () => {
  // 收了 1000 又花了 101，日预算 100 → 应算超支，而不是净额为负所以没超。
  // 抵扣会让「发了工资就永远不超支」，与预算的常识语义相反。
  const r = lg.summarize([E(1000,'income','2026-01-01'), E(101,'expense','2026-01-01')], { daily: 100 });
  return r.overDaily === true || `应超支，却得到 ${r.overDaily}`;
});

/*晨报 brief */
t('buildTodayBrief：昨日为 0 → delta 为 null（不报百分比）', () => {
  const now = new Date(2026, 8, 15);
  const b = lg.buildTodayBrief([E(50, 'expense', '2026-09-15')], {}, now);
  return b.deltaFromYesterday === null || `got ${b.deltaFromYesterday}`;
});
t('buildTodayBrief：今日多于昨日 → 正 delta', () => {
  const now = new Date(2026, 8, 15);
  const b = lg.buildTodayBrief([E(50,'expense','2026-09-15'), E(30,'expense','2026-09-14')], {}, now);
  return b.deltaFromYesterday === 20 || `got ${b.deltaFromYesterday}`;
});
t('buildTodayBrief：今日少于昨日 → 负 delta', () => {
  const now = new Date(2026, 8, 15);
  const b = lg.buildTodayBrief([E(10,'expense','2026-09-15'), E(30,'expense','2026-09-14')], {}, now);
  return b.deltaFromYesterday === -20 || `got ${b.deltaFromYesterday}`;
});
t('buildTodayBrief：只取今日，不含昨日与前日', () => {
  const now = new Date(2026, 8, 15);
  const b = lg.buildTodayBrief([E(50,'expense','2026-09-15'), E(30,'expense','2026-09-14'), E(70,'expense','2026-09-01')], {}, now);
  return b.expense === 50 || `got ${b.expense}`;
});
t('buildTodayBrief：topCategories 最多 3 条', () => {
  const now = new Date(2026, 8, 15);
  const list = ['a','b','c','d','e'].map((c, i) => E(50 - i, 'expense', '2026-09-15', c));
  const b = lg.buildTodayBrief(list, {}, now);
  return b.topCategories.length === 3 || `got ${b.topCategories.length}`;
});
t('buildTodayBrief：无记录 → count 0（卡片不渲染）', () => {
  const b = lg.buildTodayBrief([], {}, new Date(2026, 8, 15));
  return b.count === 0 || `got ${b.count}`;
});
t('buildTodayBrief：hasBudget 反映预算是否设了', () => {
  const now = new Date(2026, 8, 15);
  const a = lg.buildTodayBrief([], {}, now);
  const c = lg.buildTodayBrief([], { daily: 100 }, now);
  return a.hasBudget === false && c.hasBudget === true || `a=${a.hasBudget} c=${c.hasBudget}`;
});

/* 分类解析 */
t('未知分类 id → 占位分类（不渲染空白）', () => {
  const c = lg.resolveCategory([], 'ghost_id');
  return c.name === '未分类' || `got ${c.name}`;
});
t('已知分类 id → 返回真实分类', () => {
  const cats = [{ id: 'cat_food', name: '餐饮', icon: '🍜', kind: 'expense' }];
  const c = lg.resolveCategory(cats, 'cat_food');
  return c.name === '餐饮' && c.icon === '🍜' || `got ${c.name}/${c.icon}`;
});

/* ── 汇总 ──────────────────────────────────────────────────── */
const failed = results.filter((r) => !r.pass);
const out = { status: failed.length ? 'FAIL' : 'PASS', pass: results.length - failed.length, total: results.length, failures: failed };
if (asJson) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`\n记账聚合逻辑 —— ${out.status}  ${out.pass}/${out.total}`);
  for (const r of results) console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.why ? '  ← ' + r.why : ''}`);
}
process.exit(failed.length ? 1 : 0);