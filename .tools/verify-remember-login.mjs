#!/usr/bin/env node
/**
 * verify-remember-login.mjs —— 登录页「下次自动登录」勾选框回归。
 *
 * 背景（2026-10-15）：会话本身已由 SDK 持久化到 localStorage（关页面仍登录），
 * 但 UI 上没有开关 —— 用户失去控制权。本轮补了两个入口：
 *   ① 登录页 rememberRow 勾选框（默认勾选，取消→立即 signOut）
 *   ② 我的页「退出登录」行（登出 ≠ 注销，保留业务数据）
 *
 * 本脚本验证① 的**渲染与可点性**，② 由mine 页的构建与 typecheck 兜底。
 * 判据挑的是「算错了会出事」的几条：
 *   · 勾选框必须**默认勾选**（☒）—— 反了就是「默认不被记住」，与 SDK 实际行为矛盾
 *   · 必须有可点热区（移动端小对勾点不准）
 *   · 必须**独立于**隐私勾选框（共用一个开关 = 语义混淆 + 合规风险）
 *   · 文案不能漏翻（漏翻会直接显示 auth.rememberLogin 字面量）
 *
 * 用法: node .tools/verify-remember-login.mjs [--json]
 * 退出码: 0 = 通过（或环境缺 Chrome/dist 时 SKIP）；1 = 不达标
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PROBE = path.join(ROOT, '.tools', 'cdp-probe.mjs');
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
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8'
};

function serveDist() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
    let file = path.resolve(DIST, '.' + url);
    if (!file.startsWith(DIST)) { res.writeHead(403).end('forbidden'); return; }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

function runProbe(url, expr, waitMs) {
  return new Promise((resolve) => {
    const args = [PROBE, url, '375', '812', '--expr', expr, '--wait', String(waitMs),
      '--block-url', 'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com'];
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ code: -1, parsed: null, stdout: out, stderr: `${err}\nspawn: ${e.message}` }));
    child.on('close', (code) => {
      let parsed = null;
      // ⚠️ 探针输出是 JSON.stringify(x, null, 2) —— 多行格式化 JSON，
      //    取「最后一非空行」必然只拿到 "}"（2026-10-15 踩过）。要 parse 整个 stdout。
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
  const txt = (document.body && document.body.innerText) || '';
  const rememberRow = byMod('rememberRow');
  const privacyRow = byMod('privacyRow');
  return JSON.stringify({
    ready: document.readyState,
    navigatedOk: location.protocol === 'http:' || location.protocol === 'https:',
    isLoginPage: location.hash.indexOf('login') >= 0,
    bodyLen: txt.length,
    hasRememberRow: !!rememberRow,
    rememberRect: rect(rememberRow),
    rememberVisible: visible(rememberRow),
    // ☒= 已勾（默认），☐= 未勾
    rememberBox: (() => { const b = byMod('rememberBox'); return b ? b.innerText.trim() : null; })(),
    rememberText: (() => { const b = byMod('rememberText'); return b ? b.innerText.trim() : null; })(),
    hasPrivacyRow: !!privacyRow,
    isSeparateFromPrivacy: !!rememberRow && !!privacyRow && rememberRow !== privacyRow,
    i18nLeak: (txt.match(/auth\\.[a-zA-Z]+/g) || []).slice(0, 5)
  });
})()`;

async function main() {
  const chrome = CHROME_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  const skip = (reason) => { console.log(asJson ? JSON.stringify({ status: 'SKIP', reason }) : `[SKIP] ${reason}`); return 0; };
  if (!chrome) return skip('未找到 Chrome（需 CHROME_BIN 或本机已装 Chrome）');
  if (!fs.existsSync(path.join(DIST, 'index.html'))) return skip('dist 不存在，先跑 build + copy-assets');

  process.env.CHROME_BIN = chrome;
  const { server, port } = await serveDist();
  let r;
  try {
    // 登录页不需注入会话（本来就在登录态之外），等 9s 避免取样竞态
    r = await runProbe(`http://127.0.0.1:${port}/#/pages/login/index`, PAGE_EXPR, 9000);
  } finally {
    server.close();
  }

  const v = r.parsed && r.parsed.value;
  const d = v && typeof v === 'string' ? JSON.parse(v) : v;
  if (!d) {
    console.log(asJson ? JSON.stringify({ status: 'FAIL', why: '探针未取到页面数据', probeCode: r.code }, null, 2)
      : `[FAIL] 探针未取到页面数据\n${r.stdout.slice(0, 800)}`);
    return 1;
  }
  if (!d.navigatedOk) {
    console.log(asJson ? JSON.stringify({ status: 'FAIL', why: `页面未真正加载（title=${d.title}）`, detail: d }, null, 2)
      : `[FAIL] 页面未真正加载 —— 先查服务，别当成登录页的问题`);
    return 1;
  }

  const checks = [
    { name: '确实停在登录页', pass: d.isLoginPage === true, got: String(d.isLoginPage) },
    { name: '「下次自动登录」勾选框已渲染', pass: !!d.hasRememberRow && !!d.rememberVisible, got: JSON.stringify(d.rememberRect) },
    { name: '默认是勾选态（☒，与 SDK 实际行为一致）', pass: d.rememberBox === '☑', got: JSON.stringify(d.rememberBox) },
    { name: '点击热区够大（整行可点，高 ≥ 32px）', pass: !!d.rememberRect && d.rememberRect.h >= 32, got: `${d.rememberRect ? d.rememberRect.h : '?'}px` },
    { name: '与隐私勾选框是两个独立控件', pass: d.isSeparateFromPrivacy === true, got: String(d.isSeparateFromPrivacy) },
    { name: '文案已本地化（正文无 auth.* 字面量）', pass: Array.isArray(d.i18nLeak) && d.i18nLeak.length === 0, got: JSON.stringify(d.i18nLeak || []) },
    { name: '标签文案正确', pass: typeof d.rememberText === 'string' && d.rememberText.length > 0, got: JSON.stringify(d.rememberText) }
  ];

  const pass = checks.every((c) => c.pass);
  const out = { status: pass ? 'PASS' : 'FAIL', checks, detail: d };
  if (asJson) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`\n登录页「下次自动登录」—— ${out.status}`);
    for (const c of checks) console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name}: ${c.got}`);
  }
  return pass ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('[verify-remember-login] crashed:', err && err.message ? err.message : err);
  process.exit(2);
});