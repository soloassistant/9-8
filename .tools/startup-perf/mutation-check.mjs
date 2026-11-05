#!/usr/bin/env node
/**
 * 变异自检：证明 measure-startup 的门禁/口径校验真的会红，而不是「怎么改都绿」。
 *
 * 三个变异（都只动临时副本，绝不碰仓库 dist / catalog）：
 *   ① 往入口 chunk 注入 200KB 不可压缩垃圾 → gate 必须 exit 1，且主指标显著上涨
 *   ② 把主指标集合改成「只算 app.js」→ 必须 exit 2（口径被修改 / 成员数量不符）
 *   ③ 删掉 build-stamp.json 的 builtAt → 必须 exit 2（不许静默跳过）
 * 另加一条对照：同一份产物用 --threshold 400 → 必须 exit 0（证明门禁能绿，不是永远红）。
 *
 * 用法：npm run verify:startup-perf
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const MEASURE = path.join(HERE, 'measure-startup.mjs');
const CATALOG = path.join(HERE, 'catalog.json');
const DIST = path.join(REPO, 'dist');
const TMP_ROOT = path.join(REPO, '.tmp-startup-perf', 'mutations');
const R = (p) => path.join(TMP_ROOT, p);

const results = [];

function runMeasure({ dist = DIST, catalog = CATALOG, threshold }) {
  const args = [MEASURE, '--gate', '--runs', '1', '--dist', dist, '--catalog', catalog, '--repo', REPO, '--out', path.join(TMP_ROOT, 'out')];
  if (threshold != null) args.push('--threshold', String(threshold));
  const r = spawnSync(process.execPath, args, { cwd: REPO, encoding: 'utf8', timeout: 600000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const mainMatches = [...out.matchAll(/主指标 (\d+\.\d) KB/g)].map((m) => parseFloat(m[1]));
  return { code: r.status, out, mainKB: mainMatches.length ? mainMatches[mainMatches.length - 1] : null };
}

function report(name, condition, evidence) {
  results.push({ name, pass: !!condition, evidence });
  console.log(`\n${condition ? '✓ PASS' : '✗ FAIL'}  ${name}`);
  console.log(evidence.split('\n').map((l) => '    ' + l).join('\n'));
}

function copyDist(dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(DIST, dest, { recursive: true });
  return dest;
}

if (!fs.existsSync(DIST)) {
  console.error(`✗ 被测产物缺失：${DIST}（先构建，不许用旧产物顶上）`);
  process.exit(2);
}

console.log('══════════════════════════════════════════════════════════════');
console.log(' 启动性能口径 / 门禁 · 变异自检');
console.log('══════════════════════════════════════════════════════════════');
fs.mkdirSync(TMP_ROOT, { recursive: true });

// ── 对照：基线产物 + 400KB 阈值 → 必须绿 ─────────────────────────────────────
console.log('\n[0] 对照：原始产物 --threshold 400（证明门禁可绿）');
const base400 = runMeasure({ threshold: 400 });
report(
  '原始产物 / threshold=400 → exit 0',
  base400.code === 0,
  `exit=${base400.code}  main=${base400.mainKB} KB\n${base400.out.split('\n').filter((l) => /主指标|门禁|✓|✗/.test(l)).slice(-4).join('\n')}`
);

// ── 变异 ①：注入 200KB 垃圾 ──────────────────────────────────────────────────
console.log('\n[1] 变异：入口 chunk 注入 200KB 不可压缩垃圾');
const junkDist = copyDist(R('junk/dist'));
const indexHtml = fs.readFileSync(path.join(junkDist, 'index.html'), 'utf8');
const entrySrc = indexHtml.match(/src="(\.?\/?js\/app\.[0-9a-z]+\.js)"/i);
if (!entrySrc) {
  console.error('✗ 找不到入口脚本，无法注入');
  process.exit(2);
}
const entryFile = path.join(junkDist, entrySrc[1].replace(/^\.\//, ''));
const junk = crypto.randomBytes(200 * 1024).toString('base64'); // 随机 base64 ≈ 不可压缩
fs.appendFileSync(entryFile, `\n;window.__startupPerfJunk="${junk}";\n`);
const junkSize = fs.statSync(entryFile).size;
const mutated = runMeasure({ dist: junkDist });
report(
  '注入 200KB 垃圾 → exit 1 且主指标上涨 > 150KB',
  mutated.code === 1 && mutated.mainKB != null && base400.mainKB != null && mutated.mainKB - base400.mainKB > 150,
  `exit=${mutated.code}  主指标 ${base400.mainKB} → ${mutated.mainKB} KB（入口文件 ${junkSize} B）\n${mutated.out.split('\n').filter((l) => /超标|门禁/.test(l)).join('\n')}`
);

// ── 变异 ②：口径被改（只算 app.js） ─────────────────────────────────────────
console.log('\n[2] 变异：主指标集合改成「只算 app.js」');
const badCatalog = R('bad-catalog.json');
const cat = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
cat.mainSet.members = cat.mainSet.members.filter((m) => m.alias === 'app.js');
fs.writeFileSync(badCatalog, JSON.stringify(cat, null, 2));
const catalogOut = runMeasure({ catalog: badCatalog });
report(
  '口径被改成 1 个成员 → exit 2（并指出成员数量/签名不符）',
  catalogOut.code === 2 && /口径|成员|签名/.test(catalogOut.out),
  `exit=${catalogOut.code}\n${catalogOut.out.split('\n').filter((l) => /✗ 无法测量|成员|签名|缺少/.test(l)).join('\n')}`
);

// ── 变异 ③：builtAt 缺失 ────────────────────────────────────────────────────
console.log('\n[3] 变异：删掉 build-stamp.json 的 builtAt');
const noStampDist = copyDist(R('no-builtat/dist'));
const stampPath = path.join(noStampDist, 'build-stamp.json');
const stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
delete stamp.builtAt;
fs.writeFileSync(stampPath, JSON.stringify(stamp, null, 2));
const stampOut = runMeasure({ dist: noStampDist });
report(
  'builtAt 缺失 → exit 2（拒绝静默跳过）',
  stampOut.code === 2 && /builtAt/.test(stampOut.out),
  `exit=${stampOut.code}\n${stampOut.out.split('\n').filter((l) => /✗ 无法测量|builtAt/.test(l)).join('\n')}`
);

// ── 汇总 ────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.pass);
console.log('\n══════════════════════════════════════════════════════════════');
console.log(`变异自检：${results.length - failed.length}/${results.length} PASS`);
for (const r of results) console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}`);
process.exit(failed.length ? 1 : 0);
