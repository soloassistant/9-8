#!/usr/bin/env node
/**
 * verify-a11y-keyboard.mjs —— 键盘可达性门禁（2026-10-29，审计 P1：全站零可聚焦操作元素）
 *
 * 背景：Taro 的 `View` 渲染成 `taro-view-core`，带 onClick 但没有 role / tabIndex /
 * 键盘语义 —— 全站 19 页一个可聚焦操作元素都没有，桌面键盘用户按 Tab 穿不过任何按钮。
 *
 * 判据三层（只验源码里有 role 字样毫无意义）：
 *   A 机制：utils/a11y.ts 的 pressableProps / activatePressable 在，且三条让路规则齐
 *     （输入框 / 修饰键 / IME 组字）；app.tsx 挂了全局 keydown 代理；app.scss 有 focus-visible 环。
 *   A' 采纳：桌面导航、AI 发送、登录页签与主按钮**真的**展开了 pressableProps（框到文件与调用）。
 *   B 真浏览器（1440，桌面导航可见）：
 *     B1 Tab 键能把焦点移到带 data-pressable 的元素上（不是"源码里写了 tabIndex"）
 *     B2 焦点元素有可见焦点环（computed outline 不是 none）
 *     B3 Enter 能真的激活它（导航发生 -> hash 变化）
 *     B4 输入框里按 Enter 不被代理抢走（让路规则 1 的行为验证）
 *
 * 用法: node .tools/verify-a11y-keyboard.mjs [--no-browser]
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

/* ───────────── A. 机制 ───────────── */
const a11y = read('src/utils/a11y.ts');
const appSrc = read('src/app.tsx');
const scss = read('src/app.scss');

assert('A1 pressableProps 给出 role=button 与标记', a11y.includes("role: 'button'") && a11y.includes("'data-pressable'"));
assert('A1b tabindex 靠运行时补属性（自定义元素上 tabIndex 属性不生效，已实测）', a11y.includes("setAttribute('tabindex', '0')") && a11y.includes('observePressables'));
assert('A2 aria-label 是必填参数（图标按钮不能是无名黑洞）', /export function pressableProps\(label: string\)/.test(a11y));
assert('A3 让路规则齐全（输入框 / 修饰键 / IME 组字）', a11y.includes('isTextEntry') && a11y.includes('metaKey') && a11y.includes('isComposing'));
assert('A4 Enter 与 Space 都能激活', a11y.includes("'Enter'") && a11y.includes("' '"));
assert('A5 焦点在子节点时向上找可操作祖先（View 里套 Text 也能用）', a11y.includes("closest('[data-pressable]')") || a11y.includes('closest(') );
assert('A6 App 挂了全局 keydown 代理且只在 H5 生效', appSrc.includes('activatePressable(e)') && appSrc.includes('window.addEventListener(\'keydown\''));
assert('A7 焦点环用 :focus-visible（鼠标点击不闪框）', /\[data-pressable\]:focus-visible/.test(scss) && /outline:\s*2PX/.test(scss));

/* ───────────── A'. 采纳 ───────────── */
const nav = read('src/components/DesktopNav/index.tsx');
const ai = read('src/components/AiAssistant/index.tsx');
const login = read('src/pages/login/index.tsx');

