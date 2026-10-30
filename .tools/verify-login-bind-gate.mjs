#!/usr/bin/env node
/**
 * verify-login-bind-gate.mjs —— 登录后「绑定手机号」门禁决策回归（2026-10-21）。
 *
 * 背景：geraldnelsonfung@gmail.com 这个邮箱账号在后端其实没挂手机号（phone 身份是
 * 独立账号），而旧 afterLogin 的判据 `if (s?.user?.phone)` 在 H5 会话里恒 undefined
 * （wb-sdk 的 userFromSessionPayload 根本不带 phone），于是邮箱登录永远强弹「绑定手机号」；
 * 更糟的是旧代码只在「跳过」时写标记、绑定成功从不写标记 → 每次登录都重新强弹，形成死循环。
 *
 * 本 harness 用 esbuild 就地编译 src/services/bindPhoneGate.ts（纯函数，无 Taro/React 依赖），
 * 跑表驱动用例，并对「变异版」源码跑同样的用例，确认测试能抓住回归（不是假绿）。
 *
 * 用法: node .tools/verify-login-bind-gate.mjs [--json]
 * 退出码: 0 = 全通过；1 = 用例失败；2 = harness 自身出错
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import esbuild from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src', 'services', 'bindPhoneGate.ts');
const asJson = process.argv.includes('--json');
const log = (...a) => { if (!asJson) console.log(...a); };

const source = readFileSync(SRC, 'utf8');

/** 编译一个源码变体（real 或 mutated）为可求值的 iife，导出 decidePostLogin。 */
async function buildVariant(srcText) {
  const harnessSrc = `${srcText}\nglobalThis.__t = { decidePostLogin: decidePostLogin };`;
  const built = await esbuild
    .build({
      stdin: { contents: harnessSrc, loader: 'ts', resolveDir: path.join(ROOT, 'src', 'services') },
      bundle: true,
      format: 'iife',
      platform: 'neutral',
      write: false,
      minify: false,
      treeShaking: false,
    })
    .catch((e) => {
      console.error('[FAIL] esbuild 编译失败：', e && e.message ? e.message : e);
      process.exit(2);
    });
  const sandbox = { console, globalThis: undefined };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  try {
    vm.runInContext(built.outputFiles[0].text, sandbox);
  } catch (e) {
    console.error('[FAIL] 求值失败：', e && e.message ? e.message : e);
    process.exit(2);
  }
  return sandbox.__t && sandbox.__t.decidePostLogin;
}

const decideReal = await buildVariant(source);
if (typeof decideReal !== 'function') {
  console.error('[FAIL] 真实 decidePostLogin 未成功导出 —— harness 没真正跑到被测逻辑（这是 harness 问题，不是通过）。');
  process.exit(2);
}

/* 变异：把「本机曾绑定/跳过就不强弹」这条判定改成恒 false，模拟修复被回退。
 * 正确行为下这条变异必须让 flag 类用例失败 —— 否则测试是假绿。 */
const MUT_MARK = 'if (input.boundDone || input.dismissed) return \'enter-app\';';
if (!source.includes(MUT_MARK)) {
  console.error('[FAIL] 找不到变异锚点，源码可能被改写，无法做变异验证。');
  process.exit(2);
}
const mutated = source.replace(MUT_MARK, "if (false) return 'enter-app';");
const decideMut = await buildVariant(mutated);
if (typeof decideMut !== 'function') {
  console.error('[FAIL] 变异版 decidePostLogin 未成功导出。');
  process.exit(2);
}

/* ── 用例注册（判据必须 ok === true，与 verify-extract-coerce.mjs 同纪律） ── */
const results = [];
function t(name, fn) {
  try {
    const ok = fn();
    if (ok === true) results.push({ name, pass: true, why: '' });
    else results.push({ name, pass: false, why: ok ? String(ok) : 'returned falsy: ' + String(ok) });
  } catch (e) {
    results.push({ name, pass: false, why: `threw: ${e.message}` });
  }
}

