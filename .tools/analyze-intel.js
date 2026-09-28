// 离线分析 /api/hotspot 响应 JSON 的类目分布 —— 回答「用户实际看到的到底有没有多元化」。
//
// 用法：
//   node .tools/analyze-intel.js <hotspot.json>   # 分析指定响应
//   node .tools/analyze-intel.js                  # 不给参数 → 读磁盘缓存 .tools/cache/hotspot.json
//
// 为什么需要一个可复跑的入口：上一轮多元化扩源时写的一次性脚本散落在 .tmp-verify/（不纳入版本控制、
// 随时会被清掉），下次没人知道怎么跑、也无法回归。本文件把那批脚本的分析口径固化下来。
//
// 阈值依据（2026-09-28 多元化扩源实测）：17 个 RSS 源 + 9 个热榜板块，响应约 260 条、
// 覆盖 18 个类目、最大类目占比 ≈19%（综合热榜，5 个平台算法榜归并）。据此把门槛定在
// 条目 ≥120、类目 ≥12、最大占比 ≤0.35 —— 留出抖动余量，但源收缩/类目塌缩时能挡下来。
const fs = require('fs');
const path = require('path');

/* ---------- 阈值（具名常量，便于审计「凭什么这么定」） ---------- */
/** 总条目下限：实测 260 条上下，腰斩即视为源大面积失效 */
const MIN_ITEMS = 120;
/** 覆盖类目下限：实测 18 类；低于 12 说明类目塌缩（加源前只有 7 类） */
const MIN_CATEGORIES = 12;
/** 单类目垄断上限：实测最大占比 ≈19%；超过 35% 说明又挤回少数几个类目 */
const MAX_TOP_CATEGORY_SHARE = 0.35;
/** AI 精选候选窗口：static-server.js 送进 /filter 的是 items 前 110 条（跨源交错后的顺序） */
const AI_WINDOW = 110;
/** 磁盘缓存：不给参数时的默认输入 */
const CACHE_FILE = path.join(__dirname, 'cache', 'hotspot.json');

/* ---------- 从 src/utils/categoryLabel.ts 复用类目口径（严禁手写第二套） ---------- */
// 为什么这么做：类目口径一旦有两份实现就必然发散（本项目已因「两份各自维护的清单」踩过坑）。
// 这里按函数名做括号配平抽取生产源码后 eval，保证与 src 里被 UI 使用的 categoryOf **同源**。
const CATEGORY_TS = path.join(__dirname, '..', 'src', 'utils', 'categoryLabel.ts');

function extractFn(name, src) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('categoryLabel.ts 中未找到函数 ' + name);
  let depth = 0;
  let seen = false;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    const c = src[j];
    if (c === '{') { depth++; seen = true; } else if (c === '}') {
      depth--;
      if (seen && depth === 0) return src.slice(start, j + 1);
    }
  }
  throw new Error('括号未配平: ' + name);
}

function extractConst(name, src) {
  const m = src.match(new RegExp('const\\s+' + name + '\\s*=\\s*([^;]+);'));
  if (!m) throw new Error('categoryLabel.ts 中未找到常量 ' + name);
  return m[1];
}

