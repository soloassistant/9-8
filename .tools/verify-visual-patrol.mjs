#!/usr/bin/env node
/**
 * verify-visual-patrol.mjs —— 视觉巡检：文字对比度 + 固定元素遮挡 + 控制台异常。
 *
 * 与 verify-layout 的分工：layout 守「容器几何不塌」，本脚本守「内容可读、不被压」。
 * 度量逻辑全在 patrol-inject.js（浏览器侧表达式），这里只负责起服务、拉探针、判据。
 *
 * 判据（硬伤 = 退出码 1）：
 *   · 任一页出现未捕获异常（[EXCEPTION]）或页面未加载（chrome-error / body 缺失）
 *   · 对比度 < 3.0（WCAG 大字号阈值）：文字基本不可读
 *   · 底（最大滚动位）：固定元素压住带文字内容 ≥5% 面积 —— 内容已滚到底仍被压住，
 *     用户没有任何操作能让它露出来，是真「不可达」
 * 警告（不挡退出码，但逐条列出）：
 *   · 对比度 3.0~4.5（AA 正文阈值未达）
 *   · 顶 / 中滚动位遮挡（顶是悬浮球常态；中是滚动途中的瞬时重叠，再滚一下即让开）
 *   · console.error（应用自己记的错误；探针环境云调用必然失败，属预期噪声）
 *
 * ⚠️ 判据口径变更（2026-10-24）：原「中/底滚动位均判硬伤」是错的 —— 度量用的是
 * window.scrollTo，而 Taro H5 的页面在 .taro_page（position:absolute; overflow:auto）
 * 内滚动，window 恒不滚动；且内容异步增长使 bottom 实际只滚到一小段。
 * 两件事叠加，把大量「再滚 400px 就能让开」的临时重叠误报成永久遮挡。
 * 现已修正为：滚动真实容器 + 等高度长稳 + 只有底（最大滚动位）判硬伤。
 *
 * 用法: node .tools/verify-visual-patrol.mjs [--page <route>] [--json]
 * 退出码: 0 = 无硬伤（或本机无 Chrome 时 SKIP）；1 = 有硬伤
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PROBE = path.join(ROOT, '.tools', 'cdp-probe.mjs');
const SESSION_STUB = path.join(ROOT, '.tools', 'cdp-probe-session.js');
const INJECT = path.join(ROOT, '.tools', 'patrol-inject.js');
const OUTDIR = path.join(ROOT, '.tools', '.patrol-shots');
const LEGAL = path.join(ROOT, 'src', 'data', 'legal.ts');

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  'C:\\Users\\geral\\.agent-browser\\browsers\\chrome-154.0.8037.92\\chrome.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const VIEWPORT = { w: 375, h: 812 };
const PAGES = [
  ['pages/briefing/index', '晨报'],
  ['pages/inbox/index', '收件箱'],
  ['pages/library/index', '热点'],
  ['pages/calendar/index', '日历'],
  ['pages/mine/index', '我的'],
  ['pages/search/index', '搜索'],
  ['pages/ledger/index', '记账'],
  ['pages/shopping/index', '购物'],
  ['pages/sxm/index', '省心买'],
  ['pages/learn/index', '学习'],
];

/** 遮挡判据：中/底滚动位，固定元素压住带文字内容的面积比阈值 */
const OCCLUDE_RATIO = 0.05;
/** 对比度硬伤线（WCAG 大字号下限） */
const CONTRAST_SEVERE = 3.0;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveDist() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '').split('?')[0].split('#')[0]);
    let file = path.join(DIST, url);
    if (!file.startsWith(DIST)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** 同意键的 storage 种子：版本号从 legal.ts 现读，避免与 LEGAL_VERSION 漂移 */
function buildInit() {
  const legalSrc = fs.readFileSync(LEGAL, 'utf8');
  const version = (legalSrc.match(/LEGAL_VERSION = '([^']+)'/) || [])[1];
  if (!version) throw new Error('读不到 LEGAL_VERSION（legal.ts 变了？）');
  const stub = fs.readFileSync(SESSION_STUB, 'utf8');
  const seed =
    `try {\n` +
    `  localStorage.setItem('privacy-consent', JSON.stringify({ data: { agreed: true, version: '${version}', time: Date.now() } }));\n` +
    `  localStorage.setItem('sxm-privacy-consent', JSON.stringify({ data: true }));\n` +
    // 首启引导（Onboarding）是**全屏固定层**，不设这个标记的话每一页都会被它 100% 盖住，
    // 巡检会把「引导层」当成遮挡硬伤，十页全 FAIL —— 真正的遮挡问题反而被淹没。
    // 引导本身由 probe-onboarding.mjs 单独验（两屏截图 + 标记落库 + 刷新不再出现）。
    `  localStorage.setItem('onboarded-v2', JSON.stringify({ data: true }));
  // 2026-10-31：引导判定升级为账号级（5078fec）—— 假登录 uid=probe-user-0001，必须把账号级标记也种上，
  // 否则每页都会弹引导层把巡检全盖住（设备级只剩冷启动兜底语义）。Taro storage 只认 {data:...} 包装。
  localStorage.setItem('onboarded-v2:probe-user-0001', JSON.stringify({ data: true }));\n` +
    `} catch (e) {}\n`;
  const file = path.join(OUTDIR, '_init_patrol.js');
  fs.writeFileSync(file, seed + stub);
  return file;
}

function runProbe(port, route, png, initFile) {
  const expr = fs.readFileSync(INJECT, 'utf8');
  return new Promise((resolve, reject) => {
    const args = [
      PROBE,
      `http://127.0.0.1:${port}/#/${route}`,
      String(VIEWPORT.w),
      String(VIEWPORT.h),
      '--init-script',
      initFile,
      '--block-url',
      '*cdn.jsdelivr.net*',
      '--dismiss-splash',
      '--expr',
      expr,
      '--png',
      png,
      '--logs',
      '--wait',
      '6500',
    ];
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      try {
        const parsed = JSON.parse(out);
        if (parsed.error) return reject(new Error(parsed.error));
        if (!parsed.value) return reject(new Error('probe 无结果: ' + out.slice(0, 300) + err.slice(0, 300)));
        resolve({ value: parsed.value, logs: parsed.logs || [], nav: parsed.navigatedTo, splash: parsed.splashAfter });
      } catch (e) {
        reject(new Error(`解析失败(${code}): ${out.slice(0, 300)} ${err.slice(0, 200)}`));
      }
    });
  });
}

