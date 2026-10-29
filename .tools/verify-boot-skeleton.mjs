#!/usr/bin/env node
/**
 * verify-boot-skeleton.mjs —— 首屏骨架门禁（2026-10-29，审计 P1：冷启动 9.1s 纯白）
 *
 * 这段骨架的价值全在「**在任何产物 JS/CSS 到达之前**就已经画出来」，所以判据分两层：
 *   A 片段源 + 接线：src/assets/boot-skeleton.html 里有骨架（内联样式、深色/减动效适配、
 *     10s 慢加载可操作兜底、读屏 status），copy-assets 会把它注入 dist/index.html，
 *     app 挂载后两帧再移除。
 *   A' 产物层：dist/index.html 里**真的**有它，且在 <div id="app"> 之前、样式在 </head> 之前。
 *     只验片段没有意义 —— 注入漏了，用户拿到的还是纯白。
 *   B 真浏览器：禁用 JS 时骨架必须自己站着（证明不依赖任何产物）；启用 JS 后必须被移除
 *     （不能残留盖住界面），且 #app 里确实有内容。
 *
 * 注意：骨架**不写在 src/index.html 模板里** —— 实测那样会让 taro build 卡死
 * （10min / 6.7min / 4min 三次零产出，去掉内联 <style> 也照样卡；还原模板后 127s 完成）。
 * 所以改成构建后注入，详见 .tools/copy-assets.js 的 injectBootSkeleton 注释。
 *
 * 用法: node .tools/verify-boot-skeleton.mjs [--no-browser]
 * 退出码: 0 = 全绿；1 = 有断言失败；2 = harness 自身出错
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const rows = [];
let pass = 0;
let fail = 0;
function assert(name, cond, detail = '') {
  if (typeof cond !== 'boolean') throw new Error(`断言「${name}」的 cond 不是 boolean：${typeof cond}`);
  rows.push({ name, ok: cond, detail });
  if (cond) pass++;
  else fail++;
}

/* ───────────── A. 片段源 + 接线 ───────────── */
const frag = read('src/assets/boot-skeleton.html');
const appSrc = read('src/app.tsx');
const util = read('src/utils/bootSkeleton.ts');
const copyAssets = read('.tools/copy-assets.js');

assert('A1 有骨架片段源（可 review、可 diff）', frag.includes('id="boot-skeleton"'));
assert(
  'A2 骨架样式内联在片段里（不依赖外链 CSS 的二次往返）',
  /<style>[\s\S]*#boot-skeleton[\s\S]*<\/style>/.test(frag)
);
assert('A3 有深色适配（prefers-color-scheme: dark）', /prefers-color-scheme:\s*dark/.test(frag));
assert('A4 有减动效适配（prefers-reduced-motion）', /prefers-reduced-motion:\s*reduce/.test(frag));
assert(
  'A5 有 10s 慢加载兜底（换成可操作提示，不是无限转圈）',
  frag.includes('is-slow') && frag.includes('10000') && frag.includes('重新加载')
);
assert('A6 骨架对读屏是 status 区（不是纯装饰块）', /id="boot-skeleton"[^>]*role="status"/.test(frag));
// ⚠️ 判据必须框到「行首就是这次调用」：第一版用 includes，变异把调用包进
// `if (false) injectBootSkeleton();` 后照样通过 —— 变异测试当场抓出这个假绿。
const injectCall = /^[ \t]*injectBootSkeleton\(\);[ \t]*$/m.test(copyAssets);
assert(
  'A7 由 copy-assets 注入产物且未被条件包住（不在 webpack 模板里，避开那个 build 卡死）',
  injectCall && copyAssets.includes('<div id="app">')
);
// 同上：`if (false) dismissBootSkeletonAfterPaint();` 必须判红
const dismissCall = /^[ \t]*dismissBootSkeletonAfterPaint\(\);[ \t]*$/m.test(appSrc);
assert(
  'A8 app 挂载后移除骨架且未被条件包住（等两帧，避免白闪）',
  dismissCall && util.includes('requestAnimationFrame(() => requestAnimationFrame')
);
assert('A9 移除有定时兜底（transition 被禁时也能移除）', util.includes('setTimeout(() => removeNow(el), FADE_MS)'));
assert('A10 小程序端不执行（同一份代码两端跑）', appSrc.includes("TARO_ENV !== 'h5'"));

/* ───────────── A'. 产物层 ───────────── */
const DIST = path.join(ROOT, 'dist');
const distHtmlPath = path.join(DIST, 'index.html');
const hasDist = fs.existsSync(distHtmlPath);
if (hasDist) {
  const distHtml = fs.readFileSync(distHtmlPath, 'utf8');
  const sk = distHtml.indexOf('id="boot-skeleton"');
  const app = distHtml.indexOf('<div id="app">');
  const head = distHtml.indexOf('</head>');
  const styleAt = distHtml.indexOf('#boot-skeleton {');
  assert('A11 产物里有骨架节点（注入生效）', sk > 0, `idx=${sk}`);
  assert('A12 产物里骨架在 #app 之前（不跟 React 抢容器）', app > sk && sk > 0, `sk=${sk} app=${app}`);
  assert('A13 产物里骨架样式在 </head> 之前（首屏即可渲染）', styleAt > 0 && styleAt < head, `style=${styleAt} head=${head}`);
} else {
  console.log('（没有 dist：跳过 A11–A13「产物注入」断言，构建后再跑）');
}

