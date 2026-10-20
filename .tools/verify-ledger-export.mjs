#!/usr/bin/env node
/**
 * verify-ledger-export.mjs —— 记账导出逻辑回归（CSV / JSON / 文件名 / 接线）。
 *
 * 为什么必须测：导出是「一次生成、用户拿去用」的功能，错了没有第二次机会 ——
 * CSV 转义漏一个逗号，用户的 Excel 整行错列；公式注入不防，`=SUM(...)` 备注
 * 在 Excel 里会被当公式执行；BOM 不加，中文备注全是乱码。这些都不会抛异常，
 * 只有断言能抓住。
 *
 * 重点覆盖（对应 .tools/verify-ledger-aggregate.mjs 的纪律）：
 *   1. 表头逐字符精确匹配 + BOM 在首位
 *   2. RFC4180 转义（逗号 / 双引号 / 换行三种情形各自正确）
 *   3. 公式注入前置 '（= + - @ 四类开头）
 *   4. 排序（date/createdAt 双键降序 + 同键稳定）
 *   5. 机器口径 amount（两位小数、无 ¥、无千分位）
 *   6. categoryName 解析 + 「未分类」兜底
 *   7. JSON 信封五字段 / note 缺省即缺 key / budget 可为 {}
 *   8. 接线（api 薄包装、页面按钮、双端分支、i18n 中英双语八键）
 *
 * 编译方式同 verify-ledger-aggregate.mjs：esbuild 编译 **src 源码**再跑。
 * ⚠️ 不要从 dist 抠源码 —— terser 会重命名字局变量（2026-10-15 踩过）。
 * ⚠️ 判据必须是 `ok === true`，不能写 `!!ok`（失败分支返回的是原因字符串，
 *    非空字符串 truthy 会把失败判成 PASS）。
 *
 * 用法: node .tools/verify-ledger-export.mjs [--json] [--src <ledgerExport.ts 路径>]
 *   --src 供**变异验证**用：指向一份改坏的源码副本，断言必须把它抓住（FAIL）。
 *   接线/i18n 检查始终读仓库里的真实文件，不受 --src 影响。
 * 退出码: 0 = 全通过；1 = 有用例失败；2 = harness 自身出错
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import esbuild from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..');
const asJson = process.argv.includes('--json');
// --src 覆盖：变异验证时指向改坏的副本；缺省编译仓库真实源码
const srcArgIdx = process.argv.indexOf('--src');
const SRC =
  srcArgIdx > 0 && process.argv[srcArgIdx + 1]
    ? path.resolve(process.argv[srcArgIdx + 1])
    : path.join(ROOT, 'src', 'utils', 'ledgerExport.ts');

const source = readFileSync(SRC, 'utf8');

/**
 * 直接整体编译 src/utils/ledgerExport.ts（追加取导出的尾巴）。
 * 该模块只有一条 `import type`（编译时擦除，零运行时依赖），
 * 所以整体编译即可，不需要任何截取技巧 —— 与 aggregate harness 同思路。
 */
