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
 * ★ 2026-10-29 补 A14/A15/B6/B7：**重复 id="app"**。
 *   片段末尾曾被写了一个 <div id="app"></div> 当"挂载点占位"，注入时又拼一个真挂载点
 *   ⇒ 产物里 id="app" 出现 2 次。Taro 的 getElementById 取**第一个**（片段里那个空的）
 *   挪进 #container 渲染 —— 界面看起来完全正常；真正的挂载点留在 body，高度 = 一屏
 *   ⇒ 页面可滚高度变 2 屏，**滚到底是一整屏纯空白**。全站每页都中，48 个门禁全绿。
 *   泄漏原因：原断言用 `indexOf('<div id="app">')` 只判**位置**，结构上看不见第二个。
 *   所以现在改数**出现次数**，运行时也数 `querySelectorAll('#app')`（getElementById 只给第一个）。
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
// ★ A15：片段里不许出现 id="app" 元素。注入语义是「拼在 dist 里那个真挂载点**之前**」，
//   片段自带一个占位就会让产物出现两个 id="app"（2026-10-29 事故，见 A14 注释）。
//   这条只读源码，不依赖 dist，构建前就能红。
//   ⚠️ 同样先剥注释：本片段里解释这个坑的注释就写着 `<div id="app">`。
const stripHtmlComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
assert(
  'A15 骨架片段里不许写 id="app" 元素（会与真挂载点撞 id）',
  (stripHtmlComments(frag).match(/id="app"/g) || []).length === 0,
  `count=${(stripHtmlComments(frag).match(/id="app"/g) || []).length}`
);

