#!/usr/bin/env node
/**
 * verify-llm-parse.mjs —— safeParseReply 容错解析回归（2026-10-31）。
 *
 * 背景（用户实测）：平台模型不总输出纯 JSON——出现 ```json 围栏、前后解说散文时，
 * 裸 JSON.parse 失败 → chat/extract 双双降级 mock（AI「有反馈但不会做事」+ 收件箱
 * 「本地演示数据」），且生产构建剔除 console.warn，线上零痕迹。
 * 守：三级容错（直解 → 剥围栏 → 首个平衡 {...}）+ 诚实失败（真解析不了仍 null）。
 *
 * 加载方式：cloudLlm.ts 传递依赖会拉进 @tarojs/runtime（verify-cloudllm-timeout 的教训），
 * 用大括号配平切片抽三个函数源码编译执行——测的仍是同一份源码。
 *
 * 用法: node .tools/verify-llm-parse.mjs        # 退出码 0 全绿 / 1 有失败 / 2 自身出错
 */
import fs from 'node:fs';
import path from 'node:path';
import { transform } from 'esbuild';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src', 'services', 'cloudLlm.ts');
const src = fs.readFileSync(SRC, 'utf8');

function sliceFn(s, name) {
  const m = new RegExp(`(?:export\\s+)?(?:async\\s+)?function ${name}(?:<[^>]*>)?\\s*\\(`).exec(s);
  if (!m) throw new Error(`sliceFn: ${name} not found`);
  const start = m.index;
  let depth = 0, started = false, inStr = null;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (ch === '\\') { i++; continue; } if (ch === inStr) inStr = null; continue; }
    if (ch === '"' || ch === "'") { inStr = ch; continue; }
    if (ch === '{') { depth++; started = true; }
    if (ch === '}') { depth--; if (started && depth === 0) return s.slice(start, i + 1); }
  }
  throw new Error(`sliceFn: ${name} unbalanced`);
}
const names = ['extractFirstJsonObject', 'tryParseJson', 'safeParseReply'];
const slice = names.map((n) => sliceFn(src, n)).join('\n') + '\nglobalThis.__p = { extractFirstJsonObject, tryParseJson, safeParseReply };\n';
const built = (await transform(slice, { loader: 'ts', format: 'cjs', logLevel: 'silent' })).code;
const sandbox = { console, JSON, Math, Date, Number, String, Array, Object, RegExp, Error };
sandbox.globalThis = sandbox;
sandbox.module = { exports: {} };
sandbox.exports = sandbox.module.exports;
vm.createContext(sandbox);
vm.runInContext(built, sandbox, { filename: 'llm-parse-slice.js' });
const { safeParseReply, extractFirstJsonObject } = sandbox.__p;

let passes = 0, failures = 0;
const ok = (name, desc, cond) => {
  if (cond === true) { passes += 1; console.log(`  PASS  ${name}  ${desc}`); }
  else { failures += 1; console.log(`  FAIL  ${name}  ${desc}`); }
};

ok('P1', '纯 JSON 直解', safeParseReply('{"reply":"你好","action":"chat"}')?.reply === '你好');
ok('P2', '```json 围栏包装 → 救回', safeParseReply('好的：\n```json\n{"reply":"已安排","action":"add"}\n```\n以上。')?.reply === '已安排');
ok('P3', '无标记 ``` 围栏 → 救回', safeParseReply('```\n{"reply":"B"}\n```')?.reply === 'B');
ok('P4', 'JSON 前有解说散文（平衡提取）→ 救回',
  safeParseReply('好的，这是结果：{"reply":"C","action":"chat"} 请查收')?.reply === 'C');
ok('P5', '值内含 } 字符（字符串里的括号不许截断提取）→ 救回且内容完整',
  safeParseReply('结果：{"reply":"注意}符号","action":"chat"}')?.reply === '注意}符号');
ok('P6', '纯散文无 JSON → 如实 null（不造假）', safeParseReply('抱歉，我不明白。') === null);
ok('P7', '空串/缺失 → null', safeParseReply('') === null && safeParseReply(undefined) === null);
ok('P8', '截断损坏 JSON（围栏内）→ 如实 null', safeParseReply('```json\n{"reply":"截断') === null);
ok('P9', 'extractFirstJsonObject 直接可用', extractFirstJsonObject('前缀 {"a":1} 后缀') === '{"a":1}');
ok('P10', 'proposals/memories 数组透传', (() => {
  const r = safeParseReply('{"reply":"r","proposals":[{"title":"x"}],"memories":["m1"]}');
  return r?.proposals?.length === 1 && r?.memories?.[0] === 'm1';
})());

console.log(`\nPASS ${passes} / FAIL ${failures}`);
process.exit(failures === 0 ? 0 : 1);
