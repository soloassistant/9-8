#!/usr/bin/env node
/**
 * 发布后核验（对应 AGENTS.md §4「发布后必查」）—— 面板发布 `D:\Agent\dist` 之后跑一次。
 *
 * 用法：node .tools/verify-publish-live.mjs
 * 退出码：0 = 全过；1 = 有项没过；2 = harness 自身出错
 *
 * ★ 为什么必须有「⑤ 浏览器级」这一项（2026-10-30 实测踩出来的）
 * ------------------------------------------------------------------
 * ①②③④ 全是**资产 / API 级**的检查：包名一致、资源 200 且大小一致、
 * Origin 白名单 204、未登录语义 401 / []。它们回答的是「文件到位了吗、接口通吗」。
 *
 * 它们**回答不了**「用户打开这个页面，看得见界面吗」。2026-10-30 实测：
 *   · 线上 ①②③④ **全绿**；
 *   · 真浏览器里 **30 秒后 React 仍未挂载**（没有 #container，#app 仍是模板里的空占位）；
 *   · 首屏骨架 `<div id="boot-skeleton">`（position:fixed; z-index:9999）**一直盖在上面**，
 *     中心点 elementFromPoint 命中的还是骨架，页面上只有
 *     「正在准备今天的晨报…加载得有点慢…重新加载」—— **用户永远看不到登录页**。
 *
 * 根因在投递侧（源站偶发卡顿 + 网关不压缩：5.4 KB 的 HTML 要 8 秒、
 * 616 KB 的主包要 7 秒），Taro 运行时 chunk 到位太晚 ⇒ 运行时没跑起来 ⇒ 没人撤骨架。
 *
 * ⇒ 「资产都在」≠「用户看得见界面」。这一条查的是**用户看见的东西**。
 *
 * ⚠️ 云端路径前缀是 `/.cloud/`（不是 `/v1/`）；鉴权头是 `X-Wb-Webapp-Access-Key`（不是 `apikey`）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const H = process.env.PUBLISH_ORIGIN || 'https://48f86dcd48e3462dbe897b5fce534551.app.workbuddy.host';
const LOCAL = process.env.PUBLISH_DIR || 'D:\\Agent\\dist';
const CHROME = process.env.CHROME_BIN || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
/** 线上偶发慢：给足 30s 再判「没渲染出来」—— 否则会把「今天网络不好」误报成「发布坏了」 */
const MOUNT_TIMEOUT_MS = Number(process.env.PUBLISH_MOUNT_TIMEOUT_MS || 30000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bad = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) bad++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  → ' + detail}`);
};

const KEY = (() => {
  try {
    return (fs.readFileSync(path.join(ROOT, 'src/services/cloudAuth.ts'), 'utf8').match(/wbpk_[A-Za-z0-9_]+/) || [])[0] || '';
  } catch {
    return '';
  }
})();

console.log(`线上：${H}\n本地：${LOCAL}\n`);

