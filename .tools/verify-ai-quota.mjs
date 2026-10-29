#!/usr/bin/env node
/**
 * verify-ai-quota.mjs —— AI 对话额度闸门（2026-10-29，审计 P1）
 *
 * 背景：`llm_events` 以前**只写不读**，免费档「每天 20 条」只写在会员页文案里，
 * 实际零拦截 —— 免费用户可无限消耗付费 AI。本门禁守两件事：
 *
 *   A 接线：AI 助手的发送路径上**真的**有闸门，且判据在 setSending(true) 之前
 *     （额度用尽不该让界面进入"发送中"）；记账只在成功回复之后 +1。
 *   B 判据：把纯规则模块编成 CJS 直接跑行为用例，守三条不变量 ——
 *     ① 云端与本地取大（清 localStorage 绕不过云端计数）
 *     ② 云端取不到 ≠ 0（降级仍拦，绝不静默放开）
 *     ③ 订阅 → 不限（remaining = -1，沿用 voiceQuota 约定）
 *
 * 为什么单独拆 `aiQuotaRules.ts` 来测：额度是"扣钱"的逻辑，必须能反复验证；
 * 而 aiQuota.ts 里混着 Taro storage 与云端 count，跑行为测试得先造一堆桩，
 * 桩一多测的就变成桩了。规则纯净 → 直接编译直接跑。
 *
 * 用法: node .tools/verify-ai-quota.mjs
 * 退出码: 0 = 全绿；1 = 有断言失败；2 = harness 自身出错
 */
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { createRequire } from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0;
let fail = 0;
const rows = [];
function assert(name, cond, detail = '') {
  if (typeof cond !== 'boolean') throw new Error(`断言「${name}」的 cond 不是 boolean：${typeof cond}`);
  rows.push({ name, ok: cond, detail });
  if (cond) pass++;
  else fail++;
}

/* ───────────── A. 接线 ───────────── */
const assistant = read('src/components/AiAssistant/index.tsx');
const quotaSrc = read('src/services/aiQuota.ts');
const rulesSrc = read('src/services/aiQuotaRules.ts');
const lang = read('src/store/language.ts');

