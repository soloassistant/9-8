#!/usr/bin/env node
/**
 * verify-source-prefs.mjs —— 资讯来源开关（src/utils/sourcePrefs.ts）的行为门禁
 *
 * 守三件事：
 *  1. 存储容错：Taro 缺键返回**空串**（不是 undefined），老数据可能带 {data:...} 包装；
 *  2. 下限保护：不能把可用源关到 3 个以下 —— 全关 = 热点页空掉，那是故障不是偏好；
 *  3. 过滤顺序：被关掉的源整条消失，其余**保持原顺序**（顺序是偏好排序结果，不许重排）。
 */
import path from 'node:path';
import vm from 'node:vm';
import fs from 'node:fs';
import esbuild from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..');
const results = [];
const t = (name, fn) => {
  let r;
  try { r = fn(); } catch (e) { r = 'threw: ' + String((e && e.message) || e); }
  results.push({ name, pass: r === true, why: r === true ? '' : String(r) });
};

const store = {};
const stubPlugin = {
  name: 'stub-taro',
  setup(build) {
    build.onResolve({ filter: /^@tarojs\/taro$/ }, () => ({ path: 'taro', namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      // 同时给 module.exports 与 .default：esbuild 的 ESM 互操作会把 default 再包一层，
      // 只给其中一种时 `import Taro from '@tarojs/taro'` 拿到的是 { default: {...} }，
      // 于是 getStorageSync 变成 undefined —— 门禁会全线 FAIL 且原因看起来像"功能坏了"。
      contents: `const api = {
          getStorageSync: (k) => (k in globalThis.__store ? globalThis.__store[k] : ''),
          setStorageSync: (k, v) => { globalThis.__store[k] = v; },
        };
        module.exports = api;
        module.exports.default = api;`,
      loader: 'js'
    }));
  }
};