/* ① 包名与本地一致 */
let html = '';
try {
  const r = await fetch(`${H}/`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  html = await r.text();
} catch (e) {
  console.log(`  FAIL  线上首页不可达 → ${e.message}`);
  process.exit(1);
}
const onlineBundle = (html.match(/js\/app\.([0-9a-f]+)\.js/) || [])[1] || '';
let localHtml = '';
try {
  localHtml = fs.readFileSync(`${LOCAL}/index.html`, 'utf8');
} catch {
  console.log(`  FAIL  本地发布目录读不到 index.html：${LOCAL}（发布前先同步产物）`);
  process.exit(1);
}
const localBundle = (localHtml.match(/js\/app\.([0-9a-f]+)\.js/) || [])[1] || '';
ok('① 线上主包与本地一致', !!onlineBundle && onlineBundle === localBundle, `线上=${onlineBundle || '(无)'} 本地=${localBundle || '(无)'}`);
const appIds = (html.replace(/<!--[\s\S]*?-->/g, '').match(/id="app"/g) || []).length;
ok('① 线上 index.html 里 id="app" 剥注释后恰好 1 次', appIds === 1, `count=${appIds}`);

/* ② 关键资源都在（200 且大小与本地一致） */
for (const f of ['assets/wb-sdk.js', 'api/hotspot.json', `js/app.${localBundle}.js`]) {
  try {
    const r = await fetch(`${H}/${f}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const buf = Buffer.from(await r.arrayBuffer());
    const localSize = fs.existsSync(`${LOCAL}/${f}`) ? fs.statSync(`${LOCAL}/${f}`).size : -1;
    ok(`② ${f} 200 且大小与本地一致`, r.status === 200 && buf.length === localSize, `HTTP ${r.status} size=${buf.length} local=${localSize}`);
  } catch (e) {
    ok(`② ${f} 可取`, false, e.message);
  }
}

/* ③ Origin 白名单：必须 204 且 ACAO 精确等于站点 origin */
try {
  const r = await fetch(`${H}/.cloud/database/rest/user_kv`, {
    method: 'OPTIONS',
    headers: {
      Origin: H,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization'
    }
  });
  const acao = r.headers.get('access-control-allow-origin') || '';
  ok('③ Origin 白名单：204 且 ACAO 精确匹配', r.status === 204 && acao === H, `HTTP ${r.status} ACAO=${acao || '(无)'}`);
} catch (e) {
  ok('③ Origin 白名单可测', false, e.message);
}

/* ④ 未登录语义：认证接口结构化 401；匿名读 user_kv 回 [] */
try {
  const h = { Origin: H, 'X-Wb-Webapp-Access-Key': KEY };
  const r1 = await fetch(`${H}/.cloud/auth/v1/user/me`, { headers: h });
  const t1 = await r1.text();
  ok('④ 认证接口回结构化 401', r1.status === 401, `HTTP ${r1.status} body=${t1.slice(0, 120)}`);
  const r2 = await fetch(`${H}/.cloud/database/rest/user_kv?select=*`, { headers: h });
  const t2 = await r2.text();
  ok('④ 匿名读 user_kv 回 []', r2.status === 200 && /^\s*\[\s*\]/.test(t2), `HTTP ${r2.status} body=${t2.slice(0, 120)}`);
} catch (e) {
  ok('④ 未登录语义可测', false, e.message);
}

/* ⑤ ★ 浏览器级：页面真的渲染出来了 */
{
  try {
    if (!fs.existsSync(CHROME)) throw new Error(`找不到 Chrome：${CHROME}（可用 CHROME_BIN 指定）`);
    const CDP = 9400 + Math.floor(Math.random() * 300);
    const udd = path.join(os.tmpdir(), `publish-live-${Date.now()}`);
    const child = spawn(CHROME, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--no-proxy-server', '--hide-scrollbars', `--remote-debugging-port=${CDP}`,
      `--user-data-dir=${udd}`, '--window-size=390,844', 'about:blank'
    ], { stdio: 'ignore' });
    let wsUrl = null;
    for (let i = 0; i < 100; i++) {
      try {
        const l = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
        const p = l.find((t) => t.type === 'page');
        if (p) { wsUrl = p.webSocketDebuggerUrl; break; }
      } catch { /* chrome 还没起来 */ }
      await sleep(300);
    }
    if (!wsUrl) throw new Error('Chrome 调试端口没起来');
    const ws = new globalThis.WebSocket(wsUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0;
    const pending = new Map();
    const failed = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
      if (m.method === 'Network.loadingFailed') failed.push(`${m.params.type}:${m.params.errorText}`);
    };
    const send = (method, params = {}) => {
      const i = ++id;
      ws.send(JSON.stringify({ id: i, method, params }));
      return new Promise((r) => pending.set(i, r));
    };
    const ev = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) return { __error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
      return r.result.value;
    };
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

    const MEASURE = `(() => {
      const sk = document.getElementById('boot-skeleton');
      const app = document.getElementById('app');
      const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
      return {
        container: !!document.getElementById('container'),
        appKids: app ? app.children.length : -1,
        skel: !!sk,
        skelOpacity: sk ? getComputedStyle(sk).opacity : null,
        centerHit: el ? el.tagName + (el.id ? '#' + el.id : '') : null,
        centerText: el ? (el.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 60) : '',
        bodyText: (document.body.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 120),
        scrollH: document.documentElement.scrollHeight,
        innerH: window.innerHeight
      };
    })()`;

    const t0 = Date.now();
    await send('Page.navigate', { url: `${H}/` });
    let m = null;
    let mounted = false;
    while (Date.now() - t0 < MOUNT_TIMEOUT_MS) {
      await sleep(2000);
      m = await ev(MEASURE);
      // ⚠️ 别用 `#container 存在` 判挂载：它是 index.html 里的**静态 div**，解析完就有，
      //    于是循环在第一次采样（2s）就 break，后面三条断言全在启动瞬间取样 ——
      //    实测因此两次误红（一次 opacity=0.098 正在淡出，一次 opacity=1、进度才 100KB/899KB）。
      //    真正的判据是「#app 有内容 且 骨架已撤」。
      if (m && m.appKids > 0 && !m.skel) { mounted = true; break; }
    }
    const secs = Math.round((Date.now() - t0) / 1000);
    ok(`⑤ 页面在 ${Math.round(MOUNT_TIMEOUT_MS / 1000)}s 内真的挂载（#app 有内容且骨架已撤）`, mounted, `耗时 ${secs}s；${JSON.stringify(m)}`);
    ok('⑤ 首屏骨架已被移除（不再全屏遮挡）', !m || !m.skel, `骨架仍在 DOM，opacity=${m && m.skelOpacity}`);
    const stillSkeleton = m && /正在准备今天的晨报|加载得有点慢/.test(m.bodyText || '');
    ok('⑤ 页面显示的是真实界面而不是骨架文案', !stillSkeleton, `body="${m && m.bodyText}"`);
    ok('⑤ 页面没有横向溢出（scrollHeight == innerHeight）', !!m && m.scrollH <= m.innerH + 2, `scrollH=${m && m.scrollH} innerH=${m && m.innerH}`);
    if (failed.length) console.log(`  注意：有 ${failed.length} 个失败请求：${failed.slice(0, 5).join(' | ')}`);
    try { ws.close(); } catch { /* ignore */ }
    child.kill();
  } catch (e) {
    ok('⑤ 浏览器渲染核验可执行', false, String((e && e.message) || e));
  }
}

console.log(`\n${bad === 0 ? '✓ 发布后必查全过' : `✗ 有 ${bad} 项没过`}`);
process.exit(bad === 0 ? 0 : 1);