/* ───────────── A'. 产物层 ───────────── */
/** --dist= 可指定别的产物目录（用来对旧产物证明断言有判别力） */
const DIST_ARG = (process.argv.find((a) => a.startsWith('--dist=')) || '').slice(7);
const DIST = DIST_ARG || path.join(ROOT, 'dist');
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
  // ★ A14–A15：重复 id="app" 检测。原来只判 indexOf 的**位置**，结构上看不见第二个 id。
  //   2026-10-29 事故：片段末尾自带 <div id="app"></div> 占位，注入时又拼一个 →
  //   产物两个 id="app"，Taro 取第一个（空的）挪进 #container（界面正常），
  //   真挂载点留在 body 当一屏高的空壳 → **滚到底是一整屏纯空白**。
  //   ⚠️ 计数必须先剥掉 HTML 注释：片段里解释这个坑的注释本身写着 `<div id="app">`，
  //      不剥的话 5 个"命中"里 4 个是注释 —— 与 verify-parity 被 YAML 注释骗过、
  //      verify-docs 被解释性注释误杀是同一个坑：**判据不能把注释当事实**。
  const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
  const appIdCount = (stripComments(distHtml).match(/id="app"/g) || []).length;
  assert('A14 产物里 id="app" 恰好出现 1 次（出现 2 次 = 滚到底整屏空白）', appIdCount === 1, `count=${appIdCount}`);
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

  /** 打开一页；js=0 表示禁用脚本执行（证明骨架不依赖 JS）
   *  opts.failChunks=1 时用 Fetch 域**精确失败数字前缀的分包**，模拟「切页时分包取不到」。 */
  async function openPage(js, opts) {
    const failChunks = !!(opts && opts.failChunks);
    const hangChunks = !!(opts && opts.hangChunks);
    const dbgPort = port + 100 + js + (failChunks ? 10 : 0) + (hangChunks ? 20 : 0);
    const udd = path.join(os.tmpdir(), `bs-${Date.now()}-${js}`);
    const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--no-proxy-server', `--remote-debugging-port=${dbgPort}`,
      `--user-data-dir=${udd}`, '--window-size=390,844', 'about:blank'], { stdio: 'ignore' });
    let wsUrl;
    for (let i = 0; i < 80; i++) {
      try {
        const l = await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json();
        const p = l.find((t) => t.type === 'page');
        if (p) { wsUrl = p.webSocketDebuggerUrl; break; }
      } catch { /* 端口还没起 */ }
      await new Promise((r) => setTimeout(r, 300));
    }
    const ws = new globalThis.WebSocket(wsUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0;
    let navAt = 0;
    let startFailing = false;
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
    if (failChunks || hangChunks) {
      // ⚠️ 不能用 Network.setBlockedURLs(['*/js/[0-9]*.js'])：它只支持 * 和 ?，
      //    字符类会被当字面量 —— 实测一个请求都没拦到，却得出「页面正常」的假结论。
      // ⚠️ 也不能按时间（"导航 3 秒后才拦"）：分包在启动过程中就可能被拦到，
      //    早一点走骨架失败态、晚一点走兜底层，结果**不稳定**（实测同一份产物
      //    一次 25/25 一次 22/25）。改成由用例显式 setFail(true) —— 先让页面挂载成功，
      //    再开始失败，这样命中的必然是「外壳起来了、切页的分包挂了」这条确定路径。
      await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      ws.addEventListener('message', (e) => {
        const m = JSON.parse(e.data);
        if (m.method !== 'Fetch.requestPaused') return;
        const { requestId, request } = m.params;
        if (hangChunks && /\/js\/\d+\.[0-9a-f]+\.js(\?|$)/.test(request.url)) {
          return; // 挂着不回：模拟「很慢但没失败」
        }
        if (startFailing && /\/js\/\d+\.[0-9a-f]+\.js(\?|$)/.test(request.url)) {
          send('Fetch.failRequest', { requestId, errorReason: 'Failed' });
        } else {
          send('Fetch.continueRequest', { requestId });
        }
      });
    }
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    if (!js) await send('Emulation.setScriptExecutionDisabled', { value: true });
    // failChunks 这一路必须注入会话桩：否则应用直接跳登录页，压根不会请求页面分包，
    // 失败态永远测不到（第一版就是这么「失败」的 —— 其实是没走到那条路径）。
    if (failChunks) {
      await send('Page.addScriptToEvaluateOnNewDocument', { source: fs.readFileSync(path.join(ROOT, '.tools/cdp-probe-session.js'), 'utf8') });
      await send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('onboarded-v2', JSON.stringify({data:true}));localStorage.setItem('privacy-consent', JSON.stringify({data:true}));}catch(e){}` });
    }
    navAt = Date.now();
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/${failChunks ? '#/pages/briefing/index' : ''}` });
    await new Promise((r) => setTimeout(r, js ? 9000 : 2500));
    return { ev, setFail: (v) => { startFailing = !!v; }, close: () => { try { ws.close(); } catch { /* 已关 */ } child.kill(); } };
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
    // 重复 id="app" 的运行时探法：getElementById 只返回第一个，看不见第二个，
    // 必须用 querySelectorAll 数一遍，并看每个的高度/子节点数。
    const apps = [...document.querySelectorAll('#app')].map((n) => ({
      h: Math.round(n.getBoundingClientRect().height),
      kids: n.children.length,
      inContainer: !!n.closest('#container')
    }));
    // 空白大块：直系子元素里高度超过半屏、却一个子节点都没有的块
    const blankBlocks = [...document.body.children].filter((n) => {
      const r = n.getBoundingClientRect();
      return r.height > window.innerHeight * 0.5 && n.children.length === 0 && !(n.innerText || '').trim();
    }).length;
    return JSON.stringify({
      skeletonGone: !el,
      appHasChildren: !!app && app.children.length > 0,
      appCount: apps.length,
      apps,
      blankBlocks,
      viewport: window.innerHeight,
      scrollHeight: document.documentElement.scrollHeight,
      bodyText: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 60)
    });
  })()`);
  withJs.close();
  const s2 = JSON.parse(String(withJsState));
  assert('B4 app 起来后骨架已移除（不残留盖住界面）', s2.skeletonGone === true, JSON.stringify(s2));
  assert('B5 移除后 #app 里确实有内容（不是"骨架没了但一片空"）', s2.appHasChildren === true, String(s2.bodyText));
  assert('B6 运行时只有一个 #app 元素（重复会让 Taro 挂错容器，滚到底整屏空白）', s2.appCount === 1, `appCount=${s2.appCount} apps=${JSON.stringify(s2.apps)}`);
  assert('B7 页面里没有「超过半屏高、且完全空」的顶层块', s2.blankBlocks === 0, `blankBlocks=${s2.blankBlocks} scrollHeight=${s2.scrollHeight} viewport=${s2.viewport}`);

  // B8–B10：**这个洞实测存在过** —— 外壳挂载成功、骨架撤掉之后，切页的分包才失败。
  //   那时 `#boot-skeleton` 已经不在 DOM 里，原来 app.tsx 只是给它加 `is-fail`（静默无效），
  //   用户看到的是「没有内容、没有提示、没有重试」的页面，只能自己想到刷新。
  //   这三条断言的就是兜底层真的出现、真的能点、点完真的带 cache-busting 重载。
  const failPage = await openPage(1, { failChunks: 1 });
  // ① 先等外壳真的挂载（骨架撤掉、有可见 taro 节点）——此时分包还没失败
  let mounted = false;
  for (let i = 0; i < 40 && !mounted; i++) {
    await new Promise((r) => setTimeout(r, 300));
    mounted = (await failPage.ev(`(!document.getElementById('boot-skeleton')) && document.querySelectorAll('taro-view-core').length > 20`)) === true;
  }
  assert('B8a 前置：外壳已挂载、骨架已撤（失败注入必须在挂载之后，否则测的是骨架态）',
    mounted === true, `mounted=${mounted}`);
  // ② 现在开始失败分包，再切到一个需要懒加载分包的页
  await failPage.setFail(true);
  await failPage.ev(`location.hash = '#/pages/library/index'`);
  await new Promise((r) => setTimeout(r, 6000));
  const failState = await failPage.ev(`(() => {
    const box = document.getElementById('wb-boot-failure');
    const btn = box ? box.querySelector('button') : null;
    const r = btn ? btn.getBoundingClientRect() : null;
    return JSON.stringify({
      overlay: !!box,
      text: box ? box.innerText.replace(/\\s+/g, ' ').trim().slice(0, 60) : '',
      btnText: btn ? btn.textContent : '',
      btnVisible: !!(r && r.width > 0 && r.height > 0),
      btnSize: r ? Math.round(r.width) + 'x' + Math.round(r.height) : '',
      skeletonGone: !document.getElementById('boot-skeleton'),
      href: location.href
    });
  })()`);
  const f1 = JSON.parse(String(failState));
  assert('B8 分包失败时用户看得到失败提示（不是无内容无提示的死页面）',
    f1.overlay === true && String(f1.text).length > 0, JSON.stringify(f1));
  assert('B9 失败提示里有**可见**的重试按钮（尺寸非 0，不是 display:none 的摆设）',
    f1.btnVisible === true, `btn=${f1.btnText} size=${f1.btnSize}`);

  // 点一下：必须带 cache-busting 的 query 重载（坏响应被网关缓存住时，同 URL 再请求还是坏的）
  await failPage.ev(`(() => { const b = document.querySelector('#wb-boot-failure button'); if (b) b.click(); return 1; })()`);
  await new Promise((r) => setTimeout(r, 1500));
  const afterHref = String(await failPage.ev('location.href'));
  failPage.close();
  assert('B10 点重试真的重载且带 cache-busting（URL 出现 r= 时间戳）',
    /[?&]r=\d{10,}/.test(afterHref), afterHref);
  // B11–B13：分包**挂起不返回**（慢，不是失败）—— 冷启动直接进该页时必须留在骨架上。
  //   这不是我猜的：实测冷启动 + 挂起分包，6s/10s/16s 三次采样都是
  //   节点 0、骨架在、进度停在 706 KB / 898 KB，10s 后自动出「网络似乎卡住了」。
  //   也就是说「什么都没有」这个最坏形态被骨架挡住了 —— 这条断言把它钉住。
  const hangPage = await openPage(1, { hangChunks: 1 });
  await new Promise((r) => setTimeout(r, 6000));
  const h1 = JSON.parse(String(await hangPage.ev(`JSON.stringify({
    nodes: document.querySelectorAll('taro-view-core,taro-text-core').length,
    skeleton: !!document.getElementById('boot-skeleton'),
    text: (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60)
  })`)));
  assert('B11 分包挂起时骨架不撤（用户看到进度，而不是空白页）',
    h1.skeleton === true && h1.nodes === 0, JSON.stringify(h1).slice(0, 140));

  await new Promise((r) => setTimeout(r, 6000));
  const h2 = JSON.parse(String(await hangPage.ev(`(() => {
    const skel = document.getElementById('boot-skeleton');
    const btn = document.querySelector('#boot-skeleton .bs-retry');
    const r = btn ? btn.getBoundingClientRect() : null;
    return JSON.stringify({
      cls: skel ? String(skel.className) : '',
      text: (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
      retryVisible: !!(r && r.width > 0 && r.height > 0)
    });
  })()`)));
  assert('B12 挂起 12s 后进入「卡住」态并给出人话文案',
    /is-stall|is-fail/.test(h2.cls) && /卡住|没能加载|慢/.test(h2.text), JSON.stringify(h2).slice(0, 160));
  assert('B13 该状态下有可见的重试按钮（用户能自己救，不必干等）',
    h2.retryVisible === true, String(h2.text));
  hangPage.close();

  server.close();
}

console.log('\n首屏骨架门禁');
for (const r of rows) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  → ' + r.detail}`);
console.log(`\n${fail === 0 ? `PASS ${pass} / FAIL 0（共 ${rows.length} 条）` : `PASS ${pass} / FAIL ${fail}（共 ${rows.length} 条）`}`);
process.exit(fail === 0 ? 0 : 1);