// ⚠️ 断言必须看在**未注释的代码**上：第一版直接把 `bumpLocalUsage();` 注释掉，
//   字符串仍在文件里、A4/A5 照样通过 —— 变异测试当场抓出这个假绿。
const assistantCode = assistant
  .split('\n')
  .filter((l) => !/^\s*\/\//.test(l))
  .join('\n');

const gateCallIdx = assistant.indexOf('const quota = await getAiQuota();');
const sendingIdx = assistant.indexOf('setSending(true);', gateCallIdx);
const bumpIdx = assistant.indexOf('bumpLocalUsage();');
const successPushIdx = assistant.indexOf("push('assistant', res.reply");

assert('A1 发送路径上调用了额度闸门（getAiQuota）', gateCallIdx > 0, `idx=${gateCallIdx}`);
assert('A2 闸门判据在 setSending(true) 之前（额度用尽不进入"发送中"）', gateCallIdx > 0 && sendingIdx > gateCallIdx);
assert('A3 超限时弹窗引导去订阅，而不是静默失败', /ai\.quotaLimitTitle/.test(assistant) && /pages\/membership\/index/.test(assistant));
const bumpCodeIdx = assistantCode.indexOf('bumpLocalUsage();');
const successCodeIdx = assistantCode.indexOf("push('assistant', res.reply");
assert(
  'A4 记账在**成功回复之后**且真的存在（注释掉不算）',
  bumpCodeIdx > successCodeIdx && successCodeIdx > 0,
  `bump=${bumpCodeIdx} push=${successCodeIdx}`
);
assert('A5 记账只在这一处调用（避免双计）', assistantCode.split('bumpLocalUsage();').length - 1 === 1);
assert('A6 云端计数带 kind=chat 且按日界区间查（不是按天字符串比）', /eq\('kind',\s*'chat'\)/.test(quotaSrc) && /gte\('created_at'/.test(quotaSrc) && /lt\('created_at'/.test(quotaSrc));
assert('A7 云端查询用 count 查询（head:true，不拉全表）', /count:\s*'exact'/.test(quotaSrc) && /head:\s*true/.test(quotaSrc));
assert('A8 云端失败返回 null 而不是 0', /return null;/.test(quotaSrc) && !/catch\s*\{[^}]*return 0;/.test(quotaSrc));
assert('A9 中英文案都在（超限标题 + 含 {n} 的说明）', /'ai\.quotaLimitTitle'/.test(lang) && lang.split("'ai.quotaLimitContent'").length - 1 === 2 && /\{n\}/.test(lang));
const appSrc = read('src/app.tsx');
assert(
  'A10b 订阅回放在启动链上且**未被条件包住**（换设备/清缓存后权益自动恢复）',
  /^\s*void restoreSubscriptionFromOrders\(\)/m.test(appSrc) && /initCloudSync\(\)\.then/.test(appSrc)
);
const membership = read('src/pages/membership/index.tsx');
assert(
  'A11 会员页展示 AI 额度（用户能看到剩余，不只是超限时才弹窗）',
  /getAiQuota/.test(membership) && /mine\.quotaAi/.test(membership)
);
assert('A10 免费额度常量是单一事实源（rules 定义，aiQuota 复用）', /FREE_CHAT_PER_DAY\s*=\s*20/.test(rulesSrc) && /from '\.\/aiQuotaRules'/.test(quotaSrc));

/* ───────────── B. 判据行为 ───────────── */
const out = path.join(ROOT, '.tmp-verify/.ai-quota-rules.cjs');
try {
  await build({
    entryPoints: [path.join(ROOT, 'src/services/aiQuotaRules.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile: out,
    logLevel: 'silent'
  });
} catch (e) {
  console.error('esbuild 编译 aiQuotaRules 失败：', e.message);
  process.exit(2);
}
const require = createRequire(import.meta.url);
const R = require(out);

const free19 = R.decideQuota({ subscribed: false, cloudCount: 19, localUsed: 19 });
assert('B1 免费档第 19 条后仍可发（remaining=1）', free19.remaining === 1 && R.canChat(free19), JSON.stringify(free19));

const free20 = R.decideQuota({ subscribed: false, cloudCount: 20, localUsed: 0 });
assert('B2 云端满 20 条即拦住（清本地镜像也绕不过）', free20.remaining === 0 && !R.canChat(free20), JSON.stringify(free20));

const degraded = R.decideQuota({ subscribed: false, cloudCount: null, localUsed: 5 });
assert('B3 云端取不到 → 降级本地计数（source=local，不是 0）', degraded.source === 'local' && degraded.used === 5 && degraded.remaining === 15, JSON.stringify(degraded));

const degradedFull = R.decideQuota({ subscribed: false, cloudCount: null, localUsed: 20 });
assert('B4 云端取不到且本地已满 → 仍然拦住（降级不等于放开）', !R.canChat(degradedFull), JSON.stringify(degradedFull));

const takeMax = R.decideQuota({ subscribed: false, cloudCount: 3, localUsed: 7 });
assert('B5 云端与本地取大（本地刚 +1、云端还没落库时不低估）', takeMax.used === 7, JSON.stringify(takeMax));

const sub = R.decideQuota({ subscribed: true, cloudCount: 999, localUsed: 999 });
assert('B6 订阅 → 不限，remaining 记 -1（沿用 voiceQuota 约定）', sub.unlimited === true && sub.remaining === -1 && R.canChat(sub), JSON.stringify(sub));

const junk = R.decideQuota({ subscribed: false, cloudCount: -5, localUsed: Number.NaN });
assert('B7 脏输入（负数/NaN）安全归零，不会误放行', junk.used === 0 && junk.remaining === 20, JSON.stringify(junk));

const d1 = new Date(2026, 9, 29, 23, 59, 0);
const d2 = new Date(2026, 9, 30, 0, 0, 1);
assert('B8 跨天切换（本地 23:59 与 00:01 不是同一天）', R.isSameDay({ day: R.dayKey(d1), used: 5 }, d1) && !R.isSameDay({ day: R.dayKey(d1), used: 5 }, d2));
assert('B9 空串/空值不当作今天的记录', R.isSameDay(null, d1) === false && R.isSameDay({}, d1) === false);

fs.rmSync(out, { force: true });

console.log('AI 对话额度闸门');
for (const r of rows) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  → ' + r.detail}`);
console.log(`\n${fail === 0 ? `PASS ${pass} / FAIL 0（共 ${rows.length} 条）` : `PASS ${pass} / FAIL ${fail}（共 ${rows.length} 条）`}`);
process.exit(fail === 0 ? 0 : 1);
