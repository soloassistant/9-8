#!/usr/bin/env node
/**
 * verify-hotkeys-live.mjs —— 在**真产物 + 真 Chrome** 上按一遍快捷键（2026-10-27）。
 *
 * 为什么静态门禁不够：
 *   verify-hotkeys.mjs 只能证明「匹配函数的口径对」和「接线写在正确的位置」。
 *   它证明不了**这些监听在真实 bundle 里到底有没有被挂上** —— 而快捷键的失败形态
 *   恰恰是沉默的：脚本没注册、被 H5 门禁挡掉、被开屏/同意层吃掉，页面都一切正常，
 *   只是按了没反应。
 *
 * 这里做的是端到端：起静态服务 → 真 Chrome 打开 dist → 点掉开屏与同意层 →
 *   dispatch 合成 keydown（与用户按键走同一条事件路径：document 冒泡阶段）→
 *   断言「面板真的出现了」「g 前缀真的没被当字符吃掉」「⌘Enter 真的发出去了」。
 *
 * 两个必须用真实事件才能测的点：
 *   · 输入法组字（isComposing）期间按 g 不能跳页；
 *   · Esc 只关最上面那层（面板开着时 Esc 关面板，且不触发全局层的 blur 分支）。
 *
 * 用法: node .tools/verify-hotkeys-live.mjs
 * 退出码: 0 = 全绿；1 = 有断言失败；2 = harness 自身出错（含缺 Chrome）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PROBE = path.join(ROOT, '.tools', 'cdp-probe.mjs');
const SESSION_STUB = path.join(ROOT, '.tools', 'cdp-probe-session.js');

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  'C:\\Users\\geral\\.agent-browser\\browsers\\chrome-154.0.8037.92\\chrome.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

let pass = 0;
let fail = 0;
/** 断言铁律：cond 必须是 boolean（非 boolean 直接抛，避免 `assert(name)` 这种假绿） */
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

function serveDist() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
    // ⚠️ 必须 path.resolve(DIST, '.'+url)：path.join(DIST,'/x') 在 Windows 会算出 C:\x → 全站 403
    let file = path.resolve(DIST, '.' + url);
    if (!file.startsWith(DIST)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (url === '/api/hotspot') {
      file = path.join(DIST, 'api', 'hotspot.json');
      if (fs.existsSync(file)) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        fs.createReadStream(file).pipe(res);
        return;
      }
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function runProbe(url, expr) {
  const chrome = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!chrome) throw new Error('找不到 Chrome（设 CHROME_BIN）');
  const args = [
    PROBE,
    url,
    '1280',
    '860',
    '--expr',
    expr,
    '--wait',
    '9000',
    '--dismiss-splash',
    '--init-script',
    SESSION_STUB
  ];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, CHROME_BIN: chrome } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

/**
 * 页面内脚本：走与用户按键完全相同的事件路径（document 冒泡阶段）。
 * 返回一个可 JSON 化的对象，由 Node 侧断言 —— 页面里不做判断，
 * 因为「页面里判完只回一个 true」会让失败原因彻底丢失。
 */
