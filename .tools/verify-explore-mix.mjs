#!/usr/bin/env node
/**
 * verify-explore-mix.mjs —— 防茧房探索位（src/utils/exploreMix.ts）的行为门禁
 *
 * 守的是四件容易写错的事：
 *  1. **只换席位、不加长** —— 追加会让 limit=3 的情报区变 4 条，直接撑破版式；
 *  2. **比例在 5-8%** —— 写 0.5 等于把列表变成随机流；写 0 等于没做；
 *  3. **确定性** —— 每次渲染都变的话，用户会以为列表坏了；
 *  4. **首条不动** —— 用户最关心的第一条不该被探索位顶掉。
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

const built = await esbuild.build({
  entryPoints: [path.join(ROOT, 'src/utils/exploreMix.ts')],
  bundle: true, write: false, format: 'cjs', platform: 'node'
});
const mod = { exports: {} };
const ctx = { module: mod, exports: mod.exports, require: () => ({}), console, Promise, JSON, Array, Math, Set, Object, String };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(built.outputFiles[0].text, ctx);
const { mixExploration, EXPLORE_RATE, EXPLORE_RATE_MIN, EXPLORE_RATE_MAX } = mod.exports;

const mk = (n, tag, prefix = 'id') => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, tags: [tag] }));
const pool30 = [...mk(20, '科学', 'a'), ...mk(10, '娱乐', 'b')];
const ranked = pool30.slice(0, 20); // 20 条偏好结果

/* ---- 基本契约 ---- */
t('E1 没有偏好 → 原样返回（无茧房可言，不掺）', () => {
  const got = mixExploration(ranked, pool30, []);
  return got.length === ranked.length && got.every((it, i) => it.id === ranked[i].id) ? true : '被改动了';
});

t('E2 有偏好 → **长度不变**（替换席位，不是追加）', () => {
  const got = mixExploration(ranked, pool30, ['科学']);
  return got.length === ranked.length ? true : `长度 ${ranked.length} → ${got.length}`;
});

t('E3 掺入比例落在 5-8%（20 条 → 1-2 条非偏好）', () => {
  const got = mixExploration(ranked, pool30, ['科学']);
  const injected = got.filter((it) => it.tags[0] !== '科学').length;
  const rate = injected / got.length;
  return rate >= EXPLORE_RATE_MIN - 0.001 && rate <= EXPLORE_RATE_MAX + 0.001
    ? true
    : `比例 ${(rate * 100).toFixed(1)}%，注入 ${injected} 条`;
});

t('E4 首条不被替换（用户最关心的第一条保留）', () => {
  const got = mixExploration(ranked, pool30, ['科学']);
  return got[0].id === ranked[0].id ? true : `首条被换成 ${got[0].id}`;
});

t('E5 结果里多数仍是原偏好条目（探索是点缀不是替代）', () => {
  const got = mixExploration(ranked, pool30, ['科学']);
  const kept = got.filter((it) => ranked.some((r) => r.id === it.id)).length;
  return kept / got.length >= 0.9 ? true : `只保留 ${kept}/${got.length}`;
});

t('E6 确定性：同样输入跑两次结果完全一致（不抖动）', () => {
  const a = mixExploration(ranked, pool30, ['科学']).map((it) => it.id).join(',');
  const b = mixExploration(ranked, pool30, ['科学']).map((it) => it.id).join(',');
  return a === b ? true : '两次结果不同';
});

/* ---- 边界 ---- */
t('E7 池子里没有非偏好条目 → 原样返回', () => {
  const same = mk(10, '科学');
  const got = mixExploration(same, same, ['科学']);
  return got.every((it, i) => it.id === same[i].id) ? true : '凭空造出了条目';
});

t('E8 长度 1 的结果不掺（替换会把唯一一条顶掉）', () => {
  const one = [ranked[0]];
  const got = mixExploration(one, pool30, ['科学']);
  return got.length === 1 && got[0].id === one[0].id ? true : JSON.stringify(got);
});

t('E8b 小列表（limit=3 的晨报情报）不掺 —— 掺 1 条就是 33%', () => {
  const three = ranked.slice(0, 3);
  const got = mixExploration(three, pool30, ['科学']);
  return got.every((it, i) => it.id === three[i].id) ? true : JSON.stringify(got.map((it) => it.id));
});

t('E9 rate 超界被夹到 8% 以内（防有人写 0.5）', () => {
  const got = mixExploration(ranked, pool30, ['科学'], 0.5);
  const injected = got.filter((it) => it.tags[0] !== '科学').length;
  return injected / got.length <= EXPLORE_RATE_MAX + 0.001 ? true : `比例 ${(injected / got.length * 100).toFixed(1)}%`;
});

t('E10 只在传入的池子里取（池外的条目绝不出现）', () => {
  const limitedPool = [...ranked, ...mk(3, '娱乐', 'z')];
  const got = mixExploration(ranked, limitedPool, ['科学']);
  return got.every((it) => limitedPool.some((p) => p.id === it.id)) ? true : '引入了池外条目';
});

t('E11 默认比例常量在 5-8% 区间内', () =>
  (EXPLORE_RATE >= EXPLORE_RATE_MIN && EXPLORE_RATE <= EXPLORE_RATE_MAX ? true : String(EXPLORE_RATE)));

/* ---- 接线 ---- */
const cloudSrc = fs.readFileSync(path.join(ROOT, 'src/services/cloud.ts'), 'utf8');
t('W1 两个展示调用点都走同一条入口（不再直接调 selectByPreference）', () => {
  const direct = (cloudSrc.match(/selectByPreference\((payload|hotspot)\.items/g) || []).length;
  const viaEntry = (cloudSrc.match(/selectForDisplay\((payload|hotspot)\.items/g) || []).length;
  return direct === 0 && viaEntry === 2 ? true : `直调 ${direct} 处 / 走统一入口 ${viaEntry} 处`;
});
t('W2 入口里先排序后掺入', () =>
  (/const ranked = selectByPreference\(items, prefs, limit\)/.test(cloudSrc) && /mixExploration\(ranked, items, prefs\)/.test(cloudSrc)
    ? true : '入口实现不合预期'));

const failed = results.filter((r) => !r.pass);
console.log(`\n探索位门禁 —— ${failed.length ? 'FAIL' : 'PASS'}  ${results.length - failed.length}/${results.length}`);
for (const r of results) console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.why ? '  ← ' + r.why : ''}`);
process.exit(failed.length ? 1 : 0);
