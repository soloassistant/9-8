/**
 * 记账导出（纯函数，零 I/O）—— 把条目/分类/预算拼成 CSV 或 JSON 文本。
 *
 * 为什么单独抽出来：导出是「拼字符串」的纯逻辑，最容易出错的三处
 * （CSV 转义 / 公式注入 / 排序）都值得用 harness 直接测
 * （.tools/verify-ledger-export.mjs），不依赖页面与 Taro 运行时。
 *
 * 口径说明（重要，改之前先读）：
 *   · amount 恒为正数、单位为元，方向由 kind 表达 —— 与 src/types/index.ts:223 一致。
 *   · CSV 的 amount 用 `toFixed(2)` 的**机器口径**（纯数字两位小数，不带 ¥、
 *     不带千分位），与页面 formatMoney 的**展示口径**（¥1,234.5）刻意不同：
 *     导出的文件是要给 Excel/记账软件再加工的，千分位逗号会撞 CSV 分隔符、
 *     ¥ 符号会让数字列变成文本列，两边都讨不到好。展示好看 vs 机器可算，
 *     这里选机器可算。
 *   · 行序按 date 降序、同日再按 createdAt 降序 —— 与记账页 grouped 的展示序
 *     一致（src/pages/ledger/index.tsx:198-206），用户导出的顺序就是他看到的顺序。
 */
import type { LedgerBudget, LedgerCategory, LedgerEntry } from '../types';

/** CSV 表头（固定，勿改 —— 下游脚本/Excel 可能按列名取数） */
const CSV_HEADER = 'id,date,kind,categoryId,categoryName,amount,note,createdAt';

/** 分类解析不到时的兜底名（用户自建分类也可能被删，不能不兜） */
const UNKNOWN_CATEGORY_NAME = '未分类';

/**
 * RFC4180 转义：含 `,` `"` `\n` `\r` 的字段整体包双引号，内部 `"` → `""`。
 * 不逃这些字符，一个含逗号的备注就能把整行的列数顶歪。
 */
function escapeCsvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * CSV 公式注入防护：用户自由文本（note / categoryName）以 `=` `+` `-` `@`
 * 开头的，前置一个 `'` —— 否则 Excel/WPS 打开会把 `=SUM(...)` 当公式执行。
 * 这是安全边界，不是口味问题：导出的文件会被用户在本地再用 Office 打开。
 * 只作用于用户可输入的文本字段；id/date/kind/categoryId/amount/createdAt
 * 都是机器生成（数字或固定前缀），不需要也不应该加。
 */
function guardFormulaInjection(value: string): string {
  if (/^[=+\-@]/.test(value)) return `'${value}`;
  return value;
}

/** 文本字段进 CSV 前的统一处理：先防公式注入，再做 RFC4180 转义 */
function csvTextField(value: string): string {
  return escapeCsvField(guardFormulaInjection(value));
}

/** 按 categoryId 找分类名；找不到（分类被删/脏数据）兜底「未分类」 */
function resolveCategoryName(categories: LedgerCategory[], categoryId: string): string {
  const cat = categories.find((c) => c.id === categoryId);
  return cat ? cat.name : UNKNOWN_CATEGORY_NAME;
}

/**
 * 生成 CSV 全文（含 UTF-8 BOM）。
 *
 * BOM 必须加：Excel 双击打开无 BOM 的 UTF-8 CSV 会把中文显示成乱码
 * （Excel 默认按本地代码页猜编码），这是「文件是对的、用户看来是坏的」
 * 典型事故，一行 '\uFEFF' 就能避免。
 */
export function buildLedgerCsv(entries: LedgerEntry[], categories: LedgerCategory[]): string {
  // 稳定排序：date 降序 → createdAt 降序 → 原数组相对顺序。
  // 显式带原始下标做第三键，不依赖引擎的 sort 稳定性承诺。
  const sorted = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      if (a.entry.date !== b.entry.date) return a.entry.date < b.entry.date ? 1 : -1;
      if (a.entry.createdAt !== b.entry.createdAt) return a.entry.createdAt < b.entry.createdAt ? 1 : -1;
      return a.index - b.index;
    })
    .map((x) => x.entry);

  const lines = [CSV_HEADER];
  for (const e of sorted) {
    const row = [
      escapeCsvField(e.id),
      escapeCsvField(e.date),
      escapeCsvField(e.kind),
      escapeCsvField(e.categoryId),
      csvTextField(resolveCategoryName(categories, e.categoryId)),
      // 机器口径：两位小数纯数字。amount 恒正（types/index.ts:223），不会出现 '-'
      e.amount.toFixed(2),
      // note 缺省 → 空串（不出 'undefined'）
      csvTextField(typeof e.note === 'string' ? e.note : ''),
      escapeCsvField(e.createdAt)
    ];
    lines.push(row.join(','));
  }
  return `\uFEFF${lines.join('\n')}`;
}

/**
 * 生成 JSON 全文（带信封）。
 *
 * entries/categories/budget **原样序列化，不造字段不改口径** ——
 * note 缺省的条目，序列化结果里就不该出现 note 这个 key（JSON.stringify
 * 对 undefined 值天然跳过，直接传原对象即可）。
 *
 * exportedAt 由调用方注入而不是函数内部 new Date()：纯函数才能用固定时间
 * 断言（harness 不 mock 时钟）。
 */
export function buildLedgerExportJson(
  entries: LedgerEntry[],
  categories: LedgerCategory[],
  budget: LedgerBudget,
  exportedAt: string
): string {
  const payload = {
    app: '私人晨报助理',
    schemaVersion: 1,
    exportedAt,
    entries,
    categories,
    budget
  };
  return JSON.stringify(payload, null, 2);
}

/** 导出文件名：`记账导出-20261020-190000.csv`（本地时间，补零） */
export function buildExportFilename(format: 'csv' | 'json', now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `记账导出-${stamp}.${format}`;
}