/* 真实版：必须全部通过 */
t('会话带手机号 → 进应用（前向兼容）', () => decideReal({ phone: '13800000000' }) === 'enter-app');
t('邮箱账号、本机已绑定 → 进应用（修复点：不再死循环强弹）', () => decideReal({ phone: null, boundDone: true }) === 'enter-app');
t('邮箱账号、本机曾跳过 → 进应用', () => decideReal({ phone: null, dismissed: true }) === 'enter-app');
t('邮箱账号、从未绑定也未跳过 → 仍强弹绑定（硬约束不被破坏）', () => decideReal({ phone: null, boundDone: false, dismissed: false }) === 'show-bind');
t('phone 为空串视为无 → 仍强弹', () => decideReal({ phone: '', boundDone: false }) === 'show-bind');
t('已绑定 + 已跳过 → 进应用', () => decideReal({ phone: null, boundDone: true, dismissed: true }) === 'enter-app');
t('手机号优先于本地标记', () => decideReal({ phone: '13900000000', boundDone: false, dismissed: false }) === 'enter-app');
// 复刻真实 bug 的两次登录场景：
t('复刻 BUG：首次邮箱登录（未绑定）→ 强弹', () => decideReal({ phone: null, boundDone: false, dismissed: false }) === 'show-bind');
t('复刻 BUG：用户绑完后再登录（boundDone=true）→ 不再弹', () => decideReal({ phone: null, boundDone: true, dismissed: false }) === 'enter-app');

/* 变异版：必须抓到回归 —— 至少「已绑定」用例要判错 */
const mutCases = [
  { label: '变异版 已绑定 → 应被误判为强弹', input: { phone: null, boundDone: true }, expect: 'enter-app' },
  { label: '变异版 已跳过 → 应被误判为强弹', input: { phone: null, dismissed: true }, expect: 'enter-app' },
];
const mutFailures = mutCases.filter((c) => decideMut(c.input) !== c.expect);
t('变异验证：回退修复后测试能抓住（已绑定/跳过被误判强弹）', () => {
  if (mutFailures.length === 0) return '变异版未产生任何误判 —— 测试没能抓住回归（假绿）';
  return true;
});

/* ── 逃生口的形状（2026-10-30）：光验纯函数不够 ──
 * `decidePostLogin({dismissed:true})` → enter-app 本身没错，但它假设「dismissed 是可信的」。
 * 真正的口径是**什么时候允许用户把 dismissed 写成 true**，以及**它能维持多久**。
 * 之前「稍后再说」常驻 + 标记永久有效 ⇒ 一次点击就是这台设备的永久豁免，
 * 与 docs/competitive-analysis-2026-10-19.md:153 写的「强制绑手机」正好相反。
 * 所以这三条查页面侧的真实写法，不查纯函数。 */
const loginSrc = readFileSync(path.join(ROOT, 'src/pages/login/index.tsx'), 'utf8');

t('逃生口：跳过按钮受条件包裹（不是常驻）', () => {
  const hit = /bindTrouble\s*\|\|\s*bindFailCount\s*>=\s*3/.test(loginSrc);
  if (!hit) return '找不到「仅在发码异常 / 连续失败 3 次后才给跳过」的条件';
  // 反面：不能又退化成"无条件渲染"（找 onClick={skipBind} 外层的 {…? … : null}）
  const guarded = /\{bindTrouble\s*\|\|\s*bindFailCount\s*>=\s*3\s*\?/.test(loginSrc);
  return guarded || '条件存在但没包住按钮，可能仍常驻';
});

t('逃生口：跳过标记写的是时间戳（可过期），不是恒 true', () => {
  const bad = /setStorageSync\(PHONE_BIND_DISMISSED_KEY,\s*true\)/.test(loginSrc);
  if (bad) return '仍在写 true —— 一次跳过=永久豁免';
  return /setStorageSync\(PHONE_BIND_DISMISSED_KEY,\s*Date\.now\(\)\)/.test(loginSrc) || '没找到写时间戳';
});

t('逃生口：读取时按 TTL 判定，过期即重新要求绑定', () => {
  const hasTtl = /BIND_DISMISS_TTL_MS/.test(loginSrc) && /Date\.now\(\)\s*-\s*at\s*<\s*BIND_DISMISS_TTL_MS/.test(loginSrc);
  if (!hasTtl) return '没有 TTL 判定';
  return !/getStorageSync\(PHONE_BIND_DISMISSED_KEY\)\s*===\s*true/.test(loginSrc) || '读取处还在用 === true';
});

/* ── 汇总 ── */
const failed = results.filter((r) => !r.pass);
const out = { status: failed.length ? 'FAIL' : 'PASS', pass: results.length - failed.length, total: results.length, failures: failed };
if (asJson) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`\n登录绑定门禁决策（编译自 src/services/bindPhoneGate.ts 真实源码）—— ${out.status}  ${out.pass}/${out.total}`);
  for (const r of results) console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.why ? '  ← ' + r.why : ''}`);
}
process.exit(failed.length ? 1 : 0);
