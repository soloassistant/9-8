/**
 * 撤回健康数据同意 → 停止上传运动轨迹（2026-11-04，P0）。
 *
 * 事故：`healthConsent.withdrawHealthConsent` 只删本地同意键；而 `sportRuns`（含 GPS 轨迹）
 * 仍在 `SYNC_KEYS`，`pushNow` 每 30s 把本地所有同步键整包上传 ⇒ **撤回后轨迹继续外传**，
 * 与「撤回后不再记录新数据」的告知不一致（敏感个人信息）。
 *
 * 这是静态不变量检查（不依赖浏览器/云环境）：任何一处闸门被删掉都会立刻变红。
 * 端到端事实（撤回后 60s 内零请求含 sportRuns、云端行确已删除）仍需在 H5 真机上跑一次。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import esbuild from 'esbuild';

const root = new URL('..', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');

const ROOT = path.resolve(import.meta.dirname, '..');
const TARO_STUB = path.join(ROOT, '.tools', 'stubs', 'stub-taro-storage.cjs');
const SYNC_STUB = path.join(ROOT, '.tools', 'stubs', 'stub-cloud-sync-health.cjs');
const nodeRequire = createRequire(import.meta.url);

const sync = read('src/services/cloudSync.ts');
const db = read('src/services/cloudDb.ts');
const health = read('src/services/healthConsent.ts');
const sport = read('src/pages/sport/index.tsx');
const app = read('src/app.tsx');
const lang = read('src/store/language.ts');

let pass = 0;
let fail = 0;
const ok = (msg, cond) => {
  if (cond) {
    pass += 1;
    console.log(`PASS  ${msg}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${msg}`);
  }
};

const idx = (src, needle) => src.indexOf(needle);

// ── A. 撤回顺序：先摘同步范围 → 取消待发送 → 等在途 → 清标记 → 删云端 ──
const exIdx = idx(health, 'setSyncKeyExcluded(SPORT_SYNC_KEY, true)');
const cancelIdx = idx(health, 'cancelPendingPush();');
const idleIdx = idx(health, 'await waitForPushIdle();');
const removeIdx = idx(health, 'Taro.removeStorageSync(HEALTH_CONSENT_KEY)');
const purgeIdx = idx(health, 'purgeSyncKeysFromCloud([SPORT_SYNC_KEY])');

ok(
  'A1 撤回第一步就摘出同步范围（早于清同意标记）',
  exIdx > 0 && removeIdx > 0 && exIdx < removeIdx
);
ok(
  'A2 撤回先取消待发送的防抖推送（否则 1.5s 后还有一次出网）',
  cancelIdx > 0 && cancelIdx < removeIdx
);
ok(
  'A3 撤回先等在途推送落地，再删云端副本（避免删完又被追加一行）',
  idleIdx > 0 && idleIdx < removeIdx
);
ok('A4 撤回最后删除云端副本并返回结果', purgeIdx > 0);

// ── B. 同步侧四道闸：漏一处就还有一条出网/回流路径 ──
ok(
  'B1 collectLocal 不打包被排除键（forceEmptyKeys 也绕不过）',
  /for \(const k of SYNC_KEYS\)[\s\S]{0,220}if \(runtimeExcludedKeys\.has\(k\)\) continue;/.test(sync)
);
ok(
  'B2 撤回后写入不再排推送（markDirty 短路）',
  /const markDirty = \(key: string\) =>[\s\S]{0,220}if \(runtimeExcludedKeys\.has\(key\)\) return;/.test(sync)
);
ok(
  'B3 撤回后删除本机记录不写删除占位、不排推送（removeItem 短路）',
  /ls\.removeItem = \(key: string\) =>[\s\S]{0,220}if \(runtimeExcludedKeys\.has\(key\)\) return;/.test(sync)
);
ok(
  'B4 applyRemoteData 不把被排除键的云端值拉回本机',
  sync.includes('if (runtimeExcludedKeys.has(row.key)) continue;') &&
    sync.includes('if (runtimeExcludedKeys.has(base)) continue;')
);
ok(
  'B5 推送串行化（撤回时排在队列里的那次不会带着旧快照发出去）',
  /const previous = pushInFlight;/.test(sync) && /await doPush\(forceEmptyKeys\);/.test(sync)
);

// ── C. 云端副本删除：真删 + 回读校验 + 失败排队重试 ──
ok(
  'C1 走 user_kv 的 RLS 直删（.delete + in(key)），不新增 RPC/迁移',
  /db\.from\('user_kv'\)\.delete\(\)\.in\('key', keys\)/.test(db)
);
ok(
  'C2 删除失败如实返回 null（不用 unwrap 把成功 data=null 判成失败）',
  /export async function kvDeleteKeys[\s\S]{0,400}return null;/.test(db) &&
    !/unwrap\([^)]*kvDeleteKeys/.test(db)
);
ok(
  'C3 删完回读校验（DELETE 成功 ≠ 行真的没了）',
  /purgeSyncKeysFromCloud[\s\S]{0,700}kvGetAll\(\)/.test(sync) &&
    /const leftover = rows\.filter\(\(r\) => keys\.includes\(r\.key\)\)/.test(sync)
);
ok(
  'C4 删除失败排队，并在每轮推送里补删（“稍后会重试”）',
  /queuePurge\(keys\)/.test(sync) && /await flushPendingPurges\(\)/.test(sync)
);

// ── D. 刷新后仍生效 + UI 明确告知 + 文案与实现一致 ──
ok(
  'D1 启动时按已持久化的同意状态重建排除表，且在 initCloudSync 之前',
  /syncHealthSyncExclusion\(\);\r?\nvoid initCloudSync\(\)/.test(app)
);
ok(
  'D2 重新授权恢复同步（不同结果都要有提示）',
  health.includes("setSyncKeyExcluded('sportRuns', false)") &&
    /result === 'deleted'[\s\S]{0,200}result === 'failed'[\s\S]{0,200}health\.withdrawnLocalOnly/.test(sport)
);
ok(
  'D3 撤回告知写明“不再上传”，不再只说“不再记录”',
  lang.includes('也不再向云端上传任何记录') && lang.includes('云端副本将被删除')
);
ok(
  'D4 同意文案与实现一致（撤回后不再上传、云端副本删除）',
  lang.includes('撤回后不再记录、也不再上传任何记录，云端副本会被删除')
);
ok(
  'E1 同意按钮文案 ≤ 4 字（Taro/微信 showModal 超长会 fail，授权弹窗永不出现）',
  /^  'health\.consentAgree': '([^']*)',$/m.test(lang) &&
    [...(lang.match(/^  'health\.consentAgree': '([^']*)',$/m) || [])[1] || ''].length <= 4
);
ok(
  'E2 弹窗 confirmText 引用该文案（不是硬编码长串）',
  /confirmText: t\('health\.consentAgree'\)/.test(health)
);

// ── F. 按端选文案：运行时真跑（不是 grep 源码）──
// weapp 没有 KV 同步层，沿用「同步到云端备份」就是虚假告知。把 TARO_ENV 定义成 weapp、
// 用桩 Taro 捕获 showModal 的 content，断言用词与实际能力一致；文案一改回旧口径立刻红。
async function loadHealthModule(weapp, lang = 'zh') {
  const built = await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/services/healthConsent.ts')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    alias: { '@tarojs/taro': TARO_STUB, '@': path.join(ROOT, 'src') },
    define: { 'process.env.TARO_ENV': JSON.stringify(weapp ? 'weapp' : 'h5') },
    plugins: [
      {
        name: 'health-sync-stub',
        setup(build) {
          build.onResolve({ filter: /^\.\/cloudSync$/ }, () => ({ path: SYNC_STUB, external: true }));
        }
      }
    ],
    logLevel: 'silent'
  });
  // 桩状态必须挂在 **vm 沙箱** 的 globalThis 上（桩代码在 vm 内执行，读的是它自己的 globalThis）
  const seed = new Map();
  if (lang === 'en') seed.set('app-lang', JSON.stringify({ data: 'en' }));
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require: nodeRequire,
    console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
    process,
    setTimeout,
    clearTimeout,
    Date,
    Promise,
    JSON,
    Math,
    __STORE__: seed,
    __MODAL_LOG__: [],
    __MODAL_CONFIRM__: true
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(built.outputFiles[0].text, sandbox, { filename: 'healthConsent.ts' });
  return { mod: sandbox.module.exports, sandbox };
}

let lastSandbox = null;
const lastModal = () => ((lastSandbox && lastSandbox.__MODAL_LOG__) || [])[0] || {};
async function loadHealth(weapp, lang = 'zh') {
  const loaded = await loadHealthModule(weapp, lang);
  lastSandbox = loaded.sandbox;
  return loaded.mod;
}

const zhWeappConsent = await loadHealth(true, 'zh');
await zhWeappConsent.ensureHealthConsent();
const zhAgreeModal = lastModal();
ok(
  'F1 小程序端同意弹窗写「不会上传云端」，不写「同步到云端备份」',
  typeof zhAgreeModal.content === 'string' &&
    zhAgreeModal.content.includes('不会上传云端') &&
    !zhAgreeModal.content.includes('同步到云端备份')
);

const zhWeappWithdraw = await loadHealth(true, 'zh');
await zhWeappWithdraw.confirmWithdrawHealthConsent();
const zhWithdrawModal = lastModal();
ok(
  'F2 小程序端撤回弹窗写「没有云端副本需要删除」，不写「云端副本将被删除」',
  typeof zhWithdrawModal.content === 'string' &&
    zhWithdrawModal.content.includes('没有云端副本需要删除') &&
    !zhWithdrawModal.content.includes('云端副本将被删除')
);

const enWeappConsent = await loadHealth(true, 'en');
await enWeappConsent.ensureHealthConsent();
const enAgreeModal = lastModal();
ok(
  'F3 小程序端英文同意文案不承诺上传云端',
  typeof enAgreeModal.content === 'string' &&
    enAgreeModal.content.includes('does not upload them to the cloud') &&
    !enAgreeModal.content.includes('back up these records to the cloud')
);

const enWeappWithdraw = await loadHealth(true, 'en');
await enWeappWithdraw.confirmWithdrawHealthConsent();
const enWithdrawModal = lastModal();
ok(
  'F4 小程序端英文撤回文案写「no cloud copy to delete」',
  typeof enWithdrawModal.content === 'string' &&
    enWithdrawModal.content.includes('no cloud copy to delete') &&
    !enWithdrawModal.content.includes('the cloud copy is deleted')
);

const h5Consent = await loadHealth(false, 'zh');
await h5Consent.ensureHealthConsent();
const h5AgreeModal = lastModal();
ok(
  'F5 H5 仍然如实告知「同步到云端备份」（不能被小程序文案误伤）',
  typeof h5AgreeModal.content === 'string' && h5AgreeModal.content.includes('同步到云端备份')
);

ok(
  'F6 运动页撤回提示在小程序端走「本机无云端副本」，不再说「未登录」',
  /process\.env\.TARO_ENV === 'weapp'[\s\S]{0,160}t\('health\.withdrawnWeapp'\)/.test(sport) &&
    !/health\.withdrawnWeapp'[^,]*未登录/.test(lang)
);

console.log(`\n[health-consent] PASS ${pass} / FAIL ${fail}`);
if (fail > 0) {
  console.error('[health-consent] 撤回后轨迹仍可能外传，疑似回退。');
  process.exit(1);
}
