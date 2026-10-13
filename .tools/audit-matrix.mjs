#!/usr/bin/env node
/**
 * audit-matrix.mjs —— 逐页 × 逐视口 采集几何/像素判据（只读，不改源码）。
 * 复用 .tools/cdp-probe.mjs（本机 Chrome CDP）+ .tools/cdp-probe-session.js（伪造登录态）+ .tools/png-stats.py。
 *
 * 用法:
 *   node .tools/audit-matrix.mjs [--pages a/pages/x,b] [--viewports 1280x720,1920x1080]
 *                                [--out file.json] [--conc 3] [--wait 6000] [--base http://127.0.0.1:8099]
 *
 * 关键点（避免"验的手段出错"）:
 *  - 直接 spawn node/python 传 argv 数组，不走 shell，杜绝引号/退出码/CRLF 陷阱
 *  - 每个子进程显式分配唯一 CDP_PORT，避免并发端口撞车
 *  - 探针失败(非0退出/解析失败/带 error)一律记录原始片段，不静默当"通过"
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PROBE = path.join(ROOT, '.tools', 'cdp-probe.mjs');
const SESSION = path.join(ROOT, '.tools', 'cdp-probe-session.js');
const EXPR_FILE = path.join(ROOT, '.tools', 'audit-expr.js');
const PNG_STATS = path.join(ROOT, '.tools', 'png-stats.py');
const OUTDIR = path.join(ROOT, '.tools', '.audit');
const NODE = process.execPath;
const PYTHON =
  process.env.PYTHON_BIN ||
  'C:\\Users\\geral\\.workbuddy\\binaries\\python\\versions\\3.13.12\\python.exe';
const CHROME =
  process.env.CHROME_BIN ||
  'C:\\Users\\geral\\.agent-browser\\browsers\\chrome-154.0.8037.92\\chrome.exe';

const ALL_PAGES = [
  { p: 'pages/briefing/index', tab: true },
  { p: 'pages/inbox/index', tab: true },
  { p: 'pages/library/index', tab: true },
  { p: 'pages/calendar/index', tab: true },
  { p: 'pages/mine/index', tab: true },
  { p: 'pages/search/index', tab: false },
  { p: 'pages/history/index', tab: false },
  { p: 'pages/shopping/index', tab: false },
  { p: 'pages/learn/index', tab: false },
  { p: 'pages/learnDetail/index', tab: false },
  { p: 'pages/learnCommunity/index', tab: false },
];

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
}
const base = arg('base', 'http://127.0.0.1:8099');
const pagesArg = arg('pages');
const pages = pagesArg
  ? ALL_PAGES.filter((x) => pagesArg.split(',').some((n) => x.p.includes(n)))
  : ALL_PAGES;
const viewports = arg('viewports', '1280x720,1920x1080')
  .split(',')
  .map((s) => {
    const [w, h] = s.split('x').map(Number);
    return { w, h };
  });
const conc = Number(arg('conc', '3'));
const waitMs = arg('wait', '6000');
const outFile = arg('out', path.join(OUTDIR, 'result.json'));

const expr = fs.readFileSync(EXPR_FILE, 'utf8');

function run(cmd, args, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => resolve({ code: -1, out, err: err + String(e) }));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

async function pngStats(png) {
  const r = await run(PYTHON, [PNG_STATS, png], {});
  try {
    return JSON.parse(r.out);
  } catch {
    return { error: 'png-stats 解析失败', raw: (r.out + r.err).slice(0, 200) };
  }
}

async function probeJob(job, port) {
  const slug = job.page.replace(/\//g, '_');
  const png = path.join(OUTDIR, `${slug}-${job.vp.w}x${job.vp.h}.png`);
  const r = await run(
    NODE,
    [
      PROBE,
      `${base}/#/${job.page}`,
      String(job.vp.w),
      String(job.vp.h),
      '--init-script',
      SESSION,
      '--block-url',
      '*cdn.jsdelivr.net*',
      '--expr',
      expr,
      '--png',
      png,
      '--wait',
      waitMs,
    ],
    { CHROME_BIN: CHROME, CDP_PORT: String(port) }
  );
  let parsed = null;
  try {
    parsed = JSON.parse(r.out);
  } catch {
    /* keep raw */
  }
  const value = parsed && parsed.value ? parsed.value : null;
  const pngS = fs.existsSync(png) ? await pngStats(png) : { error: 'png 未生成' };
  return {
    page: job.page,
    tab: job.tab,
    vp: `${job.vp.w}x${job.vp.h}`,
    probeExit: r.code,
    probeError: parsed ? parsed.error || null : `解析失败: ${(r.out + r.err).slice(0, 300)}`,
    value,
    png: pngS,
    pngPath: png,
  };
}

