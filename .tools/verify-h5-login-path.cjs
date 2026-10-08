#!/usr/bin/env node
/**
 * verify-h5-login-path.cjs —— 验证 src/services/api.ts 的**双端分支**真的按平台走对路。
 *
 * 为什么必须单独验这个分支：
 *   产物里同时存在 `mock-openid-001 / "晨友"` 两个 mock 云函数模块（webpack 模块 5959/7095），
 *   它们**被打包**是正常的（只有 `callFunction(名字)` 才会执行到），
 *   所以「产物里搜得到『晨友』」**不能**证明修复没生效，也**不能**证明生效 ——
 *   静态字符串检索在这个问题上既不能证真也不能证伪。
 *   唯一的判据是：在 H5 平台上跑一次 apiLogin/apiUpdateSettings，看有没有落到云函数。
 *
 * 做法：用 esbuild 把**真实的 api.ts** 打包成 CJS，把 4 个边界模块换成可控桩：
 *   - @tarojs/taro   → 复用 .tools/stubs/stub-taro-storage.cjs（忠实复刻 H5 存储语义）
 *   - ./cloud        → callFunction 记为调用记录（spy）
 *   - ./dataSource   → isWeapp 可变开关
 *   - ./cloudAuth    → getSession 可控
 *   ./localProfile 不替换，走真模块（这才是被验的集成点）。
 *   `import type` 的两处（../types、@/utils/schedule）编译期即擦除，无需桩。
 *
 * 用法: node .tools/verify-h5-login-path.cjs
 * 退出码: 0 = 全 PASS；1 = 有 FAIL
 */
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, '.cache', 'h5-login-path.cjs');
const STUB_TARO = path.join(__dirname, 'stubs', 'stub-taro-storage.cjs');

const V_CLOUD = 'vstub:cloud';
const V_DS = 'vstub:dataSource';
const V_AUTH = 'vstub:cloudAuth';

const virtual = {
  [V_CLOUD]: `
    var calls = (globalThis.__H5_CALLS__ = globalThis.__H5_CALLS__ || []);
    export function callFunction(name, data) {
      calls.push({ name: name, data: data });
      return Promise.resolve({ __mockCloudFunction: name, data: data });
    }
    export function chatLocalStream() { throw new Error('chatLocalStream not used in this test'); }
  `,
  [V_DS]: `
    export let isWeapp = false;
    export function __setIsWeapp(v) { isWeapp = !!v; }
    export function invoke() { return Promise.resolve({}); }
  `,
  [V_AUTH]: `
    export function __setSession(s) { globalThis.__H5_SESSION__ = s; }
    export function getSession() { return Promise.resolve(globalThis.__H5_SESSION__ || null); }
  `,
};

async function build() {
  const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild'));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const plugin = {
    name: 'h5-login-path-stubs',
    setup(b) {
      b.onResolve({ filter: /^@tarojs\/taro$/ }, () => ({ path: STUB_TARO }));
      b.onResolve({ filter: /^vstub:/ }, (a) => ({ path: a.path, namespace: 'vstub' }));
      // 只替换 api.ts 自己引的那三个兄弟模块；别的地方（如 AuthGate）不受影响
      b.onResolve({ filter: /^\.\/(cloud|dataSource|cloudAuth)$/ }, (a) => {
        if (path.basename(a.importer || '') !== 'api.ts') return null;
        const map = { './cloud': V_CLOUD, './dataSource': V_DS, './cloudAuth': V_AUTH };
        return { path: map[a.path], namespace: 'vstub' };
      });
      b.onLoad({ filter: /.*/, namespace: 'vstub' }, (a) => ({
        contents: virtual[a.path],
        loader: 'js',
      }));
    },
  };
  await esbuild.build({
    stdin: {
      contents: [
        "export * from './src/services/api';",
        "export { __setIsWeapp } from 'vstub:dataSource';",
        "export { __setSession } from 'vstub:cloudAuth';",
      ].join('\n'),
      resolveDir: ROOT,
      loader: 'ts',
      sourcefile: 'h5-login-path-entry.ts',
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile: OUT,
    logLevel: 'warning',
    plugins: [plugin],
  });
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
}

