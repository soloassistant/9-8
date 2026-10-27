#!/usr/bin/env node
/**
 * verify-site-live.mjs —— 官网落地页的渲染态门禁（2026-10-27）。
 *
 * 为什么静态门禁不够（本轮实证）：
 *   `.nav-links a`(0,1,1) 压过 `.btn-primary`(0,1,0)，导航里的「进入应用」白字被染成
 *   深灰 —— 深灰压深红，按钮几乎看不见。源码里 `color: #fff` 写得清清楚楚，
 *   verify-site 的静态断言全部通过；**只有截图/计算样式能发现**。
 *
 * 所以这里量的是浏览器算完之后的样式：computed color、实际对比度、
 * 元素在不在（display:none）、首屏里有没有标题、有没有横向溢出。
 *
 * 用法: node .tools/verify-site-live.mjs
 * 退出码: 0 = 全绿；1 = 有断言失败；2 = harness 自身出错（含缺 Chrome / 没构建）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PROBE = path.join(ROOT, '.tools', 'cdp-probe.mjs');

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  'C:\\Users\\geral\\.agent-browser\\browsers\\chrome-154.0.8037.92\\chrome.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
].filter(Boolean);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

let pass = 0;
let fail = 0;
function assert(name, cond, detail = '') {
  if (typeof cond !== 'boolean') {
    throw new Error(`断言「${name}」的 cond 不是 boolean，而是 ${typeof cond}：${String(cond)}`);
  }
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ' → ' + detail : ''}`);
  }
}

if (!fs.existsSync(path.join(DIST, 'site', 'index.html'))) {
  console.error('dist/site/index.html 不存在 —— 先 `taro build --type h5 && node .tools/copy-assets.js dist`');
  process.exit(2);
}

function serveDist() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
    // ⚠️ path.resolve(DIST, '.'+url)：path.join(DIST,'/x') 在 Windows 会算出 C:\x → 全站 403
    let file = path.resolve(DIST, '.' + url);
    if (!file.startsWith(DIST)) return res.writeHead(403).end('forbidden');
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) file = path.join(DIST, 'site', 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port })));
}

function runProbe(url, w, h, expr) {
  const chrome = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!chrome) throw new Error('找不到 Chrome（设 CHROME_BIN）');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PROBE, url, String(w), String(h), '--expr', expr, '--wait', '3500'], {
      env: { ...process.env, CHROME_BIN: chrome }
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', () => {
      try {
        const parsed = JSON.parse(out);
        resolve(parsed.value);
      } catch {
        resolve({ __parseError: `${out.slice(0, 300)} ${err.slice(0, 200)}` });
      }
    });
  });
}

/** 对比度：页面里量出来的 rgb() 必须在这里算真值，不能只判「是不是白色」 */
const parseRgb = (s) => {
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(s || '');
  return m ? `#${[1, 2, 3].map((i) => Number(m[i]).toString(16).padStart(2, '0')).join('')}` : null;
};
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.substr(i, 2), 16) / 255);
  const l = c.map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2];
};
const ratio = (a, b) => {
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/** 从计算样式的 background-image 里取第一个色标（渐变的起点色） */
const firstStop = (bgImage) => {
  const hex = /#[0-9a-fA-F]{6}/.exec(bgImage || '');
  if (hex) return hex[0];
  const rgb = /rgba?\(\s*\d+[,\s]+\d+[,\s]+\d+/.exec(bgImage || '');
  return rgb ? parseRgb(rgb[0]) : null;
};

const EXPR = `(async () => {
  const out = {};
  const navBtn = document.querySelector('.nav-links a.btn-primary');
  const cs = navBtn ? getComputedStyle(navBtn) : null;
  out.navBtnFound = !!navBtn;
  out.navBtnColor = cs ? cs.color : '';
  out.navBtnBg = cs ? (cs.backgroundImage || cs.backgroundColor) : '';
  out.navBtnRadius = cs ? cs.borderRadius : '';
  out.navBtnHref = navBtn ? navBtn.getAttribute('href') : '';

  const phone = document.querySelector('.phone');
  out.phoneExists = !!phone;
  out.phoneDisplay = phone ? getComputedStyle(phone).display : 'none';
  out.phoneVisible = !!(phone && phone.getBoundingClientRect().width > 0);

  const h1 = document.querySelector('h1');
  out.h1Top = h1 ? Math.round(h1.getBoundingClientRect().top) : -1;
  out.vh = window.innerHeight;
  out.overflowX = Math.round(document.documentElement.scrollWidth - window.innerWidth);

  const lead = document.querySelector('.lead');
  out.leadWidth = lead ? Math.round(lead.getBoundingClientRect().width) : 0;
  const heroWrap = document.querySelector('.hero .wrap');
  out.heroCols = heroWrap ? getComputedStyle(heroWrap).gridTemplateColumns : '';
  return JSON.stringify(out);
})()`;

const { server, port } = await serveDist();
const base = `http://127.0.0.1:${port}/site/`;
try {
  console.log('\n── 桌面视口 1280×900 ──');
  const d = await runProbe(base, 1280, 900, EXPR);
  if (!d || d.__parseError) {
    console.error('探针失败：', d && d.__parseError);
    process.exit(2);
  }

  assert('L1 导航「进入应用」按钮存在', d.navBtnFound === true);
  const navColor = parseRgb(d.navBtnColor);
  const navBg = firstStop(d.navBtnBg);
  assert('L2 按钮文字是白色（不是被 .nav-links a 染成深灰）', navColor === '#ffffff', `color=${d.navBtnColor}`);
  const navRatio = navColor && navBg ? ratio(navColor, navBg) : 0;
  assert(
    `L3 导航按钮白字压渐变起点 ${navRatio ? navRatio.toFixed(2) : '?'}:1 ≥ 4.5`,
    navRatio >= 4.5,
    `color=${d.navBtnColor} bg=${navBg}`
  );
  assert('L4 按钮背景是渐变（不是被覆盖成纯色）', /gradient/.test(d.navBtnBg || ''), d.navBtnBg);
  assert('L5 链接指向应用根（../）', d.navBtnHref === '../', `href=${d.navBtnHref}`);
  assert('L6 桌面端 hero 是两列（模拟手机可见）', d.phoneVisible === true);
  assert('L7 无横向溢出', d.overflowX <= 0, `overflowX=${d.overflowX}`);

  console.log('\n── 手机视口 390×844 ──');
  const m = await runProbe(base, 390, 844, EXPR);
  if (!m || m.__parseError) {
    console.error('探针失败：', m && m.__parseError);
    process.exit(2);
  }
  assert('L8 手机上不画「模拟手机」（首屏该给标题）', m.phoneVisible === false, `display=${m.phoneDisplay}`);
  assert(
    'L9 手机上标题出现在首屏上半部（不是被装饰挤到折叠线以下）',
    m.h1Top >= 0 && m.h1Top < m.vh * 0.55,
    `h1Top=${m.h1Top} vh=${m.vh}`
  );
  assert('L10 手机无横向溢出', m.overflowX <= 0, `overflowX=${m.overflowX}`);
  assert('L11 正文单列铺满（lead 宽度 ≥ 80% 视口）', m.leadWidth >= 390 * 0.8, `leadWidth=${m.leadWidth}`);

  console.log(`\n${'='.repeat(52)}`);
  console.log(`落地页渲染门禁：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) {
    console.log('有断言失败 —— 落地页在真实浏览器里的样子和源码写的不一样。');
    process.exit(1);
  }
  console.log('全部通过。');
} finally {
  server.close();
}