/* ───────────── B. 真浏览器 ───────────── */
const CHROME = process.env.CHROME_BIN || 'C:\\Users\\geral\\.agent-browser\\browsers\\chrome-154.0.8037.92\\chrome.exe';
const NO_BROWSER = process.argv.includes('--no-browser');

if (NO_BROWSER) {
  console.log('（--no-browser：跳过 B 组真浏览器断言）');
} else if (!hasDist) {
  console.log('（没有 dist：跳过 B 组，先构建）');
} else if (!fs.existsSync(CHROME)) {
  console.log(`（找不到 Chrome：${CHROME} —— 跳过 B 组）`);
} else {
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
  const server = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (/\.(js|css|json|png|svg)$/.test(u)) {
      const f = path.resolve(DIST, '.' + u);
      if (!fs.existsSync(f)) { res.writeHead(404); res.end('nf'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
      res.end(fs.readFileSync(f));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(distHtmlPath));
  });
  const port = 9700 + Math.floor(Math.random() * 40);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));

  /** 打开一页；js=0 表示禁用脚本执行（证明骨架不依赖 JS） */
  async function openPage(js) {
    const udd = path.join(os.tmpdir(), `bs-${Date.now()}-${js}`);
    const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--no-proxy-server', `--remote-debugging-port=${port + 100 + js}`,
      `--user-data-dir=${udd}`, '--window-size=390,844', 'about:blank'], { stdio: 'ignore' });
    let wsUrl;
    for (let i = 0; i < 80; i++) {
      try {
        const l = await (await fetch(`http://127.0.0.1:${port + 100 + js}/json/list`)).json();
        const p = l.find((t) => t.type === 'page');
        if (p) { wsUrl = p.webSocketDebuggerUrl; break; }
      } catch { /* 端口还没起 */ }
      await new Promise((r) => setTimeout(r, 300));
    }
    const ws = new globalThis.WebSocket(wsUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0;
    const pending = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
    const send = (m, p = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p })); return new Promise((r) => pending.set(i, r)); };
    const ev = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) return 'ERR:' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    if (!js) await send('Emulation.setScriptExecutionDisabled', { value: true });
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await new Promise((r) => setTimeout(r, js ? 9000 : 2500));
    return { ev, close: () => { try { ws.close(); } catch { /* 已关 */ } child.kill(); } };
  }

  // B1–B3：禁用 JS —— 骨架必须自己站着（这是"不依赖产物"的唯一硬证据）
  const noJs = await openPage(0);
  const noJsState = await noJs.ev(`(() => {
    const el = document.getElementById('boot-skeleton');
    return JSON.stringify({
      exists: !!el,
      visible: !!el && el.offsetWidth > 0 && getComputedStyle(el).position === 'fixed',
      text: el ? el.innerText.replace(/\\s+/g, ' ').trim().slice(0, 40) : '',
      bg: el ? getComputedStyle(el).backgroundColor : ''
    });
  })()`);
  noJs.close();
  const s1 = JSON.parse(String(noJsState));
  assert('B1 禁用 JS 时骨架仍渲染（证明不依赖任何产物）', s1.exists === true && s1.visible === true, JSON.stringify(s1));
  assert('B2 骨架有明确的加载文案（不是空白遮罩）', String(s1.text).includes('正在准备今天的晨报'), String(s1.text));
  assert('B3 骨架有背景色（不是透明层压在白底上）', String(s1.bg).startsWith('rgb') && String(s1.bg) !== 'rgba(0, 0, 0, 0)', String(s1.bg));

  // B4–B5：启用 JS —— app 起来后骨架必须退场
  const withJs = await openPage(1);
  const withJsState = await withJs.ev(`(() => {
    const el = document.getElementById('boot-skeleton');
    const app = document.getElementById('app');
    return JSON.stringify({
      skeletonGone: !el,
      appHasChildren: !!app && app.children.length > 0,
      bodyText: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 60)
    });
  })()`);
  withJs.close();
  server.close();
  const s2 = JSON.parse(String(withJsState));
  assert('B4 app 起来后骨架已移除（不残留盖住界面）', s2.skeletonGone === true, JSON.stringify(s2));
  assert('B5 移除后 #app 里确实有内容（不是"骨架没了但一片空"）', s2.appHasChildren === true, String(s2.bodyText));
}

console.log('\n首屏骨架门禁');
for (const r of rows) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  → ' + r.detail}`);
console.log(`\n${fail === 0 ? `PASS ${pass} / FAIL 0（共 ${rows.length} 条）` : `PASS ${pass} / FAIL ${fail}（共 ${rows.length} 条）`}`);
process.exit(fail === 0 ? 0 : 1);
