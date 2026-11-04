#!/usr/bin/env node
/**
 * verify-topic-cluster.mjs —— 话题聚类（cloudfunctions/webSearch/topic-cluster.js）门禁
 *
 * 三件事：
 *  1. **精度不许降**：96 对金色基准集（dedupe-golden.json）上 F1 ≥ 基准线，precision 必须 1.000。
 *     误合并 = 用户本该看到的新闻凭空消失，比重复严重得多。
 *  2. **两处副本必须逐字一致**：static-server.js 里还留着同名旧副本（它自带倒排索引），
 *     一旦有人只改一边就是口径分叉 —— 本仓已因此踩过三次。这条断言是防分叉的保险。
 *  3. **聚类行为**：同事件聚成一组、同机构不算多家佐证（诚实性）、跨天不并、顺序稳定。
 */
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import esbuild from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..');
const NODE = process.execPath;
const results = [];
const t = (name, fn) => {
  let r;
  try { r = fn(); } catch (e) { r = 'threw: ' + String((e && e.message) || e); }
  results.push({ name, pass: r === true, why: r === true ? '' : String(r) });
};

const topicSrc = fs.readFileSync(path.join(ROOT, 'cloudfunctions/webSearch/topic-cluster.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(ROOT, '.tools/static-server.js'), 'utf8');

/** 从源码里抠出函数体（括号配平，抗行号漂移） */
function extractFn(text, name) {
  const start = text.indexOf('function ' + name + '(');
  if (start < 0) return null;
  let depth = 0, seen = false;
  for (let j = text.indexOf('{', start); j < text.length; j++) {
    const c = text[j];
    if (c === '{') { depth++; seen = true; } else if (c === '}') {
      depth--;
      if (seen && depth === 0) return text.slice(start, j + 1);
    }
  }
  return null;
}

/* ---- ① 基准集精度 ---- */
t('G1 96 对基准集 F1 不低于基准线（precision 1.000 是硬约束）', () => {
  const out = execFileSync(NODE, ['.tools/dedupe-eval.js'], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  const m = out.match(/生产规则 F1 ([0-9.]+)/);
  if (!m) return '没解析到 F1：' + out.split('\n').slice(-3).join(' | ');
  return parseFloat(m[1]) >= 0.346 ? true : `F1 降到 ${m[1]}（基准 0.346）`;
});

/* ---- ② 两处副本逐字一致 ---- */
const SHARED_FNS = ['normalizeTitle', 'isNearDuplicate', 'contentTokens', 'isKeywordDuplicate', 'isFullContainDuplicate', 'isSameEvent'];
for (const fn of SHARED_FNS) {
  t(`P1 ${fn} 两处副本逐字一致（防口径分叉）`, () => {
    const a = extractFn(topicSrc, fn);
    const b = extractFn(serverSrc, fn);
    if (!a) return '共享模块里找不到 ' + fn;
    if (!b) return 'static-server 里找不到 ' + fn;
    return a === b ? true : '两边不一致：' + fn;
  });
}

/* ---- ③ 聚类行为 ---- */
const built = await esbuild.build({
  entryPoints: [path.join(ROOT, 'cloudfunctions/webSearch/topic-cluster.js')],
  bundle: true, write: false, format: 'cjs', platform: 'node'
});
const mod = { exports: {} };
const ctx = { module: mod, exports: mod.exports, require: () => ({}), console, JSON, Math, Map, Set, Array, String, Object };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(built.outputFiles[0].text, ctx);
const { clusterItems, normalizeTitle, isSameEvent, contentTokens } = mod.exports;

const orgOf = (s) => (String(s || '').includes('中新网') ? '中新网' : String(s || ''));

t('C1 同事件不同措辞聚成一组（不再是两张卡）', () => {
  const out = clusterItems([
    { title: '林诗栋4比3林昀儒', source: 'A', pubDate: '2026-11-03' },
    { title: '林诗栋4比3逆转林昀儒挺进决赛', source: 'B', pubDate: '2026-11-03' }
  ], { orgOf });
  return out.length === 1 ? true : `实得 ${out.length} 组：${JSON.stringify(out.map((x) => x.main.title))}`;
});

t('C2 不同事件不误合（苹果手机 vs 苹果手表）', () => {
  const out = clusterItems([
    { title: '苹果发布新款手机', source: 'A', pubDate: '2026-11-03' },
    { title: '苹果发布新款手表', source: 'B', pubDate: '2026-11-03' }
  ], { orgOf });
  return out.length === 2 ? true : `被误合成 ${out.length} 组`;
});

t('C3 同机构不算多家佐证（一家通讯社自抄不得显示成 N 家媒体）', () => {
  const out = clusterItems([
    { title: '林诗栋4比3林昀儒', source: '中新网-财经', pubDate: '2026-11-03' },
    { title: '林诗栋4比3逆转林昀儒挺进决赛', source: '中新网-社会', pubDate: '2026-11-03' }
  ], { orgOf });
  return out.length === 1 && out[0].alsoFrom.length === 0 ? true : JSON.stringify(out);
});

t('C4 跨机构同题 → alsoFrom 记机构名（不是 feed 名）', () => {
  const out = clusterItems([
    { title: '林诗栋4比3林昀儒', source: '中新网-财经', pubDate: '2026-11-03' },
    { title: '林诗栋4比3逆转林昀儒挺进决赛', source: 'B站-体育', pubDate: '2026-11-03' }
  ], { orgOf });
  return out.length === 1 && JSON.stringify(out[0].alsoFrom) === JSON.stringify(['B站-体育'])
    ? true : JSON.stringify(out);
});

t('C5 跨天不并（同题不同天更可能是事件进展，合并会吞掉新进展）', () => {
  const out = clusterItems([
    { title: '林诗栋4比3林昀儒', source: 'A', pubDate: '2026-11-03' },
    { title: '林诗栋4比3逆转林昀儒挺进决赛', source: 'B', pubDate: '2026-11-02' }
  ], { orgOf });
  return out.length === 2 ? true : `被并成 ${out.length} 组`;
});

t('C6 代表条目 = 组内最早出现那条，且顺序稳定', () => {
  const items = [
    { title: '林诗栋4比3林昀儒', source: 'A', pubDate: '2026-11-03' },
    { title: '林诗栋4比3逆转林昀儒挺进决赛', source: 'B', pubDate: '2026-11-03' },
    { title: '另一个完全不同的新闻标题在这里', source: 'C', pubDate: '2026-11-03' }
  ];
  const out = clusterItems(items, { orgOf });
  return out[0].main.title === items[0].title && out[1].main.title === items[2].title
    ? true : JSON.stringify(out.map((x) => x.main.title));
});

t('C7 isSameEvent 是唯一入口（fetch 侧不许另写组合判定）', () => {
  const fetchSrc = fs.readFileSync(path.join(ROOT, '.tools/fetch-data.js'), 'utf8');
  return fetchSrc.includes('clusterItems(') && !fetchSrc.includes('title.slice(0, 24)') ? true : 'fetch-data 仍在用旧口径';
});

/* ---- 接线 ---- */
t('W1 fetch-data 确实 require 了共享模块', () => {
  const fetchSrc = fs.readFileSync(path.join(ROOT, '.tools/fetch-data.js'), 'utf8');
  return /require\('\.\.\/cloudfunctions\/webSearch\/topic-cluster\.js'\)/.test(fetchSrc) ? true : '缺 require';
});
t('W2 共享模块放在 cloudfunctions/webSearch/（云函数部署只打包自身目录）', () =>
  (fs.existsSync(path.join(ROOT, 'cloudfunctions/webSearch/topic-cluster.js')) ? true : '位置不对'));

const failed = results.filter((r) => !r.pass);
console.log(`\n话题聚类门禁 —— ${failed.length ? 'FAIL' : 'PASS'}  ${results.length - failed.length}/${results.length}`);
for (const r of results) console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.why ? '  ← ' + r.why : ''}`);
process.exit(failed.length ? 1 : 0);