async function main() {
  const asJson = process.argv.includes('--json');
  const onlyPage = process.argv.includes('--page') ? process.argv[process.argv.indexOf('--page') + 1] : null;
  const chrome = CHROME_CANDIDATES.find((c) => fs.existsSync(c));
  if (!chrome) {
    console.log('SKIP verify:visual —— 本机没有可用的 Chrome，跳过视觉巡检（不影响 CI）');
    process.exit(0);
  }
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.log('FAIL verify:visual —— dist/index.html 不存在，请先 npm run build:h5');
    process.exit(1);
  }
  process.env.CHROME_BIN = chrome;
  fs.mkdirSync(OUTDIR, { recursive: true });
  const initFile = buildInit();
  const inject = fs.readFileSync(INJECT, 'utf8');

  const { server, port } = await serveDist();
  const rows = [];
  let hardFails = 0;

  for (const [route, name] of PAGES) {
    if (onlyPage && !route.includes(onlyPage)) continue;
    const png = path.join(OUTDIR, route.replace(/\//g, '_') + '.png');
    let v;
    try {
      v = await runProbe(port, route, png, initFile);
    } catch (e) {
      rows.push({ name, route, error: String(e.message || e) });
      hardFails++;
      continue;
    }
    const val = v.value;
    const severe = val.contrast.filter((c) => c.ratio < CONTRAST_SEVERE);
    const warn = val.contrast.filter((c) => c.ratio >= CONTRAST_SEVERE && c.ratio < c.need);
    const exceptions = v.logs.filter((l) => l.startsWith('[EXCEPTION]'));
    const consoleErrors = v.logs.filter((l) => l.startsWith('[error]'));
    const occlusions = [];
    for (const st of val.states) {
      if (st.tag !== 'bottom') continue; // 只有最大滚动位算硬伤（见文件头口径说明）
      for (const fx of st.fixed) {
        for (const cv of fx.covered) {
          if (cv.ratio >= OCCLUDE_RATIO) occlusions.push({ state: st.tag, fixed: fx.sel, ...cv });
        }
      }
    }
    const topOcclusions = [];
    for (const st of val.states) {
      if (st.tag === 'bottom') continue; // 顶/中都是「滚一下即让开」，只报告
      for (const fx of st.fixed) {
        for (const cv of fx.covered) {
          if (cv.ratio >= OCCLUDE_RATIO) topOcclusions.push({ state: st.tag, fixed: fx.sel, ...cv });
        }
      }
    }
    const pageHard = exceptions.length > 0 || severe.length > 0 || occlusions.length > 0 || !!v.nav?.startsWith('chrome-error') || val.href.includes('chrome-error');
    if (pageHard) hardFails++;
    rows.push({
      name,
      route,
      splashGone: v.splash === 'gone',
      severe,
      warn,
      exceptions,
      consoleErrors,
      occlusions,
      topOcclusions,
      skippedBgImage: val.skippedBgImage || 0,
      scroll: val.scroll,
    });
  }
  server.close();

  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
    process.exit(hardFails > 0 ? 1 : 0);
  }

  console.log('视觉巡检 (verify:visual)  375x812');
  console.log('──────────────────────────────────────────────────────────────────────────────────');
  for (const r of rows) {
    if (r.error) {
      console.log(`${r.name}\t探针失败: ${r.error}`);
      continue;
    }
    const flag = r.severe.length || r.exceptions.length || r.occlusions.length ? 'FAIL' : 'PASS';
    console.log(
      `${r.name}\t${flag}\t对比度硬伤 ${r.severe.length} / 未达AA ${r.warn.length}\t` +
        `遮挡(底/最大滚动) ${r.occlusions.length} / (顶中) ${r.topOcclusions.length}\t` +
        `异常 ${r.exceptions.length} / console.error ${r.consoleErrors.length}\t` +
        `图底跳过 ${r.skippedBgImage}`
    );
    for (const c of r.severe.slice(0, 6)) {
      console.log(`    [硬伤] "${c.text}" ${c.sel} fg=${c.fg} bg=${c.bg} ${c.size}px 对比度 ${c.ratio} < ${c.need}`);
    }
    for (const c of r.warn.slice(0, 6)) {
      console.log(`    [AA  ] "${c.text}" ${c.sel} fg=${c.fg} bg=${c.bg} ${c.size}px 对比度 ${c.ratio} < ${c.need}`);
    }
    for (const o of r.occlusions.slice(0, 6)) {
      console.log(`    [遮挡] ${o.fixed} 压住 ${o.sel}（${Math.round(o.ratio * 100)}%）"${o.text}" @${o.state}`);
    }
    for (const o of r.topOcclusions.slice(0, 3)) {
      console.log(`    [顶中位] ${o.fixed} 压住 ${o.sel}（${Math.round(o.ratio * 100)}%）"${o.text}" @${o.state || 'top'}`);
    }
    for (const e of r.exceptions.slice(0, 3)) console.log(`    [异常] ${e.slice(0, 160)}`);
    for (const e of r.consoleErrors.slice(0, 3)) console.log(`    [错误] ${e.slice(0, 160)}`);
  }
  console.log('──────────────────────────────────────────────────────────────────────────────────');
  console.log(hardFails > 0 ? `结果: FAIL（${hardFails} 页有硬伤）` : '结果: PASS（无硬伤；AA 警告与顶部位遮挡见上）');
  console.log('截图在 .tools/.patrol-shots/');
  process.exit(hardFails > 0 ? 1 : 0);
}

main();
