#!/usr/bin/env node
/**
 * verify-cloudllm-timeout.mjs —— cloudLlmChat 超时/熔断回归（2026-10-20）。
 *
 * 背景：晨报会话接真 cloud.llm 实测（4 轮中 1 轮）出现静默挂死——
 *   SDK 流不终止（SSE 无 [DONE]、无 error、迭代器 pending），`await it.next()`
 *   永远挂着，askAssistant 无限等待：75s+ 零回复、零提示、llm_events 都不写。
 *   修复：整体 60s 超时（race + AbortSignal 双保险）+ 失败后 30s 熔断
 *   （防 apiChat 兜底二次调用让用户等 2×超时）。全部收口在 cloudLlm.ts。
 *
 * ⚠️ 不要整模块 bundle：cloudLlm.ts 的传递依赖会拉进 @tarojs/runtime，
 *   import 即 ReferenceError: ENABLE_INNER_HTML（verify-extract-coerce 踩过）。
 *   本 harness 只抽 cloudLlmChat 函数源码 + 它的模块级常量，mock 注入
 *   getCloudLlm / getConversationId / llmEventInsert，编译后跑。
 *   测的仍是同一份源码（treeShaking:false、不 minify）。
 *
 * 用法：
 *   node .tools/verify-cloudllm-timeout.mjs                          # 测当前 src（约 70s）
 *   CLOUDLLM_SRC=<旧版.ts> node .tools/verify-cloudllm-timeout.mjs    # 对旧代码应 RED
 *
 * 判据纪律（verify-extract-coerce 的教训）：断言失败必须返回**原因字符串**，
 * 且调用方严格判 true——非空失败原因 truthy，会被误判成 PASS。
 */
import path from 'node:path';
import fs from 'node:fs';
import { transform } from 'esbuild';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = process.env.CLOUDLLM_SRC || path.join(ROOT, 'src', 'services', 'cloudLlm.ts');
const OUT = path.join(ROOT, '.tmp-verify', 'cloudllm-harness');
fs.mkdirSync(OUT, { recursive: true });
const src = fs.readFileSync(SRC, 'utf8');

/* ── 抽 cloudLlmChat 函数体（大括号配平，跳过字符串/模板串，同 verify-extract-coerce） ── */
function sliceFn(s, name) {
  const m = new RegExp(`(?:export\\s+)?async function ${name}\\s*\\(`).exec(s);
  if (!m) throw new Error(`sliceFn: ${name} not found in ${SRC}`);
  const start = m.index;
  let depth = 0, started = false, inStr = null, inTpl = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (ch === '\\') { i++; continue; } if (ch === inStr) inStr = null; continue; }
    if (inTpl) { if (ch === '\\') { i++; continue; } if (ch === '`') inTpl = false; continue; }
    if (ch === '"' || ch === "'") { inStr = ch; continue; }
    if (ch === '`') { inTpl = true; continue; }
    if (ch === '{') { depth++; started = true; }
    if (ch === '}') { depth--; if (started && depth === 0) return s.slice(start, i + 1); }
  }
  throw new Error(`sliceFn: ${name} unbalanced`);
}
const fnSrc = sliceFn(src, 'cloudLlmChat');

/* ── 抽模块级常量（旧代码没有这三行 = 空，正好让 RED 成立） ── */
const constLines = [
  /const CLOUD_LLM_TIMEOUT_MS[^;]*;/,
  /const CLOUD_LLM_COOLDOWN_MS[^;]*;/,
  /let cloudLlmCooldownUntil[^;]*;/,
].map((re) => { const m = re.exec(src); return m ? m[0] : ''; }).filter(Boolean).join('\n');

/* ── 拼装可测模块：mock 依赖 + 常量 + 真函数 ── */
const harnessSrc = `
${constLines}
const __mock = globalThis.__llmMock = { impl: null, createCalls: 0 };
async function getCloudLlm() {
  if (!__mock.impl) return null;
  return { chat: { completions: { create: async (...a) => { __mock.createCalls++; return __mock.impl(...a); } } } };
}
function getConversationId() { return 'harness-conv'; }
async function pickModel() { return { id: 'harness-model' }; }
async function llmEventInsert(kind) { (globalThis.__llmEventCalls ||= []).push(kind); return true; }
${fnSrc.replace(/^export\s+/, '')}
export { cloudLlmChat };
`;

const outFile = path.join(OUT, 'mod.mjs');
const js = await transform(harnessSrc, { loader: 'ts', format: 'esm', target: 'es2022' }).then((r) => r.code);
fs.writeFileSync(outFile, js);
const mod = await import(pathToFileURL(outFile).href + '?t=' + Date.now());
const { cloudLlmChat } = mod;
if (typeof cloudLlmChat !== 'function') { console.error('HARNESS ERROR: cloudLlmChat not exported'); process.exit(2); }

