/**
 * 验证「跨设备同步冲突不再静默覆盖」（2026-10-19）。
 *
 * 两层：
 *  A. 纯逻辑（utils/syncConflict.ts）：规范化哈希 + classifyPull 判定矩阵 + 冲突列表合并；
 *  B. 接线（读源码 + 编译真实 i18n 字典）：
 *     - cloudSync 用上 classifyPull、pushNow 落确认哈希、collectLocal 跳过未裁决键、导出裁决函数；
 *     - 组件订阅冲突并调用裁决；mine 页挂载组件；
 *     - SYNC_KEYS 的 21 个键在中英文案里都有可读标签（防 storageKey 裸奔）。
 *
 * 运行：node .tools/verify-sync-conflict.mjs
 * 退出码 0 = 全 PASS；1 = 有 FAIL。
 */
import * as esbuild from 'esbuild';
import vm from 'node:vm';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HERE = path.join(REPO, '.tools');
const entry = path.join(HERE, 'verify-sync-conflict-entry.ts');

const cases = [];
const t = (name, ok, detail) => cases.push({ name, ok: ok === true, detail });
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

// ---- A. 编译纯逻辑模块并在 vm 里求值 ----
const buildOne = async (entryFile, aliases) => {
  const built = await esbuild.build({
    entryPoints: [entryFile],
    bundle: true,
    format: 'iife',
    write: false,
    alias: aliases,
    logLevel: 'silent'
  });
  const logs = [];
  const sandbox = {
    console: { log: (...a) => logs.push(a.join(' ')) },
    process: { env: {} }
  };
  vm.createContext(sandbox);
  vm.runInContext(built.outputFiles[0].text, sandbox, { filename: 'entry.iife.js' });
  return JSON.parse(logs.join('\n'));
};

let d = null;
try {
  d = await buildOne(entry, { '@/utils/syncConflict': path.join(REPO, 'src/utils/syncConflict.ts') });
} catch (err) {
  t('编译求值 syncConflict', false, String(err));
}

if (d) {
  t('规范化序列化：键序无关', d.stableOrderA === d.stableOrderB, `${d.stableOrderA}`);
  t('规范化序列化：数组保持有序', d.stableArray === '[{"a":2,"b":1}]', d.stableArray);
  t('规范化序列化：标量原样', d.stableScalar === '"x"', d.stableScalar);
  t('哈希：同内容（键序不同）同值', d.hashPlain === d.hashReordered, d.hashPlain);
  t('哈希：异内容异值', d.hashPlain !== d.hashDiff, d.hashPlain);
  t('哈希：数组与等形对象不同值', d.hashArrVsObj.split('|')[0] !== d.hashArrVsObj.split('|')[1], d.hashArrVsObj);

  t('pull: 远端更旧 → skip', d.pullSkipOlder === 'skip', d.pullSkipOlder);
  t('pull: 时间戳相等 → skip（严格大于才覆盖）', d.pullSkipEqual === 'skip', d.pullSkipEqual);
  t('pull: 本地无值 → restore', d.pullRestoreEmpty === 'restore', d.pullRestoreEmpty);
  t('pull: 本地无值（曾推送过）→ restore', d.pullRestoreNoLocalButConfirmed === 'restore', d.pullRestoreNoLocalButConfirmed);
  t('pull: 本地干净（与确认哈希一致）→ overwrite', d.pullOverwriteClean === 'overwrite', d.pullOverwriteClean);
  t('pull: 本地干净（键序不同）→ overwrite', d.pullOverwriteCleanReordered === 'overwrite', d.pullOverwriteCleanReordered);
  t('pull: 本地有新修改 → conflict（★不再静默覆盖）', d.pullConflictDirty === 'conflict', d.pullConflictDirty);
  t('pull: 本地有值但从未推送 → conflict', d.pullConflictNeverPushed === 'conflict', d.pullConflictNeverPushed);

  t('合并冲突：同键旧 localTs 不覆盖新记录', JSON.stringify(d.mergeResult) === JSON.stringify(['a:1', 'b:2']), JSON.stringify(d.mergeResult));
  t('合并冲突：同键新 localTs 胜出', JSON.stringify(d.mergeNewerWins) === JSON.stringify(['a:2']), JSON.stringify(d.mergeNewerWins));
  t('移除冲突：只删指定键', JSON.stringify(d.withoutResult) === JSON.stringify(['b']), JSON.stringify(d.withoutResult));
}

