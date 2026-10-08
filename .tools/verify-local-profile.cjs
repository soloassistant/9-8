#!/usr/bin/env node
/**
 * verify-local-profile.cjs —— 直接验证**真实模块** src/services/localProfile.ts。
 *
 * 为什么要单独做这个入口（而不是靠页面驱动 UI）：
 *   本项目的输入是 Taro 的 `Input`，走 Taro 自己的事件代理。用合成 DOM 事件
 *   （nativeSetter + dispatch 'input' + blur）**不会**让 React 侧 state 更新，
 *   于是 `handleBlurNickname` 的守卫 `name === profile.nickname` 直接 return ——
 *   写入根本没发生。实测 before === after，看上去像"没保留其它键"，其实是测试手段失效。
 *   这是本项目第 11 次"验的手段出错被误报成被测对象出错"。
 *
 * 做法：用 esbuild 把真实模块编译成 CJS（把 `@tarojs/taro` 别名到忠实桩），
 * 然后在 Node 里直接调用它。桩严格复刻 Taro 的存储语义（依据
 * node_modules/@tarojs/taro-h5/dist/index.cjs.js:1341/1383/1416）：
 *   setStorageSync → localStorage.setItem(k, JSON.stringify({data:v}))
 *   getStorageSync → 解包返回 data；缺失返回 ''
 *
 * 用法: node .tools/verify-local-profile.cjs
 * 退出码: 0 = 全 PASS；1 = 有 FAIL
 */
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, '.cache', 'localProfile.cjs');

function build() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const esbuild = path.join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild');
  execFileSync(
    process.execPath,
    [
      esbuild,
      path.join(ROOT, 'src', 'services', 'localProfile.ts'),
      '--bundle',
      '--format=cjs',
      '--platform=node',
      `--outfile=${OUT}`,
      `--alias:@tarojs/taro=${path.join(ROOT, '.tools', 'stubs', 'stub-taro-storage.cjs')}`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] }
  );
}
build();

// —— 下面是断言矩阵：直接调用真实模块（不是重写一遍逻辑） ——
const lp = require(OUT);

const S = (globalThis.__STORE__ = globalThis.__STORE__ || new Map());
const KEY = 'user-settings';
const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
}

function seed(obj) {
  S.set(KEY, JSON.stringify({ data: obj }));
}
function raw() {
  return S.has(KEY) ? JSON.parse(S.get(KEY)).data : undefined;
}

/* ---- T1：写入必须保留其它键（本轮声称的核心行为） ---- */
seed({
  nickname: '旧名',
  briefingTime: '06:15',
  preferences: ['科技'],
  replyStyle: 'casual',
  newsEnabled: false,
  morningReminderEnabled: true,
  futureUnknownKey: 'should-survive',
});
const w1 = lp.writeProfileSettings({ nickname: '新名' });
const r1 = raw();
check('T1 目标键已更新', r1.nickname === '新名', `nickname=${r1.nickname}`);
check('T1 保留 replyStyle', r1.replyStyle === 'casual', `replyStyle=${r1.replyStyle}`);
check('T1 保留 newsEnabled', r1.newsEnabled === false, `newsEnabled=${r1.newsEnabled}`);
check(
  'T1 保留 morningReminderEnabled',
  r1.morningReminderEnabled === true,
  `morningReminderEnabled=${r1.morningReminderEnabled}`
);
check('T1 保留未知键（前向兼容）', r1.futureUnknownKey === 'should-survive', `=${r1.futureUnknownKey}`);
check('T1 保留未改的 briefingTime', r1.briefingTime === '06:15', `briefingTime=${r1.briefingTime}`);
check('T1 返回值与落盘一致', w1.nickname === '新名' && w1.briefingTime === '06:15', JSON.stringify(w1));

/* ---- T2：局部写入不得把未提供的键清成默认 ---- */
lp.writeProfileSettings({ briefingTime: '08:00' });
const r2 = raw();
check('T2 只改时间、昵称不动', r2.nickname === '新名', `nickname=${r2.nickname}`);
check('T2 replyStyle 仍在', r2.replyStyle === 'casual', `replyStyle=${r2.replyStyle}`);