/* ── 观测 ───────────────────────────────────────────────────────── */
const warns = [];
const origWarn = console.warn;
console.warn = (...a) => { warns.push(a.map((x) => (x && x.message) || String(x)).join(' ')); };
const realNow = Date.now;
let nowOffset = 0;
Date.now = () => realNow.call(Date) + nowOffset;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 流 mock ────────────────────────────────────────────────────── */
const okStream = (chunks) => async () => ({
  [Symbol.asyncIterator]() {
    let i = 0;
    return { next: async () => (i < chunks.length ? { value: { choices: [{ delta: { content: chunks[i++] } }] }, done: false } : { value: undefined, done: true }) };
  },
});
const hungStream = () => async () => ({
  [Symbol.asyncIterator]() {
    return { next: () => new Promise(() => {}) }; // 永远 pending：复现实测的挂死形态
  },
});

/* ── 用例 ───────────────────────────────────────────────────────── */
let pass = 0, fail = 0;
const results = [];
async function t(name, fn) {
  warns.length = 0;
  globalThis.__llmEventCalls = [];
  globalThis.__llmMock.impl = null; globalThis.__llmMock.createCalls = 0;
  try {
    const r = await fn();
    if (r === true) { pass++; results.push(`PASS  ${name}`); }
    else { fail++; results.push(`FAIL  ${name}  — ${r}`); }
  } catch (e) { fail++; results.push(`FAIL  ${name}  — threw: ${e && e.message}`); }
  finally { globalThis.__llmMock.impl = null; globalThis.__llmMock.createCalls = 0; }
}
const done = (cond, why) => (cond === true ? true : why || 'assertion failed');

await t('正常流：收集全部 chunk', async () => {
  globalThis.__llmMock.impl = okStream(['你', '好', '！']);
  const t0 = realNow.call(Date);
  const r = await cloudLlmChat({ system: 's', userContent: 'u' });
  const dt = realNow.call(Date) - t0;
  return done(r === '你好！' && dt < 5000, `reply=${JSON.stringify(r)} dt=${dt}ms`);
});

await t('正常流触发 llmEventInsert 记账', async () => {
  globalThis.__llmMock.impl = okStream(['ok']);
  await cloudLlmChat({ system: 's', userContent: 'u' });
  return done((globalThis.__llmEventCalls || []).length === 1, `events=${JSON.stringify(globalThis.__llmEventCalls)}`);
});

await t('空 system 拒绝（不发请求）', async () => {
  globalThis.__llmMock.impl = okStream(['x']);
  const r = await cloudLlmChat({ system: '  ', userContent: 'u' });
  return done(r === null && globalThis.__llmMock.createCalls === 0, `reply=${JSON.stringify(r)} createCalls=${globalThis.__llmMock.createCalls}`);
});

await t('卡死流：60s 超时返回 null（不无限挂起）', async () => {
  globalThis.__llmMock.impl = hungStream();
  const t0 = realNow.call(Date);
  const r = await Promise.race([
    cloudLlmChat({ system: 's', userContent: 'u' }),
    sleep(70000).then(() => '__HUNG__'), // 修复缺失时的保护：70s 还不返回 = 挂死
  ]);
  const dt = realNow.call(Date) - t0;
  const warned = warns.some((w) => /stream failed/.test(w));
  return done(r === null && dt >= 55000 && dt <= 68000 && warned, `reply=${JSON.stringify(r)} dt=${dt}ms warned=${warned}`);
});

await t('熔断：超时后 30s 内直接返 null 且不再打云端', async () => {
  // 承接上一条用例的熔断状态（同一进程内模块级变量）
  globalThis.__llmMock.impl = okStream(['你', '好']);
  const t0 = realNow.call(Date);
  const r = await cloudLlmChat({ system: 's', userContent: 'u' });
  const dt = realNow.call(Date) - t0;
  const skipped = globalThis.__llmMock.createCalls === 0;
  const cooldownWarn = warns.some((w) => /cooldown/.test(w));
  return done(r === null && dt < 1000 && skipped && cooldownWarn, `reply=${JSON.stringify(r)} dt=${dt}ms createCalls=${globalThis.__llmMock.createCalls} cooldownWarn=${cooldownWarn}`);
});

await t('恢复：熔断过期后正常流重新可用', async () => {
  nowOffset = 31_000; // 快进模块级 Date.now（setTimeout 走真实时间，不受影响）
  globalThis.__llmMock.impl = okStream(['又', '好']);
  const r = await cloudLlmChat({ system: 's', userContent: 'u' });
  nowOffset = 0;
  return done(r === '又好' && globalThis.__llmMock.createCalls === 1, `reply=${JSON.stringify(r)} createCalls=${globalThis.__llmMock.createCalls}`);
});

console.warn = origWarn;
Date.now = realNow;
console.log(results.join('\n'));
console.log(`\n===== ${pass} PASS / ${fail} FAIL =====   (src: ${SRC})`);
process.exit(fail > 0 ? 1 : 0);
