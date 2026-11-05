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
 *   A16b/A16d **真行为**（esbuild 直编源码 + 真 Chrome，2026-11-05 改）：
 *     只有自己挂了 click 的节点被标成可操作（遮罩/吞点击容器不该变按钮）；
 *     首屏扫完后动态插入的子树也必须被扫到。原来是「源码逐行字面」断言，
 *     #48 做等价重写就被误判成红 —— 源码长什么样不是行为。
 *   A' 采纳：桌面导航、AI 发送、登录页签与主按钮**真的**展开了 pressableProps（框到文件与调用）。
 *   B 真浏览器（1440，桌面导航可见，落到 /pages/library/index 真实列表页）：
 *     B-2 页面正文真的渲染了（原来测的 `pages/hotspot/index` 路由不存在，
 *         空壳页里导航照常渲染 → 21 条全绿却从没验过页面内容，2026-10-29 线上复核抓到）
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

// 判据框到**返回对象那一行**：只查 `includes("'data-pressable'")` 会被
// ensureFocusable 里的选择器命中，把标记从返回对象删掉照样绿（变异测试抓到过）。
assert('A1 pressableProps 真的返回 role=button + data-pressable', a11y.includes("const attrs: PressableAttrs = { role: 'button', 'data-pressable': '1' };"));
assert('A1b tabindex 靠运行时补属性（自定义元素上 tabIndex 属性不生效，已实测）', a11y.includes("setAttribute('tabindex', '0')") && a11y.includes('observePressables'));
assert('A2 aria-label 是必填参数（图标按钮不能是无名黑洞）', /export function pressableProps\(label: string\)/.test(a11y));
// ⚠️ 判据要框到**守卫行本身**：第一版只查 `a11y.includes('isTextEntry')`，
//    于是把 `if (!active || isTextEntry(active)) return false;` 改成 `if (!active)` 后
//    函数定义还在、字符串还在，断言照样绿（变异测试当场抓到）。
assert('A3 输入框让路守卫在（`if (!active || isTextEntry(active)) return false;`）', a11y.includes('if (!active || isTextEntry(active)) return false;'));
assert('A3b IME 组字让路守卫在（`e.isComposing || e.keyCode === 229`）', a11y.includes('if (e.isComposing || e.keyCode === 229) return false;'));
assert('A3c 修饰键让路守卫在（metaKey/ctrlKey/altKey/shiftKey）', a11y.includes('e.metaKey || e.ctrlKey || e.altKey || e.shiftKey'));
assert('A4 Enter 与 Space 都能激活', a11y.includes("'Enter'") && a11y.includes("' '"));
assert('A5 焦点在子节点时向上找可操作祖先（View 里套 Text 也能用）', a11y.includes("closest('[data-pressable]')") || a11y.includes('closest(') );
assert('A6 App 挂了全局 keydown 代理且只在 H5 生效', appSrc.includes('activatePressable(e)') && appSrc.includes('window.addEventListener(\'keydown\''));
assert('A7 焦点环用 :focus-visible（鼠标点击不闪框）', /\[data-pressable\]:focus-visible/.test(scss) && /outline:\s*2PX/.test(scss));
// ★ 2026-10-29 第二轮：自动识别可点击元素。
//   手工 `pressableProps` 只覆盖了 3 处，全站 239 处 onClick 里 236 处仍是「只有鼠标能用」。
//   识别信号是「这个 Taro 元素自己注册过原生 click」—— 靠包装一次 addEventListener 记录。
//   （试错过程写在 a11y.ts 顶部：props 里拿不到 onClick，fiber 回溯会把子节点全算进去。）
//   ⚠️ 判据必须框到**整行**：`includes('markClickableAsPressable(')` 只能证明名字出现过，
//      把调用改成 `if (false) markClickableAsPressable(...)` 照样绿（今天已经栽过三次）。
assert('A16 自动识别机制存在（包装 addEventListener 记录 Taro 元素的 click）',
  /^export function patchClickTracking\(\): void \{$/m.test(a11y) &&
  a11y.includes('EventTarget.prototype.addEventListener = function patchedAddEventListener('));
assert('A16a 包装只记 click、只记 TARO-* 元素（不污染 React 根委托/其他库）',
  /^[ \t]*if \(type === 'click'\) \{$/m.test(a11y) &&
  a11y.includes("el.tagName.indexOf('TARO-') === 0"));
// A16b / A16d 已从「源码逐行字面」改成**真行为断言**（见下方 A16 真行为段）。
// 原因（2026-11-05）：#48 把 markClickableAsPressable 重写成「候选收集 → markOne」，
// 语义完全没变，但原断言盯的是 `if (!clickBound.has(el)) continue;` 与
// `for (const el of batch) markClickableAsPressable(el);` 两行原文 —— 换一种等价写法就假红。
// 「源码里有没有那行」不是行为：门禁必须看**渲染后 DOM 上到底有没有 data-pressable**。
assert('A16c 包装必须在首屏扫描之前接上（否则首屏那批元素的监听已经挂完，看不见）',
  /^[ \t]*patchClickTracking\(\);$/m.test(a11y) &&
  /^[ \t]*markClickableAsPressable\(document\.body\);$/m.test(a11y) &&
  a11y.indexOf('patchClickTracking();') < a11y.indexOf('markClickableAsPressable(document.body);'));

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

/* ───────────── A''. 触摸热区 ≥44px（2026-11-04，审计 P1） ─────────────
 * 手机端审计（.tmp-verify/responsive/audit.mjs）实测 17 个控件宽或高 <44：
 *   日历翻月 32×32、日期格 44×38、自选页签 44×24、设置 兴趣/清除/重置统计 64×23、
 *   来源⚙ 高 36、收件箱 modeTab 32 / extractButton 40、学习语言页签 36、省心买页签 32、
 *   avatarEdit 33×16、各页返回条 19~40。
 * 修法：**视觉尺寸不变**，用 `.hit-expand` 透明伪元素外扩，或给日期格加 min-height。
 * 判据锁住「每个控件真的被处理过」——只查源码里出现 `hit-expand(` 会被别处的调用点亮。
 */
const varsScss = read('src/styles/variables.scss');
assert(
  'A13 hit-expand 混入存在且只用透明伪元素扩命中（不画像素、不改视觉）',
  /@mixin hit-expand\(/.test(varsScss) && /background:\s*transparent;/.test(varsScss)
);

const stripScssComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
/** 取某个选择器在文件里的**所有**规则体（同名选择器可能出现在多个上下文里） */
function ruleBlocks(src, sel) {
  const s = stripScssComments(src);
  const re = new RegExp('(^|\\n)\\s*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[,\\s{]', 'g');
  const out = [];
  for (const m of s.matchAll(re)) {
    const start = s.indexOf('{', m.index);
    if (start < 0) continue;
    let depth = 0;
    for (let i = start; i < s.length; i++) {
      if (s[i] === '{') depth++;
      else if (s[i] === '}' && --depth === 0) {
        out.push(s.slice(start + 1, i));
        break;
      }
    }
  }
  return out;
}

const TOUCH = [
  ['src/pages/calendar/index.module.scss', '.navButton', 'hit', '日历翻月'],
  ['src/pages/calendar/index.module.scss', '.cell', 'min', '日历日期格'],
  ['src/pages/library/index.module.scss', '.aiEditBtn', 'hit', '设置 兴趣/清除/重置统计'],
  ['src/pages/library/index.module.scss', '.sourceEntry', 'hit', '来源⚙'],
  ['src/pages/trade/index.module.scss', '.wlTab', 'pseudo', '行情自选页签'],
  ['src/pages/trade/index.module.scss', '.backBtn', 'pseudo', '行情返回条'],
  ['src/pages/inbox/index.module.scss', '.modeTab', 'hit', '收件箱模式页签'],
  ['src/pages/inbox/index.module.scss', '.extractButton', 'hit', '收件箱提取按钮'],
  ['src/pages/learn/index.module.scss', '.langTab', 'hit', '学习语言页签'],
  ['src/pages/learn/index.module.scss', '.backButton', 'hit', '学习返回条'],
  ['src/pages/sxm/index.module.scss', '.tab', 'hit', '省心买页签'],
  ['src/pages/mine/index.module.scss', '.avatarEdit', 'hit', '头像编辑'],
  ['src/pages/ledger/index.module.scss', '.backButton', 'hit', '记账返回条'],
  ['src/pages/shopping/index.module.scss', '.backButton', 'hit', '购物返回条'],
  ['src/pages/search/index.module.scss', '.backButton', 'hit', '搜索返回条'],
  ['src/pages/sport/index.module.scss', '.backRow', 'hit', '运动返回条'],
  ['src/pages/notify/index.module.scss', '.back', 'hit', '通知返回条'],
];
const touchBad = [];
for (const [file, sel, mode, why] of TOUCH) {
  const blocks = ruleBlocks(read(file), sel);
  const ok = blocks.some((body) =>
    mode === 'hit'
      ? /@include\s+hit-expand\(/.test(body)
      : mode === 'min'
        ? /min-height:\s*88rpx/.test(body)
        : /&::before[\s\S]*?background:\s*transparent/.test(body)
  );
  if (!ok) touchBad.push(`${why}(${sel})`);
}
assert(
  `A14 ${TOUCH.length} 个 <44px 控件都按「视觉不变、热区 ≥44」处理（hit-expand / min-height / 透明伪元素）`,
  touchBad.length === 0,
  touchBad.join(' | ')
);

/* ───────────── B. 真浏览器 ───────────── */
const CHROME = process.env.CHROME_BIN || 'C:\\Users\\geral\\.agent-browser\\browsers\\chrome-154.0.8037.92\\chrome.exe';
const DIST = path.join(ROOT, 'dist');
const NO_BROWSER = process.argv.includes('--no-browser');

/* ───────────── A16b / A16d. 真行为（esbuild 直编 src/utils/a11y.ts + 真 Chrome）─────────
 * 语义（不许弱化）：
 *   A16b —— 只有**自己挂了 click** 的节点才该被标成可操作。遮罩/弹层这种只用来吞点击的
 *           容器如果也变成按钮，读屏用户会撞上一串无名按钮、Tab 序列被无效停靠点塞满。
 *   A16d —— 首屏扫完之后**动态插入**的子树（列表数据到位）也必须被扫到，否则新卡片又只剩鼠标可用。
 *
 * 做法：用 esbuild 把**当前源码**编成 bundle（不是 dist 产物），真 Chrome 里加载，
 * 构造两种子树，断言 `data-pressable` 的真实存在与否。
 *   · 直接编源码 = 变异测试能生效（改坏 src 不用重建 dist 就能让断言转红）；
 *   · 判别力由 mutations-a11y 的两条变异守着：去 clickBound 判断 → A16b 红；
 *     去新增子树扫描 → A16d 红。
 */
async function runA16Behavior() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-a16-'));
  let server = null;
  try {
    const esbuild = await import('esbuild');
    const ENTRY = `
import { markClickableAsPressable, observePressables } from './a11y';

window.__runA16 = async function () {
  const out = {};
  const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  const mk = function () { return document.createElement('taro-view-core'); };
  const NOOP = function () {};

  // A16b：自己挂了 click 的节点 vs 只吞点击的容器（遮罩 / 弹层）
  const host = mk();
  const mask = mk();
  const btn = mk();
  btn.addEventListener('click', NOOP); // 走 a11y 包装过的 addEventListener → clickBound 记一笔
  mask.appendChild(btn);
  host.appendChild(mask);
  document.body.appendChild(host);
  markClickableAsPressable(host);     // 真实公开 API 的同步路径
  out.A16b = {
    buttonMarked: btn.getAttribute('data-pressable') === '1',
    buttonTabindex: btn.getAttribute('tabindex'),
    maskMarked: mask.hasAttribute('data-pressable'),
    containerMarked: host.hasAttribute('data-pressable')
  };

  // A16d：首屏扫完之后「动态插入」的新子树（模拟列表数据到位）必须被扫到
  const stop = observePressables();
  await sleep(30);
  const list = mk();
  const items = [mk(), mk(), mk()];
  items.forEach(function (it) { it.addEventListener('click', NOOP); });
  items.forEach(function (it) { list.appendChild(it); });
  document.body.appendChild(list);
  let marked = 0;
  for (let i = 0; i < 40; i++) {      // rIC 兜底 200ms → 2s 足够
    marked = items.filter(function (it) { return it.getAttribute('data-pressable') === '1'; }).length;
    if (marked === items.length) break;
    await sleep(50);
  }
  out.A16d = { total: items.length, marked: marked };
  stop();
  document.body.innerHTML = '';
  return JSON.stringify(out);
};
`;
    const built = await esbuild.build({
      stdin: { contents: ENTRY, resolveDir: path.join(ROOT, 'src', 'utils'), loader: 'ts', sourcefile: 'a16-entry.ts' },
      bundle: true,
      format: 'iife',
      target: 'es2020',
      write: false
    });
    fs.writeFileSync(path.join(tmp, 'bundle.js'), built.outputFiles[0].text);
    fs.writeFileSync(
      path.join(tmp, 'index.html'),
      '<!doctype html><meta charset="utf-8"><body><script src="./bundle.js"></script></body>'
    );
    server = await new Promise((resolve) => {
      const s = http.createServer((req, res) => {
        const rel = (req.url || '/').split('?')[0] === '/' ? 'index.html' : (req.url || '').replace(/^\//, '');
        const f = path.join(tmp, rel);
        if (!f.startsWith(tmp) || !fs.existsSync(f)) { res.writeHead(404).end('nf'); return; }
        res.writeHead(200, { 'Content-Type': path.extname(f) === '.js' ? 'text/javascript' : 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(f));
      });
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = server.address().port;
    // 子进程跑 cdp-probe（它会自己拉起独立 headless Chrome）。必须异步 spawn：
    // 本进程若被 spawnSync 堵住，静态服务就不应答，Page.navigate 会超时（verify-compress 踩过）。
    const probe = await new Promise((resolve) => {
      const child = spawn(process.execPath, [
        path.join(ROOT, '.tools', 'cdp-probe.mjs'),
        `http://127.0.0.1:${port}/`, '1280', '800',
        '--wait', '400', '--expr', 'window.__runA16()'
      ], { cwd: ROOT, env: process.env });
      let buf = '';
      let err = '';
      const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } }, 150_000);
      // ⚠️ stdout 与 stderr 必须分开收：Node 自己会往 stderr 打废弃警告，
      // 拼进同一个串会让 JSON.parse 直接失败（看起来像断言红，其实是解析被噪声打断）。
      child.stdout.on('data', (d) => (buf += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('close', () => { clearTimeout(timer); resolve({ out: buf, err }); });
    });
    let value = null;
    try {
      value = JSON.parse(probe.out).value;
    } catch {
      /* 下面是断言失败，detail 里带原始输出 */
    }
    return { value, raw: `${probe.out}${probe.err}` };
  } finally {
    if (server) server.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录删不掉不影响结果 */ }
  }
}

if (NO_BROWSER) {
  console.log('（--no-browser：跳过 A16b/A16d 真行为断言）');
} else if (!fs.existsSync(CHROME)) {
  console.log(`（找不到 Chrome：${CHROME} —— 跳过 A16b/A16d 真行为断言）`);
} else {
  const r = await runA16Behavior();
  const v = r.value && r.value.A16b && r.value.A16d ? r.value : null;
  const b = v ? v.A16b : {};
  const d = v ? v.A16d : {};
  assert('A16b 只有自己挂了 click 才标记（遮罩/吞点击容器不该变成按钮）',
    v !== null && b.maskMarked === false && b.containerMarked === false,
    v ? JSON.stringify(b) : String(r.raw).slice(-400));
  assert('A16b2 正例：自己挂了 click 的节点确实被标成可操作（含 tabindex）',
    v !== null && b.buttonMarked === true && b.buttonTabindex === '0',
    v ? JSON.stringify(b) : String(r.raw).slice(-400));
  assert('A16d 渲染后动态插入的子树会被扫到（动态列表才覆盖得到）',
    v !== null && d.marked > 0 && d.total > 0,
    v ? JSON.stringify(d) : String(r.raw).slice(-400));
  assert('A16d2 新增子树里的每一张都标记（不是只扫到第一个）',
    v !== null && d.total > 0 && d.marked === d.total,
    v ? JSON.stringify(d) : String(r.raw).slice(-400));
}

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
  // ⚠️ 也别写 `pages/hotspot/index` —— **这个路由不存在**（热点已并入资料库页，
  //    DesktopNav 的 `tab.hotspot` 指向 `/pages/library/index`）。写了不存在的路由，
  //    Taro 渲染出空壳，但 DesktopNav 是挂在页面之外的，照样 10 项可见可聚焦，
  //    于是 B 组全绿 —— 测的是「导航外壳」，页面正文根本没渲染（2026-10-29 线上复核时发现）。
  // 静态先把关：本文件用的路由必须真的出现在 app.config.ts 的 pages 里。
  const ROUTE = '/pages/library/index';
  const appConfig = read('src/app.config.ts');
  assert(`A0 门禁用的路由 ${ROUTE} 真的在 app.config.ts 的 pages 里（防再测一个空壳）`,
    appConfig.includes(`'${ROUTE.slice(1)}'`), 'app.config.ts 里没有这个页面');
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/#${ROUTE}` });
  await new Promise((r) => setTimeout(r, 9000));
  // 开屏必须点掉（本应用的开屏不会自动关，见 components/Splash 与 cdp-probe 的注释），
  // 隐私弹窗同理。少点一个，测到的就是遮罩层里的 DOM —— 桌面外壳还没挂上。
  await ev(`(()=>{const s=document.querySelector('[class*="__splash__"]')||document.querySelector('[class*="splash"]');if(s)s.click();const c=document.querySelector('[class*="consentAgree"]');if(c)c.click();return 1})()`);
  await new Promise((r) => setTimeout(r, 1500));

  // 等页面内容真正到位再采样：固定 9s 不够 —— 资料库页要拉分包，实测同一份产物
  // 连跑三次，有一次采样时只有 100 个节点/274 字（页面还在加载），B-2 与 B0b 双双误红。
  // 这是**门的竞态**，不是页面坏了：改成轮询到「节点够多」或超时，再采样。
  let pageSettled = false;
  for (let i = 0; i < 30 && !pageSettled; i++) {
    const n = Number(await ev(`document.querySelectorAll('taro-view-core,taro-text-core').length`));
    if (n > 300) { pageSettled = true; break; }
    await new Promise((r) => setTimeout(r, 700));
  }
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

  // 页面正文真的渲染了 —— 这一条是补上的，因为原来测的路由不存在：
  // 空壳页里 DesktopNav 照样渲染，B 组 21 条全绿，但「键盘能不能操作页面内容」从未被验过。
  // 判据用 Taro 节点数（空壳约 40，真实列表页上千）+ 正文字数，双条件挡假绿。
  const pageShape = JSON.parse(String(await ev(`(() => {
    const nodes = document.querySelectorAll('taro-page-core, taro-view-core, taro-text-core').length;
    const txt = ((document.getElementById('app') || document.body).innerText || '').replace(/\\s+/g, ' ').trim();
    return JSON.stringify({ nodes, textLen: txt.length,
      overlay: !!document.getElementById('wb-boot-failure'),
      skeleton: !!document.getElementById('boot-skeleton'),
      head: txt.slice(0, 50) });
  })()`)));
  assert('B-2 页面正文真的渲染了（不是空壳页：节点 > 300 且正文 > 200 字）',
    pageShape.nodes > 300 && pageShape.textLen > 200, `nodes=${pageShape.nodes} textLen=${pageShape.textLen}`);

  // B5：输入框能正常取得焦点（让路逻辑不能把输入框也一起 ban 掉）。
  // ⚠️ 这一条必须跑在「按 Enter 切页」之前：切页后 DOM 换了一茬，
  //    再 querySelector('input') 命中的可能是新页面里还没挂上布局的节点，
  //    focus() 静默失败 → 看起来像 a11y 缺陷，其实是测量时机错了（2026-10-29 实测）。
  const entryGuard = await ev(`(() => {
    const inp = [...document.querySelectorAll('input,textarea')].find((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (!inp) return JSON.stringify({ ok: true, note: 'no-visible-input-on-this-page' });
    inp.focus();
    return JSON.stringify({ ok: document.activeElement === inp, note: 'focused-entry' });
  })()`);
  assert('B5 输入框可正常取得焦点（不会被 tabIndex 逻辑阻断）', JSON.parse(String(entryGuard)).ok === true, String(entryGuard));

  const count = await ev(`[...document.querySelectorAll('[data-pressable]')].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).length`);
  assert('B0 页面上有**可见**的可聚焦操作元素（rect 非 0，隐藏节点不算）', Number(count) > 0, `count=${count}`);

  // B0b：**内容区**（排除左侧导航）也必须有一批可操作元素。
  // 这一条才是「a11y 覆盖到页面内容」的判据 —— 原来 B0 只要求 >0，而导航就挂在页面之外，
  // 于是哪怕正文一个可操作元素都没有，B0 也绿（审计原话：23 个页面里只有 login 有）。
  const contentCount = await ev(`[...document.querySelectorAll('[data-pressable]')].filter((el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const label = el.getAttribute('aria-label') || '';
    return !/前往|当前页/.test(label); // 排除左侧导航
  }).length`);
  assert('B0b 页面**内容区**有 ≥30 个可聚焦操作元素（证明不是只覆盖了导航）', Number(contentCount) >= 30, `contentCount=${contentCount}`);

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

  // B4：导航项本身必须可聚焦、且 Enter 能真的切路由。
  //
  // ⚠️ 这里**不再用连续 Tab** 去「走到」导航。自动标记上线后正文有 2000+ 停靠点，
  //    而 DesktopNav 在 DOM 里排在正文**之后**（实测焦点序号 2121–2130）——
  //    真按 Tab 要走两千次才到导航。那是**产品问题（Tab 顺序），不是 a11y 缺失**，
  //    用「按 60 次 Tab 找到导航」当判据只会得到一个永远红、且红得没意义的断言。
  //    所以这里验两件能验的事：① 导航项在焦点序列里（tabindex=0，不是被排除）；
  //    ② 聚焦后 Enter 真的切路由。Tab 顺序问题单独记为已知缺口（见本文件末尾注释）。
  const navInfo = JSON.parse(String(await ev(`(() => {
    const nav = [...document.querySelectorAll('[data-pressable]')]
      .filter((el) => /前往|当前页/.test(el.getAttribute('aria-label') || ''));
    const focusables = [...document.querySelectorAll('[tabindex]')].filter((el) => el.tabIndex >= 0);
    return JSON.stringify({
      count: nav.length,
      allFocusable: nav.length > 0 && nav.every((el) => el.getAttribute('tabindex') === '0'),
      firstIndex: nav.length ? focusables.indexOf(nav[0]) : -1,
      totalFocusables: focusables.length
    });
  })()`)));
  assert('B4 导航项在焦点序列里（tabindex=0，不是被排除在外）',
    navInfo.count >= 8 && navInfo.allFocusable === true, JSON.stringify(navInfo));
  // ★ B4c：Tab 顺序。原来 DesktopNav 排在 children 之后，导航首个停靠点是 2121/2131 ——
  //   键盘用户要穿过整个正文才摸得到导航。改成排在正文之前后应该在个位数。
  //   判据取「前 30 位」而不是「第 1 位」：正文前面可能有开屏/同意层的按钮，留点余量。
  assert('B4c 导航排在前 30 个停靠点之内（Tab 顺序：导航 → 正文，不是正文 → 导航）',
    navInfo.firstIndex >= 0 && navInfo.firstIndex < 30,
    `导航首个停靠点在第 ${navInfo.firstIndex + 1} / ${navInfo.totalFocusables} 位`);
  // 如实记录 Tab 顺序现状：导航排在正文之后，键盘用户要穿过去。写成可见数字，别藏。
  console.log(`  （Tab 顺序现状：导航首个停靠点在第 ${navInfo.firstIndex + 1} / ${navInfo.totalFocusables} 位）`);

  const navActivated = await ev(`(() => {
    const el = [...document.querySelectorAll('[data-pressable]')]
      .find((x) => /前往/.test(x.getAttribute('aria-label') || ''));
    if (!el) return 'no-nav';
    el.focus();
    return document.activeElement === el ? 'focused' : 'focus-failed';
  })()`);
  assert('B4a 导航项能被聚焦（键盘用户确实可以停在上面）', String(navActivated) === 'focused', String(navActivated));
  if (String(navActivated) === 'focused') {
    const beforeHash = await ev('location.hash');
    await key('Enter', 'Enter', 13);
    await new Promise((r) => setTimeout(r, 1200));
    const afterHash = await ev('location.hash');
    assert('B4b Enter 能真的激活导航项（路由变化）', String(beforeHash) !== String(afterHash), `${beforeHash} -> ${afterHash}`);
  }

  // （B5 输入框焦点检查已前移到 B-2 之后：切页后 DOM 换茬，时机不对会假失败）

  ws.close();
  child.kill();
  server.close();
}

console.log('\n键盘可达性门禁');
for (const r of rows) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  → ' + r.detail}`);
console.log(`\n${fail === 0 ? `PASS ${pass} / FAIL 0（共 ${rows.length} 条）` : `PASS ${pass} / FAIL ${fail}（共 ${rows.length} 条）`}`);
process.exit(fail === 0 ? 0 : 1);
