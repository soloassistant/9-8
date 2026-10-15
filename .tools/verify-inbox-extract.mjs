#!/usr/bin/env node
/**
 * verify-inbox-extract.mjs —— 收件箱「AI 提取」按钮可点性回归（P1-01）。
 *
 * 缺陷背景（2026-10-14 第三方测试报告 P1-01，线上实测）：
 *   actionRow 宽 399.69px，「AI 提取」宽 0px isVisible=false tabIndex=-1，
 *   相邻「添加截图」宽 399.69px（取满整行）→ 剪贴板→提取→日历整条核心链路无法启动。
 *
 * 根因：Taro H5 的 `taro-button-core` 默认样式带 `width:100%`，而 button-reset mixin
 * （src/styles/variables.scss）**没有重置 width**。addButton 只写了 `flex-shrink:0`，
 * 于是它按 100% 宽度占满 actionRow，把 `flex:1` 的 extractButton 挤成 0。
 *
 * 为什么必须真浏览器断言（读 CSS 不算数）：
 *   「产物里有 width:auto」**不能证明**布局对了 —— 还要过 cascade 顺序、
 *   taro-button-core 内联默认样式、真实 flex 分配这三道关。只看编译产物会误判成功。
 *
 * 判据（三条都要，缺一条就可能放过原 bug）：
 *   1. extractButton.getBoundingClientRect().width > 0   —— 非零宽
 *   2. offsetParent/尺寸可见（非 display:none）             —— 可见
 *   3. 真实聚焦 + 可点击（不依赖 tabIndex 猜测）
 *
 * 用法: node .tools/verify-inbox-extract.mjs [--json]
 * 退出码: 0 = 通过（或环境缺 Chrome 时 SKIP）；1 = 按钮仍不可用
 *
 * ⚠️ 变异验证的结论（2026-10-15 实测，务必保留这几条认知）：
 *   1. 正确变异方式是**从 addButton 规则里删掉 `width:auto`**（让它退回继承
 *      taro-button-core 的运行时 width:100%）。删掉后 extract 宽度精确复现为 **0px**、
 *      isVisible=false —— 与线上报告的原始症状逐项一致。
 *   2. `taro-button-core{...width:100%...}` **不在构建产物 CSS 里** —— 它由 Taro 组件
 *      JS 在运行时注入。所以「在 css 文件里搜 width:100% 并改掉」**改不到真凶**，
 *      变异会静默失效、验证脚本假绿（踩过一次：以为变异没生效，其实是变异错了地方）。
 *   3. 同一条 addButton 在产物里出现**两次**（一次来自 @include button-reset 展开，
 *      一次来自 .addButton 本体）。按 anchor 替换时要认准带 `background:var(--brand-soft`
 *      的那一条，否则改错规则、同样假绿。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PROBE = path.join(ROOT, '.tools', 'cdp-probe.mjs');
const SESSION_STUB = path.join(ROOT, '.tools', 'cdp-probe-session.js');
const asJson = process.argv.includes('--json');

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  'C:\\Users\\geral\\.agent-browser\\browsers\\chrome-154.0.8037.92\\chrome.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function serveDist() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
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

function runProbe(url, width, height, expr, waitMs) {
  return new Promise((resolve) => {
    const args = [
      PROBE, url, String(width), String(height),
      '--expr', expr,
      '--wait', String(waitMs),
      '--init-script', SESSION_STUB,
      // 屏蔽 CDN：否则真 SDK 覆盖测试桩，门禁把人踢回登录页，测到的不是收件箱
      '--block-url', 'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com',
    ];
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // cdp-probe.mjs 在模块加载期就读 process.env.CHROME_BIN，必须显式透传
      env: { ...process.env, CHROME_BIN: process.env.CHROME_BIN },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ code: -1, parsed: null, stdout: out, stderr: `${err}\nspawn error: ${e.message}` }));
    child.on('close', (code) => {
      let parsed = null;
      // ⚠️ cdp-probe.mjs 用 JSON.stringify(result, null, 2) 输出 —— 是**多行**格式化 JSON。
      // 取「最后一非空行」会只拿到 "}"，解析必失败（踩过一次：数据明明在 raw 里却报 null）。
      // 直接对整个 stdout 做 JSON.parse。
      try {
        parsed = JSON.parse(out.trim());
      } catch {
        parsed = null;
      }
      resolve({ code, parsed, stdout: out, stderr: err });
    });
  });
}

/**
 * 页内取值脚本：
 *   - 按类名**包含**标识串匹配，而不是「以 -suffix- 结尾」——
 *     CSS Module 产物形如 `index-module__actionRow___NKHfY`，尾部哈希后缀长度不定，
 *     用 endsWith('-actionRow-') 会永远匹配不上（踩过一次：页面明明加载了却报 foundRow:false）。
 *   - 断言「非零宽 + 可见 + 可聚焦」，而不是只看 className 存在
 */