// 生产源码是 TS（categoryOf 的签名是 `(tags?: string[]): string`），直接 eval 会因类型标注报语法错误。
// 这里只剥签名的类型标注（参数 `tags?: string[]` → `tags`，返回值 `: string` 去掉），函数体一字不改 ——
// 因此类目判定逻辑仍逐字符来自 src，不存在「第二套口径」。
function stripTsSignature(fnSrc) {
  return fnSrc.replace(/\(([^)]*)\)(\s*:\s*[^{]+)?\s*\{/, (_m, params) => {
    const clean = params
      .split(',')
      .map((p) => p.trim().replace(/\?/g, '').split(':')[0].trim())
      .filter(Boolean)
      .join(', ');
    return '(' + clean + ') {';
  });
}

function loadCategoryOf() {
  const src = fs.readFileSync(CATEGORY_TS, 'utf8');
  const body = [
    'const CATEGORY_MIXED = ' + extractConst('CATEGORY_MIXED', src) + ';',
    'const CATEGORY_UNKNOWN = ' + extractConst('CATEGORY_UNKNOWN', src) + ';',
    stripTsSignature(extractFn('categoryOf', src)),
    'return categoryOf;'
  ].join('\n');
  return new Function(body)(); // eslint-disable-line no-new-func
}

/* ---------- 分析 ---------- */
const categoryOf = loadCategoryOf();

function dist(list) {
  const m = {};
  for (const it of list) {
    const c = categoryOf(it.tags);
    m[c] = (m[c] || 0) + 1;
  }
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
}

function topShare(list, dd) {
  return list.length ? dd[0][1] / list.length : 0;
}

function report(label, list) {
  const dd = dist(list);
  const n = dd.length;
  const share = topShare(list, dd);
  const top = dd[0] || ['-', 0];
  console.log('\n===== ' + label + '（' + list.length + ' 条，' + n + ' 个类目，最大类目「' +
    top[0] + '」占比 ' + (share * 100).toFixed(1) + '%）=====');
  for (const [c, k] of dd) {
    console.log('  ' + c.padEnd(12) + String(k).padStart(4) + '  ' + '█'.repeat(Math.min(k, 40)));
  }
  return { n, share, top };
}

/* ---------- 入口 ---------- */
const argFile = process.argv[2];
const file = argFile ? path.resolve(argFile) : CACHE_FILE;
const usingCache = !argFile;

console.log('[analyze-intel] 输入：' + file + (usingCache ? '（磁盘缓存 .tools/cache/hotspot.json）' : '（命令行参数）'));

let data;
try {
  data = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (e) {
  console.error('[analyze-intel] 无法读取/解析输入：' + String((e && e.message) || e));
  process.exit(1);
}

const items = Array.isArray(data.items) ? data.items : [];
const meta = data.meta || {};
const sources = Array.isArray(meta.sources) ? meta.sources : [];

console.log('总条目: ' + items.length + '   updatedAt: ' + meta.updatedAt + '   stale: ' + meta.stale);

/* 源健康：ok=false 的必须点名，并带上 reason，否则无从判断是偶发抖动还是源已死 */
const ok = sources.filter((s) => s.ok);
const bad = sources.filter((s) => !s.ok);
console.log('\n源健康: ' + ok.length + '/' + sources.length + ' 正常');
console.log('  正常: ' + ok.map((s) => s.name + '(' + s.count + ')').join('、'));
if (bad.length) {
  console.log('  异常:');
  for (const s of bad) console.log('    ✗ ' + s.name + ' —— ' + (s.reason || '(无 reason)'));
}

const all = report('全部条目', items);
const win = report('AI 精选候选窗口（前 ' + AI_WINDOW + ' 条 —— static-server.js 送进 /filter 的实际范围）',
  items.slice(0, AI_WINDOW));

/* 跨源同事件合并统计（响应含该字段时才有；当前生产可能尚未启用） */
if ('clustered' in data) {
  console.log('\nclustered（跨源同事件合并）: ' + JSON.stringify(data.clustered));
} else {
  console.log('\nclustered（跨源同事件合并）: 无 clustered 字段');
}

/* ---------- 阈值断言 ---------- */
console.log('\n===== 阈值断言 =====');
console.log('  条目数 ' + items.length + ' ≥ ' + MIN_ITEMS);
console.log('  覆盖类目 ' + all.n + ' ≥ ' + MIN_CATEGORIES);
console.log('  最大类目占比 ' + (all.share * 100).toFixed(1) + '% ≤ ' + (MAX_TOP_CATEGORY_SHARE * 100) + '%'
  + '（窗口内为 ' + (win.share * 100).toFixed(1) + '%，仅观测不断言）');

const fails = [];
if (items.length < MIN_ITEMS) fails.push('条目数 ' + items.length + ' < ' + MIN_ITEMS);
if (all.n < MIN_CATEGORIES) fails.push('覆盖类目 ' + all.n + ' < ' + MIN_CATEGORIES);
if (all.share > MAX_TOP_CATEGORY_SHARE) {
  fails.push('最大类目占比 ' + (all.share * 100).toFixed(1) + '% > ' + (MAX_TOP_CATEGORY_SHARE * 100) + '%');
}

if (fails.length) {
  console.error('\n[FAIL] 未达标：');
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('\n[OK] 全部阈值通过');