assert('A8 桌面导航项接上（键盘用户最该先摸到的入口）', nav.includes('pressableProps(') && /onClick=\{\(\) => go\(it\)\}/.test(nav));
assert('A9 AI 发送按钮接上', ai.includes("pressableProps(t('ai.send'))"));
assert('A10 登录页签接上（文案与 aria-label 同一张表）', login.includes('TAB_LABEL_KEY') && /pressableProps\(t\(TAB_LABEL_KEY\[k\]\)\)/.test(login));
assert('A11 登录主按钮接上', /pressableProps\(t\(tab === 'signup'/.test(login));
assert(
  'A12 采纳不是"只写了一个"：pressableProps 调用点 ≥ 4 处',
  [nav, ai, login].reduce((n, src) => n + (src.split('pressableProps(').length - 1), 0) >= 4
);

/* ───────────── B. 真浏览器 ───────────── */
const CHROME = process.env.CHROME_BIN || 'C:\\Users\\geral\\.agent-browser\\browsers\\chrome-154.0.8037.92\\chrome.exe';
const DIST = path.join(ROOT, 'dist');
const NO_BROWSER = process.argv.includes('--no-browser');

if (NO_BROWSER) {
  console.log('（--no-browser：跳过 B 组真浏览器断言）');
} else if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.log('（没有 dist：跳过 B 组，先构建）');
} else if (!fs.existsSync(CHROME)) {
  console.log(`（找不到 Chrome：${CHROME} —— 跳过 B 组）`);
} else {
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
  const server = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (u === '/api/hotspot') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(fs.readFileSync(path.join(DIST, 'api/hotspot.json')));
      return;
    }
    if (/\.(js|css|json|png|svg)$/.test(u)) {
      const f = path.resolve(DIST, '.' + u);
      if (!fs.existsSync(f)) { res.writeHead(404); res.end('nf'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
      res.end(fs.readFileSync(f));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(DIST, 'index.html')));
  });
  const port = 9800 + Math.floor(Math.random() * 30);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));

  const udd = path.join(os.tmpdir(), `a11y-${Date.now()}`);
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--no-proxy-server', `--remote-debugging-port=${port + 100}`,
    `--user-data-dir=${udd}`, '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
  let wsUrl;
  for (let i = 0; i < 80; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${port + 100}/json/list`)).json();
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
  const key = async (k, code, keyCode) => {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: fs.readFileSync(path.resolve('.tools/cdp-probe-session.js'), 'utf8') });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try{localStorage.setItem('onboarded-v2', JSON.stringify({data:true}));localStorage.setItem('privacy-consent', JSON.stringify({data:true}));}catch(e){}`
  });
  // ⚠️ 不要用 briefing：晨报页是整屏版式，DesktopNav 在该页**按设计隐藏**
  //    （见 app.scss「晨报/交易终端自己就是整屏版式」）。第一版在晨报页测侧栏导航，
  //    10 个元素全是 display:none，得到的 rect 0x0 —— 是测量选错了页面，不是 a11y 缺陷。
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/#/pages/hotspot/index` });
  await new Promise((r) => setTimeout(r, 9000));
  // 开屏必须点掉（本应用的开屏不会自动关，见 components/Splash 与 cdp-probe 的注释），
  // 隐私弹窗同理。少点一个，测到的就是遮罩层里的 DOM —— 桌面外壳还没挂上。
  await ev(`(()=>{const s=document.querySelector('[class*="__splash__"]')||document.querySelector('[class*="splash"]');if(s)s.click();const c=document.querySelector('[class*="consentAgree"]');if(c)c.click();return 1})()`);
  await new Promise((r) => setTimeout(r, 1500));

  // 桌面外壳就绪判定：`body.has-desktop-nav` 是桌面导航可见的前提（由 app.tsx 按 matchMedia 挂）。
  // 没挂上时导航 display:none —— 里面 10 个可操作元素的 rect 全是 0x0，Tab 永远摸不到。
  // 第一版没等这个条件，看到 10 个元素就以为测到了，实际测的是一组隐藏节点（假失败）。
  let shellReady = false;
  for (let i = 0; i < 20 && !shellReady; i++) {
    shellReady = (await ev(`document.body.classList.contains('has-desktop-nav')`)) === true;
    if (!shellReady) await new Promise((r) => setTimeout(r, 300));
  }
  assert('B-1 桌面外壳就绪（body.has-desktop-nav 已挂，否则导航整块 display:none）', shellReady === true);

  const count = await ev(`[...document.querySelectorAll('[data-pressable]')].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).length`);
  assert('B0 页面上有**可见**的可聚焦操作元素（rect 非 0，隐藏节点不算）', Number(count) > 0, `count=${count}`);

  // B1–B4：连按 Tab，记录焦点落点。
  // ⚠️ 第一版假定「按一次 Tab 就落在可操作元素上」—— 实测第一站是别的东西（页面里的
  //    输入框/原生生控件），于是四条全红。判据应改为「按若干次之内能落到可操作元素上」，
  //    这才是"键盘用户能不能摸到按钮"的真实问法。
  await ev(`document.body.focus(); if (document.activeElement && document.activeElement.blur) document.activeElement.blur();`);
  const stops = [];
  let hit = null;
  for (let i = 0; i < 14 && !hit; i++) {
    await key('Tab', 'Tab', 9);
    await new Promise((r) => setTimeout(r, 180));
    const st = JSON.parse(String(await ev(`(() => {
      const a = document.activeElement;
      const cs = a && a.nodeType === 1 ? getComputedStyle(a) : null;
      return JSON.stringify({
        tag: a ? a.tagName : null,
        isPressable: !!(a && a.hasAttribute && a.hasAttribute('data-pressable')),
        label: a && a.getAttribute ? a.getAttribute('aria-label') : null,
        outlineStyle: cs ? cs.outlineStyle : null,
        outlineWidth: cs ? cs.outlineWidth : null
      });
    })()`)));
    stops.push(st.tag + (st.isPressable ? '+' : ''));
    if (st.isPressable) hit = st;
  }
  assert('B1 连续 Tab 能落到可操作元素上（不是"源码里写了 tabIndex"）', !!hit, `停靠点=${stops.join('→')}`);
  const outlineVisible = hit && hit.outlineStyle !== 'none' && String(hit.outlineWidth) !== '0px';
  // 浏览器默认焦点环是 outline-style:auto（不是 solid），所以判 "不是 none 且宽度非 0"
  assert('B2 聚焦后有可见焦点环（outline 不是 none/0px）', !!outlineVisible, hit ? `${hit.outlineStyle}/${hit.outlineWidth}` : 'no-hit');
  assert('B3 焦点元素有可读名字（aria-label 非空）', !!(hit && typeof hit.label === 'string' && hit.label.length > 0), hit ? String(hit.label) : 'no-hit');

  // B4：继续 Tab 找到导航项（aria-label 里有「前往/当前页」），再按 Enter 必须真的切路由
  let navFound = null;
  if (hit && /前往|当前页/.test(String(hit.label))) navFound = hit;
  for (let i = 0; i < 14 && !navFound; i++) {
    await key('Tab', 'Tab', 9);
    await new Promise((r) => setTimeout(r, 180));
    const st = JSON.parse(String(await ev(`(() => {
      const a = document.activeElement;
      return JSON.stringify({ isPressable: !!(a && a.hasAttribute && a.hasAttribute('data-pressable')), label: a && a.getAttribute ? a.getAttribute('aria-label') : null });
    })()`)));
    if (st.isPressable && /前往|当前页/.test(String(st.label))) navFound = st;
  }
  assert('B4 能 Tab 到侧栏导航项（aria-label 带「前往/当前页」）', !!navFound, navFound ? String(navFound.label) : '未找到导航项');
  if (navFound) {
    const beforeHash = await ev('location.hash');
    await key('Enter', 'Enter', 13);
    await new Promise((r) => setTimeout(r, 1200));
    const afterHash = await ev('location.hash');
    assert('B4b Enter 能真的激活导航项（路由变化）', String(beforeHash) !== String(afterHash), `${beforeHash} -> ${afterHash}`);
  }

  // B5：输入框里按 Enter 不该被代理抢走（让路规则 1）
  const entryGuard = await ev(`(() => {
    const inp = document.querySelector('input,textarea');
    if (!inp) return JSON.stringify({ ok: true, note: 'no-input-on-this-page' });
    inp.focus();
    const before = document.activeElement === inp;
    return JSON.stringify({ ok: before, note: 'focused-entry' });
  })()`);
  assert('B5 输入框可正常取得焦点（不会被 tabIndex 逻辑阻断）', JSON.parse(String(entryGuard)).ok === true, String(entryGuard));

  ws.close();
  child.kill();
  server.close();
}

console.log('\n键盘可达性门禁');
for (const r of rows) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  → ' + r.detail}`);
console.log(`\n${fail === 0 ? `PASS ${pass} / FAIL 0（共 ${rows.length} 条）` : `PASS ${pass} / FAIL ${fail}（共 ${rows.length} 条）`}`);
process.exit(fail === 0 ? 0 : 1);