// ---- B1. cloudSync 接线（读源码）----
const syncSrc = read('src/services/cloudSync.ts');
t('cloudSync 引入 classifyPull', syncSrc.includes("import { classifyPull, mergeConflicts, withoutConflicts, valueHash"), 'import');
t('applyRemoteData 按判定分流（restore/overwrite 才落地）', /outcome === 'conflict'/.test(syncSrc) && /const outcome = classifyPull/.test(syncSrc), 'applyRemoteData');
t('pushNow 落确认哈希', /confirm\[it\.key\] = valueHash\(it\.value\)/.test(syncSrc), 'pushNow');
t('collectLocal 跳过未裁决冲突键', /conflicted\.has\(k\)\)\s*continue/.test(syncSrc), 'collectLocal');
t('冲突持久化 + 订阅导出', syncSrc.includes('cloud-sync-conflict') && syncSrc.includes('export function subscribeSyncConflicts'), 'storage/listeners');
t('裁决函数导出（local/remote 两分支）', /export async function resolveSyncConflicts/.test(syncSrc) && syncSrc.includes("choice === 'remote'") && syncSrc.includes("choice === 'local'"), 'resolveSyncConflicts');

// ---- B2. UI 接线（读源码）----
const compSrc = read('src/components/SyncConflictHint/index.tsx');
t('组件订阅冲突状态', compSrc.includes('subscribeSyncConflicts'), 'component');
t('组件两个裁决按钮都接 resolveSyncConflicts', /handleResolve\(c\.key, 'local'\)/.test(compSrc) && /handleResolve\(c\.key, 'remote'\)/.test(compSrc), 'buttons');
t('mine 页挂载组件', read('src/pages/mine/index.tsx').includes('import SyncConflictHint') && read('src/pages/mine/index.tsx').includes('<SyncConflictHint />'), 'mine page');

// ---- B3. i18n：SYNC_KEYS 每个键都要有中英可读标签 ----
let dictData = null;
try {
  dictData = await buildOne(path.join(HERE, 'verify-sync-conflict-dict-entry.ts'), {
    '@/store/language': path.join(REPO, 'src/store/language.ts'),
    '@tarojs/taro': path.join(HERE, 'verify-sync-conflict-taro-stub.ts')
  });
} catch (err) {
  t('编译求值 language.ts', false, String(err));
}

if (dictData) {
  const zh = dictData.zh;
  const en = dictData.en;
  // SYNC_KEYS 从 cloudSync.ts 源码提取（Node 侧 fs 读，别塞进浏览器包）
  const syncSrc0 = read('src/services/cloudSync.ts');
  const block = syncSrc0.slice(
    syncSrc0.indexOf('const SYNC_KEYS = ['),
    syncSrc0.indexOf('] as const;') + 1
  );
  const syncKeys = Array.from(block.matchAll(/^\s*'([^']+)'/gm)).map((m) => m[1]);
  const uiKeys = ['title', 'desc', 'keepLocal', 'takeRemote', 'toastLocal', 'toastRemote', 'failed'];
  for (const k of uiKeys) {
    const key = `syncConflict.${k}`;
    t(`i18n 双语存在：${key}`, typeof zh[key] === 'string' && zh[key].length > 0 && typeof en[key] === 'string' && en[key].length > 0, `${zh[key] || '-'}`);
    t(`i18n 中英不重复：${key}`, zh[key] !== en[key], '');
  }
  let missing = 0;
  for (const sk of syncKeys) {
    const key = `sync.key.${sk}`;
    const okZh = typeof zh[key] === 'string' && zh[key].length > 0 && zh[key] !== sk;
    const okEn = typeof en[key] === 'string' && en[key].length > 0 && en[key] !== sk;
    if (!okZh || !okEn) {
      missing++;
      t(`i18n 标签缺失：${key}`, false, `zh=${zh[key] || '-'} en=${en[key] || '-'}`);
    }
  }
  if (missing === 0) t(`i18n：${syncKeys.length} 个同步键标签齐全（中英）`, true, `${syncKeys.length} keys`);
  else t(`i18n：同步键标签有 ${missing} 个缺失`, false, `${missing} missing`);
}

const failed = cases.filter((c) => !c.ok);
for (const c of cases) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok || !c.detail ? '' : '  | ' + c.detail}`);
console.log(`\n_RESULT pass=${cases.length - failed.length} fail=${failed.length}`);
process.exit(failed.length ? 1 : 0);
