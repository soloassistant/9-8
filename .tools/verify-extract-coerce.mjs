#!/usr/bin/env node
/**
 * verify-extract-coerce.mjs —— extract 结果校验收敛（P1-02）逻辑回归。
 *
 * 为什么必须单独测这段：`extractViaCloudLlm` 的返回值直接进 `inbox/index.tsx` 渲染，
 * 而它的输入是**大模型输出**——不可信。`coerceExtract` 是唯一的防线。
 * 只测「正常输入能过」等于没测：真正会炸的是畸形输入。
 *
 * 本 harness 用 esbuild 就地把 `src/services/cloudLlm.ts` 编译成可求值的 JS 再跑。
 *
 * ⚠️ 踩过的坑：**不要从 `dist/` 的产物里「按函数名抠源码」**（试过，不可靠）：
 *   terser 会把局部变量重命名（实测抠出来的 normalizeTime 里出现 `j is not defined`，
 *   coerceExtract 里是 `L is not defined`）—— 抠出来的片段依赖被重命名的外部作用域，
 *   22 个用例会假失败。改为编译**源码**（不做 minify、不重命名），测的仍是同一份逻辑。
 *
 * 用法: node .tools/verify-extract-coerce.mjs [--json]
 * 退出码: 0 = 全通过；1 = 有用例失败；2 = harness 自身出错
 *
 * ⚠️ 变异验证记录（2026-10-15，务必保留这几条认知）：
 *   1. 变异 ①：删掉 normalizeTime 的越界校验 → 4 条断言 FAIL（拒 13 月/45 日/25 时/70 分）。符合预期。
 *   2. 变异 ②：把 `if (!title) continue` 改成 `|| '(未命名)'` → **最初仍报 33/33 全绿**。
 *      根因不在被测代码，而在 harness 的判据：`pass: !!ok`，而失败分支返回的是
 *      **说明原因的字符串**，非空字符串 truthy → 失败被判成 PASS。
 *      修法：判据改 `ok === true`，并补 3 条专门守「丢弃无标题条目」的断言。
 *      修完同一变异 → 30/33 FAIL，3 条断言精确报错。**这才是有效的验证。**
 *   3. 教训：断言失败时的「返回值写法」和断言本身同等重要 —— 一个 truthy 的失败原因
 *      能让整份测试永久假绿。写断言时要么返回 true/false，要么让 t() 严格判 true。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import esbuild from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src', 'services', 'cloudLlm.ts');
const asJson = process.argv.includes('--json');
const log = (...a) => { if (!asJson) console.log(...a); };

/* ── 1. 就地编译被测模块 ───────────────────────────────────────────
 * 用 stdin + loader:'ts'，配合一个把内部函数导出的 shim：
 * 直接 import 整个模块会因为 @tarojs 依赖而跑不起来，所以只取这三个纯函数的源码区段。
 * 关键：`treeShaking:false` + 不 minify，保证函数名与逻辑原样保留。           */

const source = readFileSync(SRC, 'utf8');

/**
 * 从 cloudLlm.ts 里抽出 coerceExtract / normalizeTime / shortText 三个纯函数的源码。
 * 用「函数名 + 大括号配平」定位，跳过字符串/模板串里的括号。
 */
