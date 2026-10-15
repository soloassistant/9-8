#!/usr/bin/env node
/**
 * verify-ledger-page.mjs —— 记账页真浏览器端到端回归。
 *
 * 为什么单元测试之外还要这个：.tools/verify-ledger-aggregate.mjs 只测了**算得对不对**，
 * 但记账页还有一堆「算对了但页面 unusable」的风险：
 *   · flex 行里的 Button 被 taro-button-core 的 width:100% 挤成 0（收件箱踩过，P1-01）
 *   · 分类弹层选不中 / 金额输入框被挤没
 *   · 空态渲染不出来（记账是高频使用路径，不能一进来就空白）
 *   · i18n key 漏翻 → 界面直接显示 'ledger.xxx' 字面量
 *
 * 用法: node .tools/verify-ledger-page.mjs [--json]
 * 退出码: 0 = 全通过（或环境缺 Chrome / dist 时 SKIP）；1 = 有项不达标
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
  '.woff2': 'font/woff2'
};

function serveDist() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
    // ⚠️ 必须 path.resolve(DIST, '.'+url)：Windows 下 path.join 会丢掉 DIST 前缀 → 全站 403
    let file = path.resolve(DIST, '.' + url);
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

function runProbe(url, expr, waitMs) {
  return new Promise((resolve) => {
    const args = [
      PROBE, url, '375', '812',
      '--expr', expr,
      '--wait', String(waitMs),
      '--init-script', SESSION_STUB,
      '--block-url', 'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com'
    ];
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ code: -1, parsed: null, stdout: out, stderr: `${err}\nspawn: ${e.message}` }));
    child.on('close', (code) => {
      let parsed = null;
      // ⚠️ 探针输出是 JSON.stringify(x, null, 2) —— 多行格式化 JSON。
      //    取「最后一非空行」必然只拿到 "}"（2026-10-15 踩过）。要 parse 整个 stdout。
      try { parsed = JSON.parse(out.trim()); } catch { parsed = null; }
      resolve({ code, parsed, stdout: out, stderr: err });
    });
  });
}

/** 页内取数：按 CSS Module 的 `__<local>_` 包含匹配（产物形如 xxx__addBar___HASH）。 */
const PAGE_EXPR = `(() => {
  const all = Array.from(document.querySelectorAll('*'));
  const byMod = (id) => all.find((el) => {
    const c = typeof el.className === 'string' ? el.className : '';
    return c.split(/\\s+/).some((x) => x.includes('__' + id + '_'));
  });
  const byModAll = (id) => all.filter((el) => {
    const c = typeof el.className === 'string' ? el.className : '';
    return c.split(/\\s+/).some((x) => x.includes('__' + id + '_'));
  });
  const visible = (el) => {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100 };
  };
  const addBar = byMod('addBar');
  const addInput = byMod('addInput');
  const addBtns = byModAll('addBtn');
  const text = (document.body && document.body.innerText) || '';
  return JSON.stringify({
    ready: document.readyState,
    navigatedOk: location.protocol === 'http:' || location.protocol === 'https:',
    title: document.title,
    bodyLen: text.length,
    // i18n key 漏翻会直接在正文里露出 'ledger.xxx' 字面量
    i18nLeak: (text.match(/ledger\\.[a-zA-Z]+|briefing\\.[a-zA-Z]+/g) || []).slice(0, 5),
    hasAddBar: !!addBar,
    addBarRect: rect(addBar),
    addInputRect: rect(addInput),
    addInputVisible: visible(addInput),
    addBtnCount: addBtns.length,
    addBtnRects: addBtns.slice(0, 3).map(rect),
    addBtnsAllVisible: addBtns.length > 0 && addBtns.every(visible),
    anyZeroWidthBtn: addBtns.some((b) => {
      const r = b.getBoundingClientRect();
      return r.width < 1;
    }),
    // 空态：记账页第一次进来必然是空的，必须能看到引导而不是白屏
    emptyStateVisible: visible(byMod('container')) || visible(byMod('head')),
    headRect: rect(byMod('head'))
  });
})()`;

async function main() {
  const chrome = CHROME_CANDIDATES.find((p) => {
    try { return fs.existsSync(p); } catch { return false; }
  });
  const skip = (reason) => {
    console.log(asJson ? JSON.stringify({ status: 'SKIP', reason }) : `[SKIP] ${reason}`);
    return 0;
  };
  if (!chrome) return skip('未找到 Chrome（需 CHROME_BIN 或本机已装 Chrome）');
  if (!fs.existsSync(path.join(DIST, 'index.html'))) return skip('dist 不存在，先跑 npm run build:h5');

  process.env.CHROME_BIN = chrome;
  const { server, port } = await serveDist();
  let r;
  try {
    // 等 9s：取样太早会 ready=interactive + body 空，被误判成白屏
    r = await runProbe(`http://127.0.0.1:${port}/#/pages/ledger/index`, PAGE_EXPR, 9000);
  } finally {
    server.close();
  }

  const v = r.parsed && r.parsed.value;
  const d = v && typeof v === 'string' ? JSON.parse(v) : v;
  if (!d) {
    console.log(asJson
      ? JSON.stringify({ status: 'FAIL', why: '探针未取到页面数据', probeCode: r.code, raw: r.parsed }, null, 2)
      : `[FAIL] 探针未取到页面数据\n${r.stdout.slice(0, 800)}`);
    return 1;
  }
  if (!d.navigatedOk) {
    console.log(asJson
      ? JSON.stringify({ status: 'FAIL', why: `页面未真正加载（title=${d.title}）`, detail: d }, null, 2)
      : `[FAIL] 页面未真正加载（title=${d.title}）—— 这不是记账页的问题，先查服务`);
    return 1;
  }

  const checks = [
    { name: '页面真的加载了（有正文）', pass: d.bodyLen > 50, got: `bodyLen=${d.bodyLen}` },
    { name: '录入条 addBar 存在且可见', pass: !!d.hasAddBar && !!d.addBarRect && d.addBarRect.h > 0, got: JSON.stringify(d.addBarRect) },
    { name: '金额输入框可见且未被挤没', pass: !!d.addInputVisible && !!d.addInputRect && d.addInputRect.w > 60, got: JSON.stringify(d.addInputRect) },
    { name: '录入按钮非零宽（防 taro-button-core width:100% 回归）', pass: !d.anyZeroWidthBtn, got: d.anyZeroWidthBtn ? '有按钮宽度为 0' : 'ok' },
    { name: '两个录入按钮都在且可见', pass: d.addBtnCount >= 2 && d.addBtnsAllVisible, got: `count=${d.addBtnCount} allVisible=${d.addBtnsAllVisible}` },
    { name: 'i18n 无 key 漏翻（正文无 ledger.* 字面量）', pass: Array.isArray(d.i18nLeak) && d.i18nLeak.length === 0, got: JSON.stringify(d.i18nLeak || []) },
    { name: '空态/概览区已渲染', pass: !!d.emptyStateVisible, got: String(d.emptyStateVisible) }
  ];

  const pass = checks.every((c) => c.pass);
  const out = { status: pass ? 'PASS' : 'FAIL', checks, detail: d };
  if (asJson) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(`\n记账页端到端 —— ${out.status}`);
    for (const c of checks) console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name}: ${c.got}`);
  }
  return pass ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('[verify-ledger-page] crashed:', err && err.message ? err.message : err);
  process.exit(2);
});