function judge(row) {
  const v = row.value;
  const { w: vw } = { w: Number(row.vp.split('x')[0]) };
  const [_, vh] = row.vp.split('x').map(Number);
  const expectPanel = Math.min(vw, 500);
  const expectX = (vw - expectPanel) / 2;
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass, detail });
  if (!v) {
    add('probe', false, row.probeError || '无结果');
    return { checks, expected: { expectPanel, expectX }, bad: checks.filter((c) => !c.pass) };
  }
  add('测试态stub', v.stubKept === true, `stubKept=${v.stubKept}`);
  add('hash未跳登录', (v.hash || '').includes(row.page) && !(v.hash || '').includes('login'), `hash=${v.hash}`);
  add('container宽=视口', v.container ? v.container.w === vw : false, v.container ? `container=${v.container.w} 期望${vw}` : 'container 不存在');
  add('panel宽=min(vw,500)', v.panel ? Math.abs(v.panel.w - expectPanel) <= 1 : false, v.panel ? `panel=${v.panel.w} 期望${expectPanel}` : 'panel 不存在');
  add('panel水平居中', v.panel ? Math.abs(v.panel.x - expectX) <= 1 : false, v.panel ? `panel.x=${v.panel.x} 期望${expectX}` : 'panel 不存在');
  add('页面宽>0', (v.page?.w || 0) > 0, `page=${v.page?.w}x${v.page?.h}`);
  add('无横向溢出', (v.scrollW || 0) <= vw + 1, `scrollW=${v.scrollW} 期望<=${vw + 1}`);
  if (row.tab) {
    const ok = v.tabbar && v.tabbar.display !== 'none' && v.tabbar.w <= 501 && Math.abs(v.tabbar.x - (vw - v.tabbar.w) / 2) <= 1;
    add('tabbar可见且居中', ok, v.tabbar ? `display=${v.tabbar.display} w=${v.tabbar.w} x=${v.tabbar.x}` : 'tabbar 不存在');
  } else {
    const ok = !v.tabbar || v.tabbar.display === 'none';
    add('tabbar应隐藏', ok, v.tabbar ? `display=${v.tabbar.display}` : 'tabbar 不存在(视为隐藏)');
  }
  add('png非白屏', row.png?.verdict === 'has-content', `verdict=${row.png?.verdict} nearWhite=${row.png?.near_white_ratio}`);
  add('有文本内容', (v.text || '').length > 0, `text="${(v.text || '').slice(0, 36)}"`);
  return { checks, expected: { expectPanel, expectX }, bad: checks.filter((c) => !c.pass) };
}

async function main() {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const jobs = [];
  for (const pg of pages) for (const vp of viewports) jobs.push({ page: pg.p, tab: pg.tab, vp });
  console.log(`[audit] ${jobs.length} runs (${pages.length} 页 × ${viewports.length} 视口), conc=${conc}`);

  const results = new Array(jobs.length);
  let idx = 0;
  let port = 9400;
  async function worker(wi) {
    while (idx < jobs.length) {
      const my = idx++;
      const p = port++;
      results[my] = await probeJob(jobs[my], p);
    }
  }
  await Promise.all(Array.from({ length: Math.min(conc, jobs.length) }, (_, i) => worker(i)));

  for (const r of results) r.judged = judge(r);
  const out = { generatedAt: new Date().toISOString(), base, viewports, results };
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));

  // 汇总表
  console.log('');
  console.log('页面'.padEnd(26) + '视口'.padEnd(12) + '容器'.padEnd(7) + 'panel宽@x'.padEnd(16) + 'page'.padEnd(12) + 'scrollW'.padEnd(9) + 'tabbar'.padEnd(20) + '近白'.padEnd(8) + 'conclusion');
  console.log('-'.repeat(140));
  let fail = 0;
  for (const r of results) {
    const v = r.value;
    if (!v) {
      console.log(r.page.padEnd(26) + r.vp.padEnd(12) + 'PROBE-FAIL'.padEnd(60) + (r.probeError || '').slice(0, 60));
      fail++;
      continue;
    }
    if (r.judged.bad.length) fail++;
    const tb = v.tabbar ? `${v.tabbar.display}/${v.tabbar.w}@${v.tabbar.x}` : (v.tabbarExists ? '?' : 'absent');
    console.log(
      r.page.padEnd(26) +
        r.vp.padEnd(12) +
        String(v.container?.w ?? '-').padEnd(7) +
        `${v.panel?.w}@${v.panel?.x}`.padEnd(16) +
        `${v.page?.w}x${v.page?.h}`.padEnd(12) +
        String(v.scrollW).padEnd(9) +
        tb.padEnd(20) +
        `${((r.png?.near_white_ratio ?? 0) * 100).toFixed(1)}%`.padEnd(8) +
        (r.judged.bad.length ? `FAIL: ${r.judged.bad.map((b) => b.name).join(',')}` : 'PASS')
    );
  }
  console.log('-'.repeat(140));
  console.log(`总计 ${results.length} runs, 失败 ${fail}. JSON: ${outFile}`);
  for (const r of results) for (const b of r.judged.bad) console.log(`  ✗ ${r.page} @${r.vp} [${b.name}] ${b.detail}`);
  process.exit(0);
}

main().catch((e) => {
  console.error('audit-matrix 异常:', e);
  process.exit(1);
});