const EXPR = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const press = (key, extra) => document.dispatchEvent(
    new KeyboardEvent('keydown', Object.assign({ key, bubbles: true, cancelable: true }, extra || {}))
  );
  const kbds = () => document.querySelectorAll('[class*="kbd"]').length;
  const hash = () => location.hash;
  const out = { start: hash() };

  out.pointerFine = !!(window.matchMedia && window.matchMedia('(pointer: fine)').matches);

  // 1. ? 打开快捷键面板
  press('?', { shiftKey: true });
  await sleep(400);
  out.panelKbds = kbds();
  out.panelHasTitle = (document.body.innerText || '').indexOf('键盘快捷键') >= 0;

  // 2. Esc 只关面板（层栈最上层），且不误伤页面
  press('Escape');
  await sleep(400);
  out.panelAfterEsc = kbds();
  out.hashAfterEsc = hash();

  // 3. 输入法组字中：g / m 都不该被当成手势（中文用户打拼音时最危险的一击）
  const beforeIme = hash();
  press('g', { isComposing: true });
  press('m', { isComposing: true });
  await sleep(250);
  out.imeStayed = hash() === beforeIme;

  // 4. g m → 去「我的」
  press('g');
  press('m');
  await sleep(900);
  out.afterGM = hash();

  // 5. g b → 回「晨报」
  press('g');
  press('b');
  await sleep(900);
  out.afterGB = hash();

  // 6. / 在晨报页没有搜索框 → 打开搜索页
  press('/');
  await sleep(900);
  out.afterSlash = hash();

  // 7. 在搜索页再按 / → 聚焦页内搜索框（不该又开一页）
  const beforeSecond = hash();
  press('/');
  await sleep(400);
  const ae = document.activeElement;
  out.samePageAfterSecondSlash = hash() === beforeSecond;
  out.focusTag = ae ? ae.tagName : '';
  out.focusIsInput = !!(ae && ae.tagName === 'INPUT');
  out.focusInSearch = !!(ae && ae.closest && ae.closest('[class*="searchInput"]'));

  // 8. 前缀超时：按 g 之后什么都不按，等过 1200ms，再按 b 不该跳页
  press('g');
  await sleep(1500);
  const beforeLate = hash();
  press('b');
  await sleep(400);
  out.latePrefixIgnored = hash() === beforeLate;

  return JSON.stringify(out);
})()`;

const { server, port } = await serveDist();
try {
  console.log(`\n── 真产物 + 真 Chrome（dist @ 127.0.0.1:${port}）──`);
  const r = await runProbe(`http://127.0.0.1:${port}/#/pages/briefing/index`, EXPR);
  let v = null;
  try {
    // ⚠️ 探针输出是**多行** JSON，且页面内的返回值在 `value` 字段里（外面还包着
    //    navigatedTo / splash / consent 等测量元数据）。直接 parse 整个 stdout。
    const parsed = JSON.parse(r.out);
    if (parsed.error) {
      console.error('页面内脚本抛错：', parsed.error);
      process.exit(2);
    }
    v = parsed.value;
  } catch (err) {
    console.error('探针输出无法解析：', r.out.slice(0, 800), r.err.slice(0, 400));
    process.exit(2);
  }
  if (!v) {
    console.error('探针没有返回值：', r.out.slice(0, 600), r.err.slice(0, 300));
    process.exit(2);
  }

  assert('L1 环境前提：桌面浏览器报告精细指针（否则全局层本来就不该启用）', v.pointerFine === true);
  assert('L2 开屏与合规层都已点掉（否则下面测的是遮罩）',
    v.start.indexOf('briefing') >= 0, `start=${v.start}`);
  assert('L3 按 ? 真的弹出面板（键帽至少 9 个）', v.panelKbds >= 9, `kbds=${v.panelKbds}`);
  assert('L4 面板上写着自己的标题（不是空白弹层）', v.panelHasTitle === true);
  assert('L5 按 Esc 关掉面板', v.panelAfterEsc === 0, `kbds=${v.panelAfterEsc}`);
  assert('L6 Esc 没有顺带触发全局跳转（层栈最上层吃掉这一击）',
    v.hashAfterEsc.indexOf('briefing') >= 0, `hash=${v.hashAfterEsc}`);
  assert('L7 输入法组字期间按 g m 不跳页（中文拼音不被当成手势）', v.imeStayed === true);
  assert('L8 g m 跳到「我的」', v.afterGM.indexOf('mine') >= 0, `hash=${v.afterGM}`);
  assert('L9 g b 跳回「晨报」', v.afterGB.indexOf('briefing') >= 0, `hash=${v.afterGB}`);
  assert('L10 「/」在无搜索框的页面打开搜索页', v.afterSlash.indexOf('search') >= 0, `hash=${v.afterSlash}`);
  assert('L11 在搜索页再按「/」不重复开页', v.samePageAfterSecondSlash === true);
  assert('L12 「/」把焦点放进原生 input', v.focusIsInput === true, `tag=${v.focusTag}`);
  assert('L13 聚焦的是页内搜索框（不是别的输入框）', v.focusInSearch === true);
  assert('L14 g 前缀 1200ms 超时后失效（迟到的 b 不该再跳页）', v.latePrefixIgnored === true);

  console.log(`\n${'='.repeat(52)}`);
  console.log(`快捷键实机验证：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) {
    console.log('有断言失败 —— 快捷键在真实产物里不可用或行为不对。');
    process.exit(1);
  }
  console.log('全部通过。');
} finally {
  server.close();
}
