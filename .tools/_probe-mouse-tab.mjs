/**
 * _probe-mouse-tab.mjs —— 用真实鼠标事件（CDP Input.dispatchMouseEvent）点登录页 tab，
 * 验证「点击是否真的切换通道」。DOM el.click() 能过，真实鼠标过不了，就必须区分这两条路径。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME_BIN || 'C:\\Users\\geral\\.agent-browser\\browsers\\chrome-154.0.8037.92\\chrome.exe';
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8147';
const port = 9600 + Math.floor(Math.random() * 200);
const udd = path.join(os.tmpdir(), `mtab-${Date.now()}`);
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--no-proxy-server', '--hide-scrollbars',
  `--remote-debugging-port=${port}`, `--user-data-dir=${udd}`, '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws, id = 0;
const pending = new Map();
const send = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)); };
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return 'ERR:' + r.exceptionDetails.text;
  return r.result.value;
};

(async () => {
  let wsUrl;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const p = list.find((t) => t.type === 'page');
      if (p) { wsUrl = p.webSocketDebuggerUrl; break; }
    } catch {}
    await sleep(300);
  }
  ws = new globalThis.WebSocket(wsUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
  await send('Page.enable'); await send('Runtime.enable');

  await send('Page.navigate', { url: `${BASE}/#/pages/login/index` });
  await sleep(7000);
  // 关开屏
  await ev(`(() => { const b = [...document.querySelectorAll('taro-view-core')].find(e => e.textContent.trim() === '点击进入'); if (b) b.click(); return !!b; })()`);
  await sleep(1200);

  const state = async () => ev(`(() => {
    const active = [...document.querySelectorAll('[class*=tabActive]')].map(e => e.textContent.trim()).join(',');
    const inputs = [...document.querySelectorAll('input')].map(i => i.placeholder || i.type).join('|');
    const err = (document.body.textContent.match(/请先勾选[^，。]{0,12}/) || [''])[0];
    return JSON.stringify({ active, inputs, err });
  })()`);

  console.log('初始:', await state());

  const clickReal = async (label) => {
    const xy = await ev(`(() => {
      const el = [...document.querySelectorAll('taro-view-core,taro-text-core')].find(x => x.textContent.trim() === ${JSON.stringify(label)} && x.children.length === 0);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return Math.round(r.left + r.width / 2) + ',' + Math.round(r.top + r.height / 2);
    })()`);
    if (!xy) { console.log(label, '找不到元素'); return false; }
    const [x, y] = xy.split(',').map(Number);
    // 完整鼠标序列：move → press → release（少 move 时某些实现不进 hover 态）
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(1200);
    return { x, y };
  };

  for (const label of ['邮箱登录', '密码登录', '注册', '手机号登录']) {
    const pos = await clickReal(label);
    console.log(`真实鼠标点「${label}」@${pos ? pos.x + ',' + pos.y : '未找到'} →`, await state());
  }

  // 对照：DOM click 同一元素
  await ev(`(() => { const el = [...document.querySelectorAll('taro-view-core,taro-text-core')].find(x => x.textContent.trim() === '邮箱登录' && x.children.length === 0); if (el) el.click(); })()`);
  await sleep(1000);
  console.log('DOM click「邮箱登录」→', await state());

  ws.close(); child.kill(); process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