const HARNESS_TAIL = `
globalThis.__le = { buildLedgerCsv, buildLedgerExportJson, buildExportFilename };
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
const le = sandbox.__le;
if (!le || typeof le.buildLedgerCsv !== 'function' || typeof le.buildLedgerExportJson !== 'function' || typeof le.buildExportFilename !== 'function') {
  console.error('[FAIL] 被测函数未就绪 —— harness 没跑到被测逻辑（这是 harness 问题，不是通过）。');
  process.exit(2);
}

/* ── 用例 ──────────────────────────────────────────────────── */
const results = [];
/** ⚠️ 判据必须是 `ok === true`，不能写 `!!ok`（失败分支返回说明原因的字符串，
 *    非空字符串 truthy → 失败会被判成 PASS）。统一只接受 true。 */
function t(name, fn) {
  try {
    const ok = fn();
    if (ok === true) results.push({ name, pass: true, why: '' });
    else results.push({ name, pass: false, why: ok ? String(ok) : `returned: ${String(ok)}` });
  } catch (e) {
    results.push({ name, pass: false, why: `threw: ${e.message}` });
  }
}

/* 测试 fixtures（与生产类型结构一致） */
const CATS = [
  { id: 'cat_food', name: '餐饮', icon: '🍜', kind: 'expense' },
  { id: 'cat_salary', name: '工资', icon: '💰', kind: 'income' }
];
const E = (over) => ({
  id: 'lg-1',
  amount: 12.5,
  kind: 'expense',
  categoryId: 'cat_food',
  date: '2026-10-01',
  createdAt: '2026-10-01T10:00:00.000Z',
  ...over
});
/** 去掉 BOM 后按行拆（fixture 的 note 不含换行时行数才等于条目数+1） */
const bodyLines = (csv) => csv.replace(/^\uFEFF/, '').split('\n');
/** 取数据行（跳表头）按逗号拆的字段 —— fixture 不含逗号/引号/换行时可直接拆 */
const fieldsOf = (csv, rowIdx) => bodyLines(csv)[rowIdx + 1].split(',');

/* ── 表头 / BOM ── */
t('CSV 表头逐字符精确匹配', () => {
  const csv = le.buildLedgerCsv([E({})], CATS);
  const header = bodyLines(csv)[0];
  return header === 'id,date,kind,categoryId,categoryName,amount,note,createdAt' || `got: ${header}`;
});
t('UTF-8 BOM 在首位（Excel 打开中文不乱码）', () => {
  const csv = le.buildLedgerCsv([E({})], CATS);
  return csv.charCodeAt(0) === 0xfeff || `charCodeAt(0)=${csv.charCodeAt(0)}`;
});
t('BOM 只出现一次（在首位，不重复）', () => {
  const csv = le.buildLedgerCsv([E({ note: '午饭' })], CATS);
  return csv.split('\uFEFF').length === 2 || `出现 ${csv.split('\uFEFF').length - 1} 次`;
});

/* ── 行数与字段 ── */
t('行数 = 表头 + 条目数（含 note 缺省条目）', () => {
  const csv = le.buildLedgerCsv([E({ id: 'a' }), E({ id: 'b', note: '有备注' }), E({ id: 'c' })], CATS);
  return bodyLines(csv).length === 4 || `got ${bodyLines(csv).length} 行`;
});
t('空 entries → 只有表头一行', () => {
  const csv = le.buildLedgerCsv([], CATS);
  return bodyLines(csv).length === 1 || `got ${bodyLines(csv).length} 行`;
});
t('note 缺省 → 空字段（不出 undefined）', () => {
  const csv = le.buildLedgerCsv([E({ note: undefined })], CATS);
  const f = fieldsOf(csv, 0);
  return f[6] === '' || `note field: ${JSON.stringify(f[6])}`;
});
t('kind 原样输出（expense/income）', () => {
  const csv = le.buildLedgerCsv([E({ id: 'a', kind: 'expense' }), E({ id: 'b', kind: 'income' })], CATS);
  const f0 = fieldsOf(csv, 0);
  const f1 = fieldsOf(csv, 1);
  return f0[2] === 'expense' && f1[2] === 'income' || `got ${f0[2]} / ${f1[2]}`;
});

/* ── amount 机器口径 ── */
t('amount 恒为两位小数（12.5 → 12.50）', () => {
  const csv = le.buildLedgerCsv([E({ amount: 12.5 })], CATS);
  const f = fieldsOf(csv, 0);
  return f[5] === '12.50' || `got ${f[5]}`;
});
t('amount 整数也补 .00（80 → 80.00）', () => {
  const csv = le.buildLedgerCsv([E({ amount: 80 })], CATS);
  return fieldsOf(csv, 0)[5] === '80.00' || `got ${fieldsOf(csv, 0)[5]}`;
});
t('amount 不带千分位（1234.5 → 1234.50，不是 1,234.50）', () => {
  const csv = le.buildLedgerCsv([E({ amount: 1234.5 })], CATS);
  const f = fieldsOf(csv, 0)[5];
  return f === '1234.50' && !f.includes(',') || `got ${f}`;
});
t('amount 不带 ¥ 符号', () => {
  const csv = le.buildLedgerCsv([E({ amount: 9.9 })], CATS);
  const f = fieldsOf(csv, 0)[5];
  return f === '9.90' && !f.includes('¥') || `got ${f}`;
});
t('amount 恒正无负号（数据层保证为正，这里验口径）', () => {
  const csv = le.buildLedgerCsv([E({ amount: 0.1 })], CATS);
  const f = fieldsOf(csv, 0)[5];
  return /^\d+\.\d{2}$/.test(f) || `got ${f}`;
});

/* ── categoryName 解析与兜底 ── */
t('categoryName 按 categoryId 解析出真实名', () => {
  const csv = le.buildLedgerCsv([E({ categoryId: 'cat_food' })], CATS);
  return fieldsOf(csv, 0)[4] === '餐饮' || `got ${fieldsOf(csv, 0)[4]}`;
});
t('分类被删/脏 id → 「未分类」兜底', () => {
  const csv = le.buildLedgerCsv([E({ categoryId: 'cat_deleted' })], CATS);
  return fieldsOf(csv, 0)[4] === '未分类' || `got ${fieldsOf(csv, 0)[4]}`;
});
t('空 categories 数组 → 「未分类」（不崩）', () => {
  const csv = le.buildLedgerCsv([E({})], []);
  return fieldsOf(csv, 0)[4] === '未分类' || `got ${fieldsOf(csv, 0)[4]}`;
});

/* ── RFC4180 转义 ── */
t('note 含逗号 → 整体包双引号', () => {
  const csv = le.buildLedgerCsv([E({ note: '午饭,晚饭' })], CATS);
  const line = bodyLines(csv)[1];
  return line.includes('"午饭,晚饭"') || `line: ${line}`;
});
t('note 含双引号 → 包引号且内部 " → ""', () => {
  const csv = le.buildLedgerCsv([E({ note: '他说"你好"' })], CATS);
  const line = bodyLines(csv)[1];
  return line.includes('"他说""你好"""') || `line: ${line}`;
});
t('note 含换行 → 包引号且换行保留在字段内（不新增数据行）', () => {
  const csv = le.buildLedgerCsv([E({ id: 'a', note: '第一行\n第二行' }), E({ id: 'b' })], CATS);
  const raw = csv.replace(/^\uFEFF/, '');
  // 换行在引号内：物理行数 = 表头1 + a占2 + b占1 = 4，但逻辑数据行仍是 2
  const physical = raw.split('\n').length;
  return physical === 4 && raw.includes('"第一行\n第二行"') && raw.includes('\nb,') || `physical=${physical}`;
});
t('note 含 \r → 同样包引号', () => {
  const csv = le.buildLedgerCsv([E({ note: '回车\r测试' })], CATS);
  return csv.includes('"回车\r测试"') || '未包引号';
});
t('不含特殊字符的 note 不包引号（不过度转义）', () => {
  const csv = le.buildLedgerCsv([E({ note: '普通备注' })], CATS);
  return csv.includes(',普通备注,') || `line: ${bodyLines(csv)[1]}`;
});

/* ── 公式注入防护 ── */
t('note 以 = 开头 → 前置 \'', () => {
  const csv = le.buildLedgerCsv([E({ note: '=SUM(A1:A9)' })], CATS);
  const line = bodyLines(csv)[1];
  return line.includes("'=SUM(A1:A9)") || `line: ${line}`;
});
t('note 以 + 开头 → 前置 \'', () => {
  const csv = le.buildLedgerCsv([E({ note: '+1' })], CATS);
  return bodyLines(csv)[1].includes("'+1") || `line: ${bodyLines(csv)[1]}`;
});
t('note 以 - 开头 → 前置 \'', () => {
  const csv = le.buildLedgerCsv([E({ note: '-2' })], CATS);
  return bodyLines(csv)[1].includes("'-2") || `line: ${bodyLines(csv)[1]}`;
});
t('note 以 @ 开头 → 前置 \'', () => {
  const csv = le.buildLedgerCsv([E({ note: '@danger' })], CATS);
  return bodyLines(csv)[1].includes("'@danger") || `line: ${bodyLines(csv)[1]}`;
});
t('categoryName 以 = 开头（用户自建毒分类）→ 同样前置 \'', () => {
  const cats = [{ id: 'cat_evil', name: '=1+1', icon: '☠️', kind: 'expense' }];
  const csv = le.buildLedgerCsv([E({ categoryId: 'cat_evil' })], cats);
  return bodyLines(csv)[1].includes("'=1+1") || `line: ${bodyLines(csv)[1]}`;
});
t('正常 note 不加 \' 前缀（不误伤）', () => {
  const csv = le.buildLedgerCsv([E({ note: '正常文本123' })], CATS);
  return !csv.includes("'正常文本") || '误伤了正常文本';
});
t('公式注入 + 逗号同时存在：先加 \' 再走 RFC4180 转义', () => {
  const csv = le.buildLedgerCsv([E({ note: '=SUM(A1,B2)' })], CATS);
  const line = bodyLines(csv)[1];
  return line.includes("\"'=SUM(A1,B2)\"") || `line: ${line}`;
});

/* ── 排序 ── */
t('date 降序（乱序输入）', () => {
  const csv = le.buildLedgerCsv([
    E({ id: 'a', date: '2026-10-01', createdAt: '2026-10-01T10:00:00.000Z' }),
    E({ id: 'b', date: '2026-10-03', createdAt: '2026-10-03T10:00:00.000Z' }),
    E({ id: 'c', date: '2026-10-02', createdAt: '2026-10-02T10:00:00.000Z' })
  ], CATS);
  const ids = bodyLines(csv).slice(1).map((l) => l.split(',')[0]);
  return ids[0] === 'b' && ids[1] === 'c' && ids[2] === 'a' || `got ${ids.join(',')}`;
});
t('同日按 createdAt 降序', () => {
  const csv = le.buildLedgerCsv([
    E({ id: 'a', date: '2026-10-01', createdAt: '2026-10-01T08:00:00.000Z' }),
    E({ id: 'b', date: '2026-10-01', createdAt: '2026-10-01T12:00:00.000Z' }),
    E({ id: 'c', date: '2026-10-01', createdAt: '2026-10-01T10:00:00.000Z' })
  ], CATS);
  const ids = bodyLines(csv).slice(1).map((l) => l.split(',')[0]);
  return ids.join(',') === 'b,c,a' || `got ${ids.join(',')}`;
});
t('date 与 createdAt 都相同 → 保持原数组相对顺序（稳定）', () => {
  const csv = le.buildLedgerCsv([
    E({ id: 'first', date: '2026-10-01', createdAt: '2026-10-01T10:00:00.000Z' }),
    E({ id: 'second', date: '2026-10-01', createdAt: '2026-10-01T10:00:00.000Z' }),
    E({ id: 'third', date: '2026-10-01', createdAt: '2026-10-01T10:00:00.000Z' })
  ], CATS);
  const ids = bodyLines(csv).slice(1).map((l) => l.split(',')[0]);
  return ids.join(',') === 'first,second,third' || `got ${ids.join(',')}`;
});
t('混合乱序（date 与 createdAt 都不单调）整体双键降序', () => {
  const csv = le.buildLedgerCsv([
    E({ id: 'a', date: '2026-10-02', createdAt: '2026-10-02T09:00:00.000Z' }),
    E({ id: 'b', date: '2026-10-03', createdAt: '2026-10-03T08:00:00.000Z' }),
    E({ id: 'c', date: '2026-10-02', createdAt: '2026-10-02T21:00:00.000Z' }),
    E({ id: 'd', date: '2026-10-03', createdAt: '2026-10-03T23:00:00.000Z' })
  ], CATS);
  const ids = bodyLines(csv).slice(1).map((l) => l.split(',')[0]);
  return ids.join(',') === 'd,b,c,a' || `got ${ids.join(',')}`;
});

/* ── JSON ── */
t('JSON 信封六字段齐全（app/schemaVersion/exportedAt/entries/categories/budget）', () => {
  const j = JSON.parse(le.buildLedgerExportJson([E({})], CATS, { monthly: 1000 }, '2026-10-20T19:00:00.000Z'));
  const keys = Object.keys(j);
  return keys.length === 6 && ['app', 'schemaVersion', 'exportedAt', 'entries', 'categories', 'budget'].every((k) => k in j)
    || `keys: ${keys.join(',')}`;
});
t('JSON app / schemaVersion / exportedAt 值正确', () => {
  const j = JSON.parse(le.buildLedgerExportJson([], [], {}, '2026-10-20T19:00:00.000Z'));
  return j.app === '私人晨报助理' && j.schemaVersion === 1 && j.exportedAt === '2026-10-20T19:00:00.000Z'
    || `app=${j.app} v=${j.schemaVersion} at=${j.exportedAt}`;
});
t('JSON entries 原样序列化（不造字段不改口径）', () => {
  const entry = E({ amount: 3.5 });
  const j = JSON.parse(le.buildLedgerExportJson([entry], CATS, {}, 'x'));
  return j.entries.length === 1 && j.entries[0].amount === 3.5 && j.entries[0].kind === 'expense' && j.entries[0].id === 'lg-1'
    || JSON.stringify(j.entries[0]);
});
t('JSON note 缺省时该 key 真的不出现', () => {
  const j = JSON.parse(le.buildLedgerExportJson([E({ note: undefined })], CATS, {}, 'x'));
  return !('note' in j.entries[0]) || 'note key 出现了';
});
t('JSON note 有时原样保留', () => {
  const j = JSON.parse(le.buildLedgerExportJson([E({ note: '带引号"和,逗号' })], CATS, {}, 'x'));
  return j.entries[0].note === '带引号"和,逗号' || `got ${j.entries[0].note}`;
});
t('JSON budget 可为 {}（未设预算）', () => {
  const j = JSON.parse(le.buildLedgerExportJson([E({})], CATS, {}, 'x'));
  return typeof j.budget === 'object' && Object.keys(j.budget).length === 0 || JSON.stringify(j.budget);
});
t('JSON categories 原样序列化', () => {
  const j = JSON.parse(le.buildLedgerExportJson([], CATS, {}, 'x'));
  return j.categories.length === 2 && j.categories[0].id === 'cat_food' && j.categories[0].name === '餐饮'
    || JSON.stringify(j.categories);
});
t('JSON 是 2 空格缩进的格式化文本（给人看的）', () => {
  const s = le.buildLedgerExportJson([], [], {}, 'x');
  return s.includes('\n  "app"') || '不是 2 空格缩进';
});
t('JSON 不做 CSV 那套转义（引号/逗号原样，JSON 自己的转义规则）', () => {
  const s = le.buildLedgerExportJson([E({ note: '=1+1' })], CATS, {}, 'x');
  return !s.includes("'=1+1") || 'JSON 里被加了 CSV 公式注入前缀（串味了）';
});

/* ── 文件名 ── */
t('buildExportFilename：固定 Date → 记账导出-20261020-190000.csv', () => {
  const name = le.buildExportFilename('csv', new Date(2026, 9, 20, 19, 0, 0));
  return name === '记账导出-20261020-190000.csv' || `got ${name}`;
});
t('buildExportFilename：json 后缀', () => {
  const name = le.buildExportFilename('json', new Date(2026, 9, 20, 19, 0, 0));
  return name === '记账导出-20261020-190000.json' || `got ${name}`;
});
t('buildExportFilename：单位数全部补零', () => {
  const name = le.buildExportFilename('csv', new Date(2026, 0, 5, 9, 0, 3));
  return name === '记账导出-20260105-090003.csv' || `got ${name}`;
});
t('buildExportFilename：用本地时间（不用 UTC）', () => {
  // 构造一个本地 23:30、UTC 已是次日的时刻，若用 getUTC* 会串到 21 号
  const d = new Date(2026, 9, 20, 23, 30, 5);
  const name = le.buildExportFilename('csv', d);
  const localExpect = `记账导出-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}.csv`;
  return name === localExpect || `got ${name} want ${localExpect}`;
});

/* ── 接线检查（读仓库真实源码，不受 --src 影响） ── */
const apiSrc = readFileSync(path.join(ROOT, 'src', 'services', 'api.ts'), 'utf8');
const pageSrc = readFileSync(path.join(ROOT, 'src', 'pages', 'ledger', 'index.tsx'), 'utf8');
const dataSrc = readFileSync(path.join(ROOT, 'src', 'data', 'ledger.ts'), 'utf8');
const langSrc = readFileSync(path.join(ROOT, 'src', 'store', 'language.ts'), 'utf8');

t('接线：api.ts 有 apiLedgerExport 薄包装（且转调 exportLedgerData）', () => {
  return /export function apiLedgerExport\(/.test(apiSrc) && /ledgerExportData\(format\)/.test(apiSrc)
    || 'api.ts 缺少 apiLedgerExport 或未转调 exportLedgerData';
});
t('接线：页面 import 并调用了 apiLedgerExport', () => {
  return /import[\s\S]*?apiLedgerExport[\s\S]*?from '@\/services\/api'/.test(pageSrc) && /apiLedgerExport\(format\)/.test(pageSrc)
    || '页面未接线 apiLedgerExport';
});
t('接线：页面有导出按钮（catExport）与 showActionSheet 二选一', () => {
  return pageSrc.includes('styles.catExport') && pageSrc.includes('Taro.showActionSheet') && pageSrc.includes("t('ledger.export')")
    || '导出按钮 / ActionSheet / 入口文案缺一';
});
t('接线：页面有 busy 守卫（防重复点击）', () => {
  return pageSrc.includes('exportBusy') && /if \(exportBusy\) return;/.test(pageSrc)
    || '缺少 exportBusy 守卫';
});
t('接线：ledger.ts 同时含 H5 下载分支与 weapp 剪贴板分支', () => {
  return dataSrc.includes("process.env.TARO_ENV === 'h5'") && dataSrc.includes('URL.createObjectURL') && dataSrc.includes("a.download") && dataSrc.includes('Taro.setClipboardData')
    || 'H5 分支（createObjectURL/a.download）或 weapp 分支（setClipboardData）缺失';
});
t('接线：ledger.ts 空数据短路 + try/catch 兜底（不静默失败）', () => {
  return dataSrc.includes("if (entries.length === 0) return 'empty';") && dataSrc.includes('console.warn')
    || '空数据短路或失败留痕缺失';
});
t('接线：双端能力差异说明落在 exportLedgerData 附近注释里', () => {
  return /openDocument/.test(dataSrc) && /saveFileToDisk/.test(dataSrc) && /USER_DATA_PATH/.test(dataSrc)
    || '缺少双端能力差异注释（后人会以为漏做）';
});
t('i18n：ledger.export* 八键中英双语都存在且非空', () => {
  const keys = ['export', 'exportCsv', 'exportJson', 'exportCsvOk', 'exportJsonOk', 'exportCopied', 'exportEmpty', 'exportFailed'];
  const bad = [];
  for (const k of keys) {
    // 每份字典一条；要求恰好两条且值非空（zh + en）
    const re = new RegExp(`'ledger\\.${k}'\\s*:\\s*'([^']*)'`, 'g');
    const found = [...langSrc.matchAll(re)].map((m) => m[1]);
    if (found.length !== 2 || found.some((v) => !v.trim())) bad.push(`${k}(×${found.length})`);
  }
  return bad.length === 0 || `问题键：${bad.join(' ')}`;
});

/* ── 汇总 ──────────────────────────────────────────────────── */
const failed = results.filter((r) => !r.pass);
const out = { status: failed.length ? 'FAIL' : 'PASS', pass: results.length - failed.length, fail: failed.length, total: results.length, failures: failed };
if (asJson) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`\n记账导出逻辑 —— ${out.status}  ${out.pass}/${out.total}`);
  for (const r of results) console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.why ? '  ← ' + r.why : ''}`);
}
console.log(`_RESULT pass=${out.pass} fail=${out.fail} total=${out.total}`);
process.exit(failed.length ? 1 : 0);