/* ---- T3：脏数据必须被 sanitize，不许渗进档案 ---- */
// ⚠️ 这条断言我第一版写错了：原本用 `'25:99'` 当"非法时间"却 FAIL ——
// 根因是代码只校验形状（`/^\d{2}:\d{2}$/` 会让 '25:99' 通过），而我假定它校验范围。
// 判断：缺口值得补（该值可能来自云端同步），所以同时加固了实现；这里形状/范围/边界都覆盖。
seed({ nickname: 123, briefingTime: 'xx:yy', preferences: [1, 'ok', null], replyStyle: 'x' });
const s3 = lp.readProfileSettings();
check('T3 非字符串昵称回落空串', s3.nickname === '', `nickname=${JSON.stringify(s3.nickname)}`);
check('T3 形状非法的时间回落 07:30', s3.briefingTime === '07:30', `briefingTime=${s3.briefingTime}`);
check(
  'T3 偏好只留字符串',
  s3.preferences.length === 1 && s3.preferences[0] === 'ok',
  JSON.stringify(s3.preferences)
);

// 新增：范围非法（形状合法）也必须回落 —— 上一版漏掉的正是这条
seed({ briefingTime: '25:99' });
check('T3b 范围非法的时间回落 07:30', lp.readProfileSettings().briefingTime === '07:30', lp.readProfileSettings().briefingTime);
seed({ briefingTime: '23:59' });
check('T3c 边界 23:59 必须保留', lp.readProfileSettings().briefingTime === '23:59', lp.readProfileSettings().briefingTime);
seed({ briefingTime: '00:00' });
check('T3d 边界 00:00 必须保留', lp.readProfileSettings().briefingTime === '00:00', lp.readProfileSettings().briefingTime);

/* ---- T4：档案构造 —— 真值 / 回落 / 抛错 ---- */
seed({ nickname: '昵称A', briefingTime: '06:15', preferences: ['科技'] });
const p4 = lp.buildProfileFromSession({ user: { id: 'uid-1', email: 'abc@example.test' } });
check('T4 openid 取会话 id', p4.openid === 'uid-1', `openid=${p4.openid}`);
check('T4 昵称取设置', p4.nickname === '昵称A', `nickname=${p4.nickname}`);
check('T4 时间取设置', p4.briefingTime === '06:15', `briefingTime=${p4.briefingTime}`);
check('T4 订阅态不编造', p4.subscribed === false && p4.expiredAt === null, JSON.stringify({ s: p4.subscribed, e: p4.expiredAt }));

seed({ nickname: '', briefingTime: '07:30', preferences: [] });
const p5 = lp.buildProfileFromSession({ user: { id: 'uid-2', email: 'abc@example.test' } });
check('T5 昵称为空 → 用脱敏邮箱', p5.nickname === 'a***@example.test', `nickname=${p5.nickname}`);

const p6 = lp.buildProfileFromSession({ user: { id: 'uid-3' } });
check('T6 无邮箱无昵称 → 用 id 前 8 位', p6.nickname === 'uid-3'.slice(0, 8), `nickname=${p6.nickname}`);

let threw = null;
try {
  lp.buildProfileFromSession({ user: { email: 'x@y.z' } });
} catch (e) {
  threw = e && e.message;
}
check('T7 会话无 id → 抛错不造假', threw === 'no-cloud-session', `threw=${threw}`);
let threw2 = null;
try {
  lp.buildProfileFromSession(null);
} catch (e) {
  threw2 = e && e.message;
}
check('T8 会话为 null → 抛错', threw2 === 'no-cloud-session', `threw=${threw2}`);

/* ---- T9：脱敏函数 ---- */
check('T9 邮箱脱敏', lp.maskIdentifier({ email: 'someone@a.com' }) === 's***@a.com', lp.maskIdentifier({ email: 'someone@a.com' }));
check('T9 手机脱敏', lp.maskIdentifier({ phone: '13800138000' }) === '138****8000', lp.maskIdentifier({ phone: '13800138000' }));
check('T9 都没有 → 空串', lp.maskIdentifier({}) === '', JSON.stringify(lp.maskIdentifier({})));

/* ---- 输出 ---- */
const bad = results.filter((r) => !r.pass);
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name} —— ${r.detail}`);
console.log('-----------------------------------------');
console.log(`PASS ${results.length - bad.length} / FAIL ${bad.length}（共 ${results.length} 项）`);
process.exit(bad.length ? 1 : 0);
