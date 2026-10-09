#!/usr/bin/env node
/**
 * verify-intel-degraded-semantics.cjs —— 验证「没有 AI」与「AI 坏了」被正确区分（2026-10-08）。
 *
 * 背景：免费档原本硬编码 `degraded: true`，而前端 `resolveIntelGroups` 的本地兜底路径
 * 也把 `degraded` 写死 true。两者叠加 → 免费用户**永久**看到「AI 提炼暂不可用」，
 * 明明这个档位按设计就没有 AI，不是故障。
 *
 * 这里用 esbuild 把**真实的** src/utils/intelGroups.ts 打成 CJS 后测，不用重写实现
 * （重写实现等于测了另一份代码，正是最容易出假绿的方式）。
 *
 * 退出码：0 = 全 PASS
 */
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, '.cache', 'intel-degraded.cjs');
fs.mkdirSync(path.dirname(OUT), { recursive: true });

esbuild.buildSync({
  entryPoints: [path.join(ROOT, 'src/utils/intelGroups.ts')],
  outfile: OUT,
  format: 'cjs',
  platform: 'node',
  logLevel: 'silent'
});
const M = require(OUT);

let pass = 0,
  fail = 0;
function ok(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail !== undefined ? ' → ' + JSON.stringify(detail) : ''}`);
  }
}

/** 复刻 pages/briefing/index.tsx 里的三态渲染判断，保持测的是同一套决策。 */
function noteKey(p) {
  if (!p.aiEnabled) return 'intelFreeNote';
  return p.degraded ? 'intelRawNote' : 'aiTag';
}

/** 复刻 pages/briefing/index.tsx 的 AI 导语署名判断
 *  （缺陷 B 修复后收紧为「确实由 AI 生成」：aiEnabled && !degraded）。 */
function showLeadTag(p) {
  return p.groups.length > 0 && p.aiEnabled && !p.degraded;
}

const items = [
  { text: '谷歌借助 AI 改写 C 语言依赖库为 Rust', source: 'InfoQ中文' },
  { text: '智己LS6 把转向柱删了', source: '什么值得买' }
];

/* ---------- 免费档：按设计无 AI，不是故障 ---------- */
const free = M.resolveIntelGroups({
  subscribed: false,
  limited: false,
  weather: null,
  intelItems: items,
  groups: [],
  degraded: false,
  aiEnabled: false
});
ok('免费档 产出分组', free.groups.length > 0, free.groups.length);
ok('免费档 aiEnabled=false', free.aiEnabled === false, free.aiEnabled);
ok('免费档 degraded=false（不是故障）', free.degraded === false, free.degraded);
ok('免费档 走档位说明文案而非错误提示', noteKey(free) === 'intelFreeNote', noteKey(free));

/* ---------- 订阅档降级：LLM 失败，必须显示错误提示 ---------- */
const proDegraded = M.resolveIntelGroups({
  subscribed: true,
  limited: false,
  weather: null,
  intelItems: items,
  groups: [],
  degraded: true,
  aiEnabled: true
});
ok('订阅降级 aiEnabled=true', proDegraded.aiEnabled === true, proDegraded.aiEnabled);
ok('订阅降级 degraded=true', proDegraded.degraded === true, proDegraded.degraded);
ok('订阅降级 显示错误提示', noteKey(proDegraded) === 'intelRawNote', noteKey(proDegraded));

/* ---------- 订阅档正常：云端分组 ---------- */
const proOk = M.resolveIntelGroups({
  subscribed: true,
  limited: false,
  weather: null,
  intelItems: items,
  groups: [{ title: '科技前沿', lead: '本期两条科技要闻', items: [{ text: 'x', source: 'A' }] }],
  degraded: false,
  aiEnabled: true
});
ok('订阅正常 aiEnabled=true', proOk.aiEnabled === true, proOk.aiEnabled);
ok('订阅正常 degraded=false', proOk.degraded === false, proOk.degraded);
ok('订阅正常 显示 AI 标识', noteKey(proOk) === 'aiTag', noteKey(proOk));

/* ---------- 回归保护：旧服务端不下发 aiEnabled ---------- */
// 旧服务端只在「订阅档落到本地兜底」时给 degraded:true，免费档也会给 true。
// 此时前端必须保守按「本该有 AI」处理，保持旧的降级提示 —— 不能因为新字段缺失就误标成档位说明。
const legacyFree = M.resolveIntelGroups({ subscribed: false, intelItems: items, groups: [], degraded: true });
ok('旧载荷缺 aiEnabled → 保守按 true', legacyFree.aiEnabled === true, legacyFree.aiEnabled);
ok('旧载荷 仍显示错误提示（不回归）', noteKey(legacyFree) === 'intelRawNote', noteKey(legacyFree));

/* ---------- 缺陷 B：AI 导语署名只在「确实由 AI 生成」时显示 ---------- */
// 免费档 aiEnabled=false，导语来自 groupIntelLocally 的纯文本拼接 → 不得挂「— 以下导语由 AI 生成 —」
ok('免费档 不显示 AI 导语署名（本地拼接非 AI 生成）', showLeadTag(free) === false, showLeadTag(free));
ok('订阅正常 显示 AI 导语署名', showLeadTag(proOk) === true, showLeadTag(proOk));
ok('订阅降级 不显示 AI 导语署名', showLeadTag(proDegraded) === false, showLeadTag(proDegraded));
ok('旧载荷 不显示 AI 导语署名（缺 aiEnabled 保守真，但 degraded=true 兜底）', showLeadTag(legacyFree) === false, showLeadTag(legacyFree));

/* ---------- 防过度修复：内容本身不受影响 ---------- */
ok('免费档条目数不变（过滤/分档未吞内容）', free.groups.reduce((n, g) => n + g.items.length, 0) === items.length,
   free.groups.reduce((n, g) => n + g.items.length, 0));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