(async () => {
  await build();
  const api = require(OUT);

  const store = () => (globalThis.__STORE__ = globalThis.__STORE__ || new Map());
  const calls = () => (globalThis.__H5_CALLS__ = globalThis.__H5_CALLS__ || []);
  const SETTINGS = 'user-settings';
  const reset = () => {
    store().clear();
    calls().length = 0;
    globalThis.__H5_SESSION__ = null;
  };
  const rawSettings = () =>
    store().has(SETTINGS) ? JSON.parse(store().get(SETTINGS)).data : undefined;
  const calledNames = () => calls().map((c) => c.name);

  // 形状 A：user 上带 email —— 这是 maskIdentifier 期望的形状（小程序端云函数返回的就是这个）
  const SESSION = {
    user: { id: 'uid-real-1', email: 'alice@example.test' },
  };
  // 形状 B：**真实 H5 会话形状**。依据 SDK（@tencent-ai/workbuddy-cloud-sdk，lib/index.global.js）：
  //   /v1/token 响应 → parseSession → userFromSessionPayload(r) 返回
  //     { id: typeof r.sub==="string" ? r.sub : "", name, avatarUrl, isAnonymous, raw: r }
  //   —— **没有 email / phone**。带 email 的 parseUser 只被 auth.getUser()(/v1/user/me) 使用。
  //   而 getSession() → sessions.ensure() → store.read()，读的正是 userFromSessionPayload 的产物。
  //   故 H5 上 session.user.email 恒为 undefined，maskIdentifier 必然返回空串。
  const SESSION_REAL_H5 = {
    user: { id: 'uid-real-2', name: '', avatarUrl: '', isAnonymous: false, raw: { sub: 'uid-real-2' } },
  };
  const SESSION_NO_ID = {
    user: { id: '', name: '', avatarUrl: '', raw: {} },
  };

  /* ---- A1/A2：H5 登录必须**不碰** login 云函数，且取真会话 ---- */
  reset();
  api.__setIsWeapp(false);
  api.__setSession(SESSION);
  let p = await api.apiLogin();
  check('A1 H5 apiLogin 不调用 login 云函数（mock 源头）', !calledNames().includes('login'), `calls=[${calledNames()}]`);
  check('A2 H5 apiLogin 用真会话 id 作 openid', p.openid === 'uid-real-1', `openid=${p.openid}`);
  check('A2 会话带 email 时昵称取脱敏邮箱', p.nickname === 'a***@example.test', `nickname=${p.nickname}`);

  /* ---- A2b：真实 H5 会话形状（无 email）—— 记录"脱敏邮箱分支在生产不可达"这个事实 ---- */
  reset();
  api.__setIsWeapp(false);
  api.__setSession(SESSION_REAL_H5);
  const pr = await api.apiLogin();
  check('A2b 真实 H5 会话（无 email）不抛错', !!pr, 'ok');
  check(
    'A2b 无 email 时昵称回落 id 前 8 位（脱敏邮箱分支不可达，见上方 SDK 依据）',
    pr.nickname === 'uid-real',
    `nickname=${pr.nickname}`
  );

  /* ---- A3：H5 无会话必须抛错（不给假档案） ---- */
  reset();
  api.__setIsWeapp(false);
  let threw = null;
  try {
    await api.apiLogin();
  } catch (e) {
    threw = e && e.message;
  }
  check('A3 H5 无会话 → apiLogin 抛 no-cloud-session', threw === 'no-cloud-session', `threw=${threw}`);

  /* ---- A4：会话存在但 id 为空是 SDK 合法态，不得抛错 ---- */
  reset();
  api.__setIsWeapp(false);
  api.__setSession(SESSION_NO_ID);
  threw = null;
  let pn = null;
  try {
    pn = await api.apiLogin();
  } catch (e) {
    threw = e && e.message;
  }
  check('A4 会话无 id → 不抛错', threw === null, `threw=${threw}`);
  check('A4 会话无 id → openid 留空不编造', pn && pn.openid === '', `openid=${pn && JSON.stringify(pn.openid)}`);

  /* ---- A5：小程序端不能被误伤 ---- */
  reset();
  api.__setIsWeapp(true);
  api.__setSession(SESSION); // 即便有会话，weapp 也必须走云函数
  await api.apiLogin();
  check('A5 weapp apiLogin 仍调用 login 云函数', calledNames().includes('login'), `calls=[${calledNames()}]`);
  api.__setIsWeapp(false);

  /* ---- A6/A7：H5 改设置必须落盘、且不碰云函数 ---- */
  reset();
  api.__setIsWeapp(false);
  api.__setSession(SESSION);
  store().set(SETTINGS, JSON.stringify({ data: { nickname: '旧名', replyStyle: 'casual' } }));
  let pu = await api.apiUpdateSettings({ nickname: '新名' });
  check('A6 H5 apiUpdateSettings 不调用 updateSettings 云函数', !calledNames().includes('updateSettings'), `calls=[${calledNames()}]`);
  check('A6 H5 设置真的落盘', rawSettings() && rawSettings().nickname === '新名', JSON.stringify(rawSettings()));
  check('A7 落盘保留其它键', rawSettings() && rawSettings().replyStyle === 'casual', JSON.stringify(rawSettings()));
  check('A7 返回值与落盘一致', pu && pu.nickname === '新名');

  /* ---- A8：会话缺失时先失败、**不落盘**（顺序修复） ---- */
  reset();
  api.__setIsWeapp(false);
  store().set(SETTINGS, JSON.stringify({ data: { nickname: '原值' } }));
  threw = null;
  try {
    await api.apiUpdateSettings({ nickname: '不该写进去' });
  } catch (e) {
    threw = e && e.message;
  }
  check('A8 H5 无会话 → 抛 no-cloud-session', threw === 'no-cloud-session', `threw=${threw}`);
  check('A8 无会话时**没有**污染本地设置', rawSettings() && rawSettings().nickname === '原值', JSON.stringify(rawSettings()));

  /* ---- A9：weapp 改设置仍走云函数 ---- */
  reset();
  api.__setIsWeapp(true);
  await api.apiUpdateSettings({ nickname: '小程序名' });
  check('A9 weapp apiUpdateSettings 仍调用云函数', calledNames().includes('updateSettings'), `calls=[${calledNames()}]`);
  check('A9 weapp 不写本地 user-settings', rawSettings() === undefined, JSON.stringify(rawSettings()));
  api.__setIsWeapp(false);

  /* ---- 汇总 ---- */
  console.log('-----------------------------------------');
  let fail = 0;
  for (const r of results) {
    if (!r.pass) fail++;
    console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` —— ${r.detail}` : ''}`);
  }
  console.log('-----------------------------------------');
  console.log(`PASS ${results.length - fail} / FAIL ${fail}（共 ${results.length} 项）`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('BUILD/RUN ERROR:', e);
  process.exit(1);
});
