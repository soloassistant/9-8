#!/usr/bin/env node
/**
 * _e2e-signup-redeem.mjs —— 一次性端到端：注册 → 登录 → 会员中心兑换促销码 → 校验订单落库。
 *
 * 为什么必须单独写一个脚本（不能用 cdp-probe 分多次跑）：
 *   注册要「取验证码 → 等邮件 → 填码」，跨步骤必须**同一个浏览器会话**（验证码凭据活在
 *   SDK 内存里，重开浏览器即失效）。而 mail.tm 的 /messages 不返回 CORS 头，页面里 fetch 会被拦
 *   —— 所以收信只能在 Node 侧做，页面操作走 CDP，二者在同一进程里交替。
 *
 * 用法: node .tools/_e2e-signup-redeem.mjs <mailbox-token-file> <promoCode>
 * 凭据只从 /tmp 或系统临时目录读，绝不写进项目目录（发布目录会被整体上传）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME_BIN || 'C:\\Users\\geral\\.agent-browser\\browsers\\chrome-154.0.8037.92\\chrome.exe';
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8145';
const credFile = process.argv[2];
const PROMO = process.argv[3] || 'PRO-K5TT-QDKA';
const credRaw = fs.readFileSync(credFile, 'utf8');
const EMAIL = /wb\d+@maxxspace\.com/.exec(credRaw)?.[0];
const TOKEN = fs.readFileSync(path.join(path.dirname(credFile), 'tok.txt'), 'utf8').trim();

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- mailbox ---------------- */
async function waitForCode(maxMs = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const res = await fetch('https://api.mail.tm/messages', { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (res.ok) {
      const j = await res.json();
      for (const m of j['hydra:member'] || []) {
        const full = await fetch(`https://api.mail.tm/messages/${m.id}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
        if (!full.ok) continue;
        const msg = await full.json();
        const body = `${msg.text || ''}\n${(msg.html || []).join('')}`;
        const code = /(?<!\d)(\d{6})(?!\d)/.exec(body.replace(/<[^>]+>/g, ' '));
        if (code) return { code: code[1], subject: msg.subject };
      }
    }
    await sleep(3000);
  }
  return null;
}

/* ---------------- chrome ---------------- */
const port = 9500 + Math.floor(Math.random() * 200);
const udd = path.join(os.tmpdir(), `e2e-${Date.now()}`);
const child = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--no-proxy-server', '--hide-scrollbars',
  `--remote-debugging-port=${port}`, `--user-data-dir=${udd}`, '--window-size=1280,900',
  'about:blank'
], { stdio: 'ignore' });

async function cdp() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* 等 chrome 起 */ }
    await sleep(300);
  }
  throw new Error('chrome 未就绪');
}

let ws, msgId = 0;
const pending = new Map();
function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}
async function ev(expr, awaitPromise = true) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
  return r.result.value;
}
async function shot(file) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
}

const HELPERS = `
  window.__setInput = (el, v) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  window.__clickText = (txt) => {
    const els = [...document.querySelectorAll('taro-view-core, taro-text-core, div, span')];
    const hit = els.filter((e) => e.textContent.trim() === txt && e.children.length === 0)
      .sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height)[0];
    if (hit) { hit.click(); return true; }
    return false;
  };
`;

(async () => {
  const wsUrl = await cdp();
  ws = new globalThis.WebSocket(wsUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id).res(m.result); pending.delete(m.id); }
  };
  await send('Page.enable');
  await send('Runtime.enable');

  const out = { steps: [] };
  const step = (k, v) => { out.steps.push({ [k]: v }); log('  ·', k, '=', JSON.stringify(v)); };

  /* 1) 打开登录页 + 关开屏 */
  await send('Page.navigate', { url: `${BASE}/#/pages/login/index` });
  await sleep(7000);
  await ev(`(() => { const b = [...document.querySelectorAll('taro-view-core')].find(e => e.textContent.trim() === '点击进入'); if (b) b.click(); return !!b; })()`);
  await sleep(1500);
  await ev(HELPERS);
  step('splashDismissed', true);

  /* 2) 切邮箱页签 */
  const tab = await ev(`window.__clickText('邮箱登录')`);
  step('emailTab', tab);
  await sleep(1200);

  /* 2b) 切「验证码登录」子页签（密码页签下没有「获取验证码」） */
  const sub = await ev(`window.__clickText('验证码登录')`);
  step('otpTab', sub);
  await sleep(1200);

  /* 3) 勾隐私协议：方框在「我已阅读并同意」上方约 22px、左侧对齐；
     用文本锚点算坐标后发真实鼠标事件（DOM click 命不中这个 10px 的装饰方块）。 */
  const boxXY = await ev(`(() => {
    const t = [...document.querySelectorAll('taro-view-core, taro-text-core')].find(e => /我已阅读并同意/.test(e.textContent) && e.textContent.length < 40);
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { x: Math.round(r.left + 8), y: Math.round(r.top - 22) };
  })()`);
  if (boxXY) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: boxXY.x, y: boxXY.y, button: 'left', clickCount: 1 });
    }
  }
  step('consentClick', boxXY);
  await sleep(700);
  const consentOk = await ev(`!document.body.textContent.includes('请先勾选同意隐私说明')`);
  step('consentErrorMessageGone', consentOk);

  /* 4) 填邮箱 */
  const filled = await ev(`(() => {
    const inputs = [...document.querySelectorAll('input')];
    const mail = inputs.find(i => (i.placeholder || '').includes('邮箱') || i.type === 'email') || inputs[0];
    if (!mail) return 'no-input';
    window.__setInput(mail, ${JSON.stringify(EMAIL)});
    return mail.value;
  })()`);
  step('emailFilled', filled);

  /* 5) 获取验证码 */
  await sleep(400);
  const sent = await ev(`window.__clickText('获取验证码')`);
  step('codeRequested', sent);
  await shot('.tmp-verify/e2e-1-code.png');

  /* 6) 等邮件 */
  const mail = await waitForCode(120000);
  step('mail', mail ? { subject: mail.subject, codeLen: mail.code.length } : null);
  if (!mail) { console.log(JSON.stringify(out)); ws.close(); child.kill(); process.exit(1); }

  /* 7) 填码 + 提交 */
  await ev(`window.__setInput([...document.querySelectorAll('input')].find(i => (i.placeholder||'').includes('验证码')), ${JSON.stringify(mail.code)})`);
  await sleep(400);
  const submitted = await ev(`(() => {
    const btns = [...document.querySelectorAll('taro-button-core, button, taro-view-core')];
    const b = btns.find(e => /^(登录|登录 \\/ 注册|注册并登录|立即登录)$/.test(e.textContent.trim()) && e.getBoundingClientRect().width > 60);
    if (b) { b.click(); return b.textContent.trim(); }
    return 'no-button';
  })()`);
  step('submitted', submitted);
  await sleep(6000);
  await shot('.tmp-verify/e2e-2-after-login.png');

  const afterLogin = await ev(`(() => {
    const txt = document.body.textContent;
    return {
      hasSession: Object.keys(localStorage).some(k => /session|token|sb-|wb-/.test(k)),
      onLogin: location.hash.includes('login'),
      phoneBind: txt.includes('绑定手机') || txt.includes('稍后再说'),
      err: (txt.match(/[^*]{0,20}(失败|不正确|错误|超时)[^*]{0,30}/) || [''])[0].trim().slice(0, 60)
    };
  })()`);
  step('afterLogin', afterLogin);

  /* 8) 手机绑定弹窗 → 稍后再说 */
  if (afterLogin.phoneBind) {
    const skip = await ev(`window.__clickText('稍后再说')`);
    step('phoneBindSkipped', skip);
    await sleep(2500);
  }

  /* 9) 进会员中心兑换 */
  await send('Page.navigate', { url: `${BASE}/#/pages/membership/index` });
  await sleep(6000);
  await ev(HELPERS);
  await ev(`(() => { const b = [...document.querySelectorAll('taro-view-core')].find(e => e.textContent.trim() === '点击进入'); if (b) b.click(); })()`);
  await sleep(1500);

  const promoUi = await ev(`(() => {
    const txt = document.body.textContent;
    const hasPromo = txt.includes('促销码') || txt.includes('兑换');
    const btn = [...document.querySelectorAll('taro-view-core, taro-text-core')].find(e => /兑换|促销码/.test(e.textContent.trim()) && e.children.length === 0);
    if (btn) btn.click();
    return { hasPromo, clicked: !!btn };
  })()`);
  step('promoUi', promoUi);
  await sleep(1500);
  await shot('.tmp-verify/e2e-3-membership.png');

  const redeemed = await ev(`(() => {
    const inputs = [...document.querySelectorAll('input')];
    const box = inputs.find(i => (i.placeholder || '').includes('PRO') || (i.placeholder || '').includes('码'));
    if (!box) return 'no-input';
    window.__setInput(box, ${JSON.stringify(PROMO)});
    const btn = [...document.querySelectorAll('taro-button-core, button, taro-view-core')].find(e => /^(兑换|确定|提交)$/.test(e.textContent.trim()));
    if (btn) { btn.click(); return 'submitted'; }
    return 'filled-no-button';
  })()`);
  step('redeem', redeemed);
  await sleep(5000);
  await shot('.tmp-verify/e2e-4-redeemed.png');

  const result = await ev(`(() => {
    const txt = document.body.textContent;
    const m = txt.match(/订阅[^，。]{0,20}(至|到)\\s*(\\d{4}-\\d{2}-\\d{2})/);
    return { toastOrPage: (txt.match(/兑换成功[^。]{0,40}/) || [''])[0], expiry: m ? m[2] : null, hasSub: txt.includes('订阅记录') };
  })()`);
  step('result', result);

  /* 10) 会话 token（供 Node 侧核验订单表） */
  const token = await ev(`(() => {
    for (const k of Object.keys(localStorage)) {
      const v = localStorage.getItem(k);
      if (v && v.includes('access_token')) { try { const o = JSON.parse(v); const t = o.data?.session?.access_token || o.session?.access_token || o.access_token; if (t) return t; } catch {} }
    }
    return null;
  })()`);
  out.sessionToken = token ? `${token.slice(0, 12)}...` : null;
  if (token) fs.writeFileSync(path.join(os.tmpdir(), 'wb-e2e-session.txt'), token);

  /* 11) 跨设备恢复验证：清掉本地订阅凭证（等价换设备/清缓存），重进会员中心应自动回放订单 */
  await ev(`(() => { localStorage.removeItem('h5-subscription'); return true; })()`);
  const cleared = await ev(`localStorage.getItem('h5-subscription')`);
  step('localCleared', cleared === null);
  await send('Page.navigate', { url: `${BASE}/#/pages/membership/index` });
  await sleep(8000);
  await ev(`(() => { const b = [...document.querySelectorAll('taro-view-core')].find(e => e.textContent.trim() === '点击进入'); if (b) b.click(); })()`);
  await sleep(3000);
  const restored = await ev(`(() => {
    const raw = localStorage.getItem('h5-subscription');
    let exp = null;
    try { exp = JSON.parse(raw).data?.expiredAt || JSON.parse(raw).expiredAt || null; } catch {}
    const txt = document.body.textContent;
    const m = txt.match(/(\d{4}-\d{2}-\d{2})/);
    return { localExpiry: exp, pageShowsDate: m ? m[1] : null };
  })()`);
  step('restore', restored);
  out.restoreOk = !!restored.localExpiry;

  console.log('\nRESULT ' + JSON.stringify(out));
  ws.close();
  child.kill();
  process.exit(result.expiry ? 0 : 2);
})().catch((e) => { console.error('E2E ERR', e.message); process.exit(1); });