const built = await esbuild.build({
  entryPoints: [path.join(ROOT, 'src/utils/sourcePrefs.ts')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  plugins: [stubPlugin]
});
const mod = { exports: {} };
const ctx = { module: mod, exports: mod.exports, require: () => ({}), console, Promise, JSON, Array, String, Object };
ctx.globalThis = ctx;
ctx.__store = store;
vm.createContext(ctx);
vm.runInContext(built.outputFiles[0].text, ctx);
const { readDisabledSources, setSourceEnabled, filterBySourcePrefs, MIN_ENABLED_SOURCES, isSourceEnabled } = mod.exports;

const KEY = 'hotspot-disabled-sources';
const reset = () => { for (const k of Object.keys(store)) delete store[k]; };

/* ---- 存储容错 ---- */
reset();
t('S1 缺键（Taro 返回空串）→ 读到空列表而不是崩', () => (Array.isArray(readDisabledSources()) && readDisabledSources().length === 0 ? true : JSON.stringify(readDisabledSources())));

reset();
store[KEY] = ['源A', '源A', '  ', '源B', 123];
t('S2 去重 / 去空白 / 丢掉非字符串', () => {
  const got = readDisabledSources();
  return JSON.stringify(got) === JSON.stringify(['源A', '源B']) ? true : JSON.stringify(got);
});

reset();
store[KEY] = { data: ['源C'] };
t('S3 兼容 {data:[...]} 包装（老版本同步键写法）', () => {
  const got = readDisabledSources();
  return JSON.stringify(got) === JSON.stringify(['源C']) ? true : JSON.stringify(got);
});

reset();
store[KEY] = '{bad json';
t('S4 坏 JSON 不抛错，退化为空列表', () => (readDisabledSources().length === 0 ? true : '抛了或返回了脏数据'));

/* ---- 过滤管线 ---- */
reset();
const items = [
  { id: 1, source: '源A' },
  { id: 2, source: '源B' },
  { id: 3, source: '源A' },
  { id: 4, source: '源C' }
];
t('F1 没有关闭任何源 → 原样返回（同一引用，零成本）', () => (filterBySourcePrefs(items) === items ? true : '不该复制数组'));

reset();
store[KEY] = ['源A'];
const filtered = filterBySourcePrefs(items);
t('F2 被关掉的源整条消失', () => (filtered.every((it) => it.source !== '源A') ? true : JSON.stringify(filtered)));
t('F3 其余条目保持原顺序（不许重排）', () => {
  const ids = filtered.map((it) => it.id).join(',');
  return ids === '2,4' ? true : '实得 ' + ids;
});

reset();
store[KEY] = ['不存在的源'];
t('F4 关掉不存在的源名不影响任何条目', () => (filterBySourcePrefs(items).length === 4 ? true : '误删了条目'));

/* ---- 下限保护 ---- */
reset();
const all = ['源A', '源B', '源C', '源D'];
store[KEY] = ['源A', '源B']; // 只剩 C、D 两个可用 → 已经低于下限
const r1 = setSourceEnabled('源C', false, all);
t('M1 关闭后可用源会低于下限 → ok:false', () => (r1.ok === false && r1.reason === 'min_keep' ? true : JSON.stringify(r1)));
t('M2 被拒绝时**不改存储**（保持原状，不留半截状态）', () => {
  const got = store[KEY];
  return JSON.stringify(got) === JSON.stringify(['源A', '源B']) ? true : JSON.stringify(got);
});

reset();
store[KEY] = ['源A'];
// 用 5 个源：已关 1 个（余 4），再关 1 个余 3 —— 正好卡在下限上，属于允许
const all5 = ['源A', '源B', '源C', '源D', '源E'];
const r2 = setSourceEnabled('源B', false, all5);
t('M3 关闭后仍 ≥ 下限 → ok:true 且写入生效', () => {
  if (r2.ok !== true) return JSON.stringify(r2);
  return readDisabledSources().includes('源B') ? true : JSON.stringify(readDisabledSources());
});

reset();
store[KEY] = ['源A', '源B'];
setSourceEnabled('源A', true, all);
t('M4 重新打开 → 从黑名单移除', () => {
  const got = readDisabledSources();
  return JSON.stringify(got) === JSON.stringify(['源B']) ? true : JSON.stringify(got);
});

t('M5 下限常量是 3（改小等于放开全关的口子）', () => (MIN_ENABLED_SOURCES === 3 ? true : String(MIN_ENABLED_SOURCES)));

reset();
store[KEY] = ['源A'];
t('M6 isSourceEnabled 与存储一致', () => (isSourceEnabled('源B') === true && isSourceEnabled('源A') === false ? true : '判定不一致'));

/* ---- 接线：一处收口 + UI 真的调 ---- */
const cloudSrc = fs.readFileSync(path.join(ROOT, 'src/services/cloud.ts'), 'utf8');
t('W1 热点载荷出口调用了过滤（全应用一处收口）', () =>
  (/items: filterBySourcePrefs\(payload\.items\)/.test(cloudSrc) ? true : 'cloud.ts 里找不到收口点'));
t('W2 改偏好后会清热点缓存（否则 5 分钟内仍是旧列表）', () =>
  (/export function resetHotspotCache/.test(cloudSrc) ? true : '缺 resetHotspotCache'));

const prefsSrc = fs.readFileSync(path.join(ROOT, 'src/pages/prefs/index.tsx'), 'utf8');
t('W3 偏好页真的写了开关（setSourceEnabled）且改完清缓存', () =>
  (prefsSrc.includes('setSourceEnabled(') && prefsSrc.includes('resetHotspotCache()') ? true : '接线缺失'));
t('W4 源清单取自载荷元信息，不是写死的数组', () =>
  (prefsSrc.includes('getHotspotPayload()') && /p\.sources/.test(prefsSrc) ? true : '源清单来源可疑'));

const failed = results.filter((r) => !r.pass);
console.log(`\n资讯来源开关门禁 —— ${failed.length ? 'FAIL' : 'PASS'}  ${results.length - failed.length}/${results.length}`);
for (const r of results) console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.why ? '  ← ' + r.why : ''}`);
process.exit(failed.length ? 1 : 0);
