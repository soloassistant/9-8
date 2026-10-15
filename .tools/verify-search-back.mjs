#!/usr/bin/env node
/**
 * verify-search-back.mjs —— 搜索页返回入口回归（P2-02）。
 *
 * 缺陷背景（2026-10-14 第三方测试报告 P2-02，线上实测）：
 *   空结果页「没有明显返回按钮」，巡检只能靠敲首页地址退出。
 *   源码印证：src/pages/search/index.tsx 的 JSX 里只有 page / searchBar / searchInput /
 *   hint / results / group / row 等类名，**没有任何返回控件**；且 H5 用 TabRouter，
 *   不渲染小程序原生导航栏，所以系统返回也不可见 —— 页内必须自带返回入口。
 *
 * 判据（页内实测，不看源码不看 CSS）：
 *   1. 返回控件存在且可见（非零宽高、非 display:none）
 *   2. 文案已本地化（能读到「返回」/「Back」，而不是 i18n key 漏翻）
 *   3. 点击区高度 ≥ 24px（移动端可点性下限，太小点不准）
 *   4. 加了返回后搜索框仍在、宽度未被挤掉（不能为了返回牺牲主功能）
 *
 * 用法: node .tools/verify-search-back.mjs [--json]
 * 退出码: 0 = 通过（或环境缺 Chrome / dist 时 SKIP）；1 = 返回入口不可用
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
};

function serveDist() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
    // ⚠️ 必须 path.resolve + '.'+url：Windows 下 path.join(DIST, '/css/x.css') 会
    // 直接丢弃 DIST 前缀算出 'C:\css\x.css'，导致 startsWith(DIST) 失败 → 全站 403。
    // （踩过一次：以为服务没起，其实每个请求都是 403。）
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
      '--block-url', 'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com',
    ];
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ code: -1, parsed: null, stdout: out, stderr: `${err}\nspawn: ${e.message}` }));
    child.on('close', (code) => {
      let parsed = null;
      try { parsed = JSON.parse(out.trim()); } catch { parsed = null; }
      resolve({ code, parsed, stdout: out, stderr: err });
    });
  });
}

const PAGE_EXPR = `(() => {
  const all = Array.from(document.querySelectorAll('*'));
  const byMod = (id) => all.find((el) => {
    const c = typeof el.className === 'string' ? el.className : '';
    return c.split(/\\s+/).some((x) => x.includes('__' + id + '_'));
  });
  const back = byMod('backButton');
  const input = byMod('searchInput');
  const r = back ? back.getBoundingClientRect() : null;
  const cs = back ? getComputedStyle(back) : null;
  const ir = input ? input.getBoundingClientRect() : null;
  return JSON.stringify({
    ready: document.readyState,
    title: document.title,
    navigatedOk: location.protocol === 'http:' || location.protocol === 'https:',
    bodyLen: (document.body && document.body.innerText || '').length,
    foundBack: !!back,
    backText: back ? (back.innerText || '').trim() : null,
    backRect: r ? { w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100 } : null,
    backVisible: !!(back && cs && cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0),
    hasClickHandler: !!(back && (back.getAttribute('onclick') || back.dataset.clickable !== undefined)),
    inputPresent: !!input,
    inputRect: ir ? { w: Math.round(ir.width * 100) / 100, h: Math.round(ir.height * 100) / 100 } : null,
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
    // 等 9s：探针取样太早会 ready=interactive + body 空，被误判成「页面坏了」
    r = await runProbe(`http://127.0.0.1:${port}/#/pages/search/index`, PAGE_EXPR, 9000);
  } finally {
    server.close();
  }

  const v = r.parsed && r.parsed.value;
  const d = v && typeof v === 'string' ? JSON.parse(v) : v;
  if (!d) {
    const out = { status: 'FAIL', why: '探针未取到页面数据', probeCode: r.code, raw: r.parsed, stderr: r.stderr };
    console.log(asJson ? JSON.stringify(out, null, 2) : `[FAIL] ${out.why}\n${r.stdout.slice(0, 800)}`);
    return 1;
  }
  if (!d.navigatedOk) {
    const out = { status: 'FAIL', why: `页面未真正加载（title=${d.title}），别把这当成返回按钮的问题`, detail: d };
    console.log(asJson ? JSON.stringify(out, null, 2) : `[FAIL] ${out.why}`);
    return 1;
  }

  const text = d.backText || '';
  const localized = /返回|Back/.test(text);
  const h = d.backRect ? d.backRect.h : 0;
  const bigEnough = h >= 24;
  const inputOk = d.inputPresent && d.inputRect && d.inputRect.w > 100;
  const pass = d.foundBack && d.backVisible && localized && bigEnough && inputOk;

  const checks = [
    { name: '返回控件存在', pass: !!d.foundBack, got: d.foundBack },
    { name: '返回控件可见（非零宽高）', pass: !!d.backVisible, got: `${d.backRect ? `${d.backRect.w}x${d.backRect.h}` : 'null'}` },
    { name: '文案已本地化（非 i18n key）', pass: localized, got: text || 'null' },
    { name: '点击区高度 ≥ 24px', pass: bigEnough, got: `${h}px` },
    { name: '搜索框未被挤掉', pass: inputOk, got: d.inputPresent ? `${d.inputRect ? d.inputRect.w : '?'}px` : 'missing' },
  ];

  const out = { status: pass ? 'PASS' : 'FAIL', checks, detail: d };
  if (asJson) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(`\n搜索页返回入口 —— ${out.status}`);
    for (const c of checks) console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name}: ${c.got}`);
  }
  return pass ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('[verify-search-back] crashed:', err && err.message ? err.message : err);
  process.exit(2);
});