function sliceFn(src, name) {
  const m = new RegExp(`(?:export\\s+)?function ${name}\\s*\\(`).exec(src);
  if (!m) return null;
  const start = m.index;
  let depth = 0, started = false, inStr = null, inTpl = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inStr) { if (ch === '\\') { i++; continue; } if (ch === inStr) inStr = null; continue; }
    if (inTpl) { if (ch === '\\') { i++; continue; } if (ch === '`') inTpl = false; continue; }
    if (ch === '"' || ch === "'") { inStr = ch; continue; }
    if (ch === '`') { inTpl = true; continue; }
    if (ch === '{') { depth++; started = true; continue; }
    if (ch === '}') { depth--; if (started && depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

const parts = [];
for (const fn of ['normalizeTime', 'shortText', 'coerceExtract']) {
  const code = sliceFn(source, fn);
  if (!code) {
    console.error(`[FAIL] 无法在 ${SRC} 里定位函数 ${fn} —— 它可能被改名或已删除。`);
    console.error('       这不是测试通过，是测试没跑起来。');
    process.exit(2);
  }
  parts.push(code);
}
// coerceExtract 依赖 ExtractResult 类型（仅类型，编译时擦除），无需额外注入。
// ⚠️ 末尾不写 `export`：编译目标用 format:'iife'，因为 vm 里没有 ESM 模块解析器，
//    带 export 的代码在 vm.runInContext 里会直接抛 "Unexpected token 'export'"。
const harnessSrc = `
${parts.join('\n')}
globalThis.__t = { normalizeTime: normalizeTime, shortText: shortText, coerceExtract: coerceExtract };
`;

const built = await esbuild.build({
  stdin: { contents: harnessSrc, loader: 'ts', resolveDir: path.join(ROOT, 'src', 'services') },
  bundle: true,
  format: 'iife',
  platform: 'neutral',
  write: false,
  minify: false,
  treeShaking: false
}).catch((e) => {
  console.error('[FAIL] esbuild 编译失败：', e && e.message ? e.message : e);
  process.exit(2);
});

const js = built.outputFiles[0].text;
const sandbox = { console, globalThis: undefined };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
try {
  vm.runInContext(js, sandbox);
} catch (e) {
  console.error('[FAIL] 求值失败：', e && e.message ? e.message : e);
  process.exit(2);
}
const __t = sandbox.__t;
const coerceExtract = __t && __t.coerceExtract;
const normalizeTime = __t && __t.normalizeTime;
const shortText = __t && __t.shortText;

if (typeof coerceExtract !== 'function' || typeof normalizeTime !== 'function' || typeof shortText !== 'function') {
  console.error('[FAIL] 被测函数未成功导出 —— harness 没真正跑到被测逻辑（这是 harness 问题，不是通过）。');
  process.exit(2);
}

/* ── 2. 用例 ──────────────────────────────────────────────────── */

const results = [];
/**
 * 用例注册。
 *
 * ⚠️ 判据必须是 `ok === true`，**不能写 `!!ok`**（2026-10-15 修）：
 *   失败分支返回的是**说明原因的字符串**（如 '无标题事件本该被丢弃…'），
 *   而非空字符串是 truthy —— `!!ok` 会把「失败且写清了原因」判成 PASS。
 *   实测这样会让 3 条新断言在真变异（把 `if (!title) continue` 改成
 *   `|| '(未命名)'`）下依然报 33/33 全绿，是货真价实的假绿。
 *   现在只接受 `true`；返回字符串一律视为失败并把字符串当原因。
 */
function t(name, fn) {
  try {
    const ok = fn();
    if (ok === true) {
      results.push({ name, pass: true, why: '' });
    } else {
      results.push({ name, pass: false, why: ok ? String(ok) : 'returned falsy: ' + String(ok) });
    }
  } catch (e) {
    results.push({ name, pass: false, why: `threw: ${e.message}` });
  }
}

/* normalizeTime：时间格式是硬契约，日历页按它解析 */
t('normalizeTime 接受 "YYYY-MM-DD HH:mm"', () => normalizeTime('2026-10-16 15:00') === '2026-10-16 15:00');
t('normalizeTime 把 ISO 的 T 换成空格', () => normalizeTime('2026-10-16T15:00') === '2026-10-16 15:00');
t('normalizeTime 容忍秒', () => normalizeTime('2026-10-16 15:00:30') === '2026-10-16 15:00');
t('normalizeTime 拒 13 月', () => normalizeTime('2026-13-01 10:00') === '');
t('normalizeTime 拒 45 日', () => normalizeTime('2026-01-45 10:00') === '');
t('normalizeTime 拒 25 时', () => normalizeTime('2026-01-01 25:00') === '');
t('normalizeTime 拒 70 分', () => normalizeTime('2026-01-01 10:70') === '');
t('normalizeTime 空串→空', () => normalizeTime('') === '');
t('normalizeTime 非字符串→空', () => normalizeTime(null) === '' && normalizeTime(123) === '' && normalizeTime({}) === '');
t('normalizeTime 拒纯日期（无时刻）', () => normalizeTime('2026-10-16') === '', '给了纯日期必须留空，不能臆造 00:00');

/* shortText */
t('shortText 截断超长', () => shortText('x'.repeat(100), 60).length === 60);
t('shortText 去空白', () => shortText('  hi  ', 60) === 'hi');
t('shortText 非字符串→空', () => shortText(undefined, 60) === '' && shortText(0, 60) === '');

/* coerceExtract：正常路径 */
t('正常日程被保留', () => {
  const r = coerceExtract({ events: [{ title: '功能评审会', startTime: '2026-10-16 15:00', endTime: '2026-10-16 15:30', location: '3 号会议室', source: '原文片段' }], todos: [] });
  return r && r.events.length === 1 && r.events[0].title === '功能评审会' && r.events[0].startTime === '2026-10-16 15:00'
    && r.events[0].endTime === '2026-10-16 15:30' && r.events[0].location === '3 号会议室'
    || '结构不对: ' + JSON.stringify(r);
});
t('缺 startTime 的日程仍保留（不丢信息）', () => {
  const r = coerceExtract({ events: [{ title: '跟客户吃饭' }], todos: [] });
  return r && r.events.length === 1 && r.events[0].startTime === '' || '不该丢';
});
t('待办无 dueDate 也保留', () => {
  const r = coerceExtract({ events: [], todos: [{ title: '改合同' }] });
  return r && r.todos.length === 1 && r.todos[0].dueDate === undefined || '不该丢';
});
t('collection 三字段齐才成立', () => {
  const r = coerceExtract({ events: [], todos: [], collection: { title: '文章', summary: '摘要', tags: ['效率'], sourceType: 'article' } });
  return r && r.collection && r.collection.sourceType === 'article' && r.collection.tags.length === 1 || JSON.stringify(r);
});
t('非法 sourceType 兜底为 message', () => {
  const r = coerceExtract({ events: [], todos: [], collection: { title: 'A', summary: 'B', tags: [], sourceType: 'weird' } });
  return r && r.collection && r.collection.sourceType === 'message' || JSON.stringify(r);
});
t('tags 超过 3 个被截断', () => {
  const r = coerceExtract({ events: [], todos: [], collection: { title: 'A', summary: 'B', tags: ['a','b','c','d','e'], sourceType: 'link' } });
  return r && r.collection && r.collection.tags.length === 3 || JSON.stringify(r);
});

/* coerceExtract：畸形输入（模型不可信，这组才是重点） */
t('events 不是数组 → 不崩', () => coerceExtract({ events: 'oops', todos: null }) === null);
t('events 里混入 null/字符串 → 跳过', () => {
  const r = coerceExtract({ events: [null, 'x', 42, { title: '好' }], todos: [] });
  return r && r.events.length === 1 && r.events[0].title === '好' || JSON.stringify(r);
});
t('无标题条目被丢弃', () => {
  const r = coerceExtract({ events: [{ title: '   ' }, { title: '' }, { startTime: '2026-01-01 10:00' }], todos: [] });
  return r === null || '应该全空→null';
});
t('时间格式乱的条目：事件保留但时间为空', () => {
  const r = coerceExtract({ events: [{ title: '会', startTime: '明天下午' }], todos: [] });
  return r && r.events[0].startTime === '' || '不该把「明天下午」当时间';
});
t('全空 → 返回 null（交上层降级）', () => coerceExtract({ events: [], todos: [], collection: undefined, note: '' }) === null);
t('空对象 → null', () => coerceExtract({}) === null);
/* 变异验证补的断言（2026-10-15）：
   把 `if (!title) continue` 改成 `|| '(未命名)'` 时本文件原本仍 30/30 全绿 —— 假绿。
   说明「丢弃无标题条目」这条防护当时无人守。补下面两条专门守它。 */
t('事件无标题 → 该条被丢弃（不得占位兜底）', () => {
  const r = coerceExtract({ events: [{ startTime: '2026-10-16 15:00' }], todos: [] });
  return r === null || '无标题事件本该被丢弃，却产出了 ' + JSON.stringify(r);
});
t('待办无标题 → 该条被丢弃（不得占位兜底）', () => {
  const r = coerceExtract({ events: [], todos: [{ dueDate: '2026-10-16 15:00' }] });
  return r === null || '无标题待办本该被丢弃，却产出了 ' + JSON.stringify(r);
});
t('混合：有标题的留、无标题的丢', () => {
  const r = coerceExtract({ events: [{ startTime: '2026-10-16 15:00' }, { title: '正常会', startTime: '2026-10-16 16:00' }], todos: [] });
  return r && r.events.length === 1 && r.events[0].title === '正常会' || JSON.stringify(r);
});
t('collection 是数组 → 忽略', () => coerceExtract({ events: [], todos: [], collection: [1,2,3] }) === null);
t('collection 缺 summary → 不成立', () => coerceExtract({ events: [], todos: [], collection: { title: '只有标题' } }) === null);
t('note 单独存在时仍返回结果', () => {
  const r = coerceExtract({ events: [], todos: [], note: '这条信息无法归类：明天记得带伞' });
  return r && r.note === '这条信息无法归类：明天记得带伞' || JSON.stringify(r);
});
t('超长标题被截断到 60', () => {
  const r = coerceExtract({ events: [{ title: '标'.repeat(300) }], todos: [] });
  return r && r.events[0].title.length === 60 || '没截断: ' + (r && r.events[0].title.length);
});
t('返回对象不含 id/status/createTime（下游会自己补）', () => {
  const r = coerceExtract({ events: [{ title: 'x', id: 'bad', status: 'weird' }], todos: [] });
  return r && !('id' in r.events[0]) && !('status' in r.events[0]) || '不该透传模型给的 id/status';
});

/* ── 3. 汇总 ──────────────────────────────────────────────────── */

const failed = results.filter((r) => !r.pass);
const out = { status: failed.length ? 'FAIL' : 'PASS', pass: results.length - failed.length, total: results.length, failures: failed };
if (asJson) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`\nextract 结果校验（编译自 src 真实源码）—— ${out.status}  ${out.pass}/${out.total}`);
  for (const r of results) console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.why ? '  ← ' + r.why : ''}`);
}
process.exit(failed.length ? 1 : 0);