const PAGE_EXPR = `(() => {
  const all = Array.from(document.querySelectorAll('*'));
  // 用 __ 分隔的 CSS Module 类名：index-module__actionRow___HASH
  const byModule = (id) => all.find((el) => {
    const c = typeof el.className === 'string' ? el.className : '';
    return c.split(/\\s+/).some((x) => x.includes('__' + id + '_'));
  });
  const actionRow = byModule('actionRow');
  const extract = byModule('extractButton');
  const add = byModule('addButton');
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100 };
  };
  const visible = (el) => {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  let focused = false;
  if (extract) {
    extract.setAttribute('tabindex', '-1');
    extract.focus();
    focused = document.activeElement === extract;
  }
  return JSON.stringify({
    ready: document.readyState,
    bodyLen: (document.body && document.body.innerText || '').length,
    url: location.href,
    foundRow: !!actionRow,
    rowRect: rect(actionRow),
    extractRect: rect(extract),
    extractVisible: visible(extract),
    extractText: extract ? (extract.innerText || '').trim() : null,
    extractFocusable: focused,
    addRect: rect(add),
    addVisible: visible(add),
    addText: add ? (add.innerText || '').trim() : null,
    tabIndex: extract ? extract.getAttribute('tabindex') : null,
  });
})()`;

async function main() {
  const chrome = CHROME_CANDIDATES.find((p) => {
    try { return fs.existsSync(p); } catch { return false; }
  });
  if (!chrome) {
    const msg = { status: 'SKIP', reason: '未找到 Chrome，跳过（需 CHROME_BIN 或已安装 Chrome）' };
    console.log(asJson ? JSON.stringify(msg) : `[SKIP] ${msg.reason}`);
    return 0;
  }
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    const msg = { status: 'SKIP', reason: 'dist 不存在，先跑 npm run build:h5' };
    console.log(asJson ? JSON.stringify(msg) : `[SKIP] ${msg.reason}`);
    return 0;
  }

  process.env.CHROME_BIN = chrome;
  const { server, port } = await serveDist();
  const base = `http://127.0.0.1:${port}`;
  const cases = [
    { name: '375x812 (窄屏手机)', w: 375, h: 812 },
    { name: '1280x720 (桌面)', w: 1280, h: 720 },
  ];
  const results = [];
  try {
    for (const c of cases) {
      // 等 9s：实测取样竞态会伪装成「白屏」（ready:"interactive" + innerText 空），
      // 探针没等到就求值会误判页面坏了。见记忆里的坑 6。
      const r = await runProbe(`${base}/#/pages/inbox/index`, c.w, c.h, PAGE_EXPR, 9000);
      let data = null;
      // cdp-probe.mjs 已把 --expr 的返回值解析好放进 .value：
      // 若它是字符串就再解一层，否则直接用（探针的输出结构，别重复解析）。
      if (r.parsed && r.parsed.value != null) {
        if (typeof r.parsed.value === 'string') {
          try { data = JSON.parse(r.parsed.value); } catch { data = null; }
        } else {
          data = r.parsed.value;
        }
      }
      results.push({
        viewport: c.name,
        w: c.w,
        h: c.h,
        data,
        probeCode: r.code,
        raw: r.parsed,
        stderr: r.stderr ? r.stderr.slice(0, 400) : '',
        stdout: r.stdout ? r.stdout.slice(0, 4000) : '',
      });
    }
  } finally {
    server.close();
  }

  const checks = [];
  for (const r of results) {
    const d = r.data;
    const label = r.viewport;
    if (!d) {
      checks.push({
        viewport: label,
        pass: false,
        why: `探针未取到页面数据（probeCode=${r.probeCode}）`,
        raw: r.raw,
        stderr: r.stderr,
        stdout: r.stdout,
      });
      continue;
    }
    if (!d.foundRow) {
      checks.push({ viewport: label, pass: false, why: '未找到 actionRow —— 可能被门禁挡在登录页' });
      continue;
    }
    const w = d.extractRect && d.extractRect.w;
    const okWidth = typeof w === 'number' && w > 0;
    const okVisible = d.extractVisible === true;
    const okFocus = d.extractFocusable === true;
    // 「添加截图」不该再取满整行 —— 那是原 bug 的另一个可观测信号
    const rowW = d.rowRect && d.rowRect.w;
    const addW = d.addRect && d.addRect.w;
    const okAddNotFull = typeof rowW === 'number' && typeof addW === 'number' && addW < rowW - 1;
    checks.push({
      viewport: label,
      pass: okWidth && okVisible && okFocus && okAddNotFull,
      why: okWidth && okVisible && okFocus && okAddNotFull
        ? `extract ${w}px 可见可聚焦；add ${addW}px < row ${rowW}px`
        : `extract宽=${w} 可见=${okVisible} 可聚焦=${okFocus} add未占满=${okAddNotFull}`,
      detail: d,
    });
  }

  const pass = checks.every((c) => c.pass);
  const out = { status: pass ? 'PASS' : 'FAIL', checks };
  if (asJson) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(`\n收件箱「AI 提取」按钮可点性 —— ${out.status}`);
    for (const c of checks) {
      console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.viewport}: ${c.why}`);
    }
  }
  return pass ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('[verify-inbox-extract] crashed:', err && err.message ? err.message : err);
  process.exit(2);
});