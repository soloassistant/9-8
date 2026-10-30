#!/usr/bin/env node
/**
 * _e2e-internal-login.mjs —— 线上真实登录（内部号），验「登录后补引导」与绑手机口径
 *
 * 用法：
 *   node .tools/_e2e-internal-login.mjs                    # 复用内部号跑全流程
 *   SAVE_ACCOUNT=1 node .tools/_e2e-internal-login.mjs     # 新建一个内部号并把凭据落盘
 *   BINDONLY=1    node .tools/_e2e-internal-login.mjs      # 只验「必须绑手机」
 * 凭据默认读 `~/.workbuddy/secrets/chenbao-internal-account.json`（**仓库外**）。
 * 换公司内部号只需替换该文件里的 email / token，无需改代码。
 *
 * ⚠️ 不要接进 verify:all：它会登录生产账号、发真实邮件。
 *
 * 要证的事（用户的判断）：
 *   这台设备**已经看过**引导（localStorage 有 onboarded-v2），但换了一个
 *   **没有该账号引导记录**的账号登录 —— 登录后应该再弹一次。
 *   记录按账号落库后（onboarded-v2:<uid>），同一账号再进不应重复弹。
 *
 * 为什么必须这么做：verify-onboarding-* 那些门禁是桩会话 + 直接注入 localStorage，
 * 证的是"逻辑在该弹的时候弹了"；**登录这条路径本身**（真实会话产生 uid、uid 落库、
 * 下次进入读取）从没在真账号上跑过。
 *
 * 凭据只活在内存与系统临时目录，绝不写进项目目录（发布目录会被整体上传）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME_BIN || 'C:\\Users\\geral\\.agent-browser\\browsers\\chrome-154.0.8037.92\\chrome.exe';
const BASE = (process.env.E2E_BASE || 'https://48f86dcd48e3462dbe897b5fce534551.app.workbuddy.host').replace(/\/$/, '');
const ONB_TITLE = '三步，从混乱到清晰';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

/* ---------------- 临时邮箱 ---------------- */
// ⚠️ 用 curl 而不是 fetch：这台机器的 Node(undici) **不读 https_proxy**，
//    直连 api.mail.tm 会 ConnectTimeout；curl 走代理正常（实测 200 / 3.6s）。
import { execFileSync } from 'node:child_process';
const CURL = 'C:\\Windows\\System32\\curl.exe';
function curlJson(url, init) {
  const args = ['-sS', '-m', '25'];
  if (init && init.method) args.push('-X', init.method);
  if (init && init.body) args.push('-H', 'Content-Type: application/json', '--data-binary', init.body);
  if (init && init.token) args.push('-H', `Authorization: Bearer ${init.token}`);
  args.push(url);
  const out = execFileSync(CURL, args, { encoding: 'utf8', maxBuffer: 8 << 20 });
  return JSON.parse(out);
}

async function makeMailbox() {
  const domJson = curlJson('https://api.mail.tm/domains');
  const domain = domJson['hydra:member'][0].domain;
  const address = `wb${Date.now().toString(36)}${Math.floor(Math.random() * 900 + 100)}@${domain}`;
  const password = `Wb${Math.random().toString(36).slice(2, 10)}!9`;
  curlJson('https://api.mail.tm/accounts', {
    method: 'POST',
    body: JSON.stringify({ address, password })
  });
  const tokJson = curlJson('https://api.mail.tm/token', {
    method: 'POST',
    body: JSON.stringify({ address, password })
  });
  // password 必须一起返回并落盘：mail.tm 的 token 会过期，只有密码能重新换 token。
  // 第一版只存了 token —— 过期即失联，账号就废了。
  return { address, password, token: tokJson.token };
}

/** 用邮箱密码换一个新 token（token 过期时的唯一恢复路径） */
async function refreshToken(address, password) {
  const tokJson = curlJson('https://api.mail.tm/token', {
    method: 'POST',
    body: JSON.stringify({ address, password })
  });
  return tokJson.token;
}

/** 取当前邮件 id 集合 —— 请求新验证码前先拍快照，之后只认新到的邮件。
 *  不这么做的话，复用同一个内部号时会抓到上一次的旧验证码（已失效），
 *  表现为「码填了但一直停在登录页」，极容易误判成产品坏了。 */
async function listMessageIds(token) {
  try {
    const j = curlJson('https://api.mail.tm/messages', { token });
    return (j['hydra:member'] || []).map((m) => m.id);
  } catch {
    return [];
  }
}

async function waitForCode(token, excludeIds = [], maxMs = 150000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    try {
      const j = curlJson('https://api.mail.tm/messages', { token });
      for (const m of j['hydra:member'] || []) {
        if (excludeIds.includes(m.id)) continue; // 旧邮件，跳过
        const msg = curlJson(`https://api.mail.tm/messages/${m.id}`, { token });
        const body = `${msg.text || ''}\n${(msg.html || []).join('')}`.replace(/<[^>]+>/g, ' ');
        const code = /(?<!\d)(\d{6})(?!\d)/.exec(body);
        if (code) return code[1];
      }
    } catch { /* 单次失败继续等 */ }
    await sleep(3000);
  }
  return null;
}

/* ---------------- 浏览器 ---------------- */
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

const port = 9400 + Math.floor(Math.random() * 150);
const udd = path.join(os.tmpdir(), `onb-${Date.now()}`);
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--no-proxy-server', '--hide-scrollbars',
  `--remote-debugging-port=${port}`, `--user-data-dir=${udd}`, '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });

async function cdp() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* 等 chrome */ }
    await sleep(300);
  }
  throw new Error('chrome 未就绪');
}

let ws;
let msgId = 0;
const pending = new Map();
function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res) => pending.set(id, { res }));
}
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return 'ERR:' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

(async () => {
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok: ok === true, detail });
    log(`  ${ok === true ? 'PASS' : 'FAIL'}  ${name}${ok === true ? '' : '  → ' + detail}`);
  };

  // 账号来源：优先复用「内部号」（凭据存在仓库外，见 ACCOUNT_FILE），
  // 只有明确 SAVE_ACCOUNT=1 时才新建一个并落盘。
  // 为什么：每跑一次就注册一个新号，会在生产库里堆垃圾，也让结果不可复现。
  const ACCOUNT_FILE = process.env.ACCOUNT_FILE || 'C:\\Users\\geral\\.workbuddy\\secrets\\chenbao-internal-account.json';
  let mail;
  if (process.env.SAVE_ACCOUNT === '1') {
    mail = await makeMailbox();
    fs.mkdirSync(path.dirname(ACCOUNT_FILE), { recursive: true });
    fs.writeFileSync(
      ACCOUNT_FILE,
      JSON.stringify(
        { email: mail.address, mailboxPassword: mail.password, token: mail.token, createdAt: new Date().toISOString() },
        null,
        2
      ),
      { mode: 0o600 }
    );
    log('内部号已创建并落盘（凭据在仓库外）:', ACCOUNT_FILE);
  } else if (fs.existsSync(ACCOUNT_FILE)) {
    const saved = JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8'));
    // 每次都换一个新 token：mail.tm 的 token 有有效期，用旧的会突然 401。
    // 有密码就刷新；旧格式（只有 token）退化为直接用，失败会明确报错。
    let token = saved.token;
    if (saved.mailboxPassword) {
      try {
        token = await refreshToken(saved.email, saved.mailboxPassword);
      } catch (e) {
        log('⚠️ token 刷新失败，改用文件里的旧 token:', String(e && e.message || e).slice(0, 60));
      }
    }
    mail = { address: saved.email, token };
    log('复用内部号（不新建账号）');
  } else {
    mail = await makeMailbox();
    log('⚠️ 未找到内部号凭据，临时新建一个（建议先用 SAVE_ACCOUNT=1 建好内部号）');
  }
  log('临时邮箱已建（地址不打印）');

  const wsUrl = await cdp();
  ws = new globalThis.WebSocket(wsUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id).res(m.result); pending.delete(m.id); }
  };
  await send('Page.enable');
  await send('Runtime.enable');

  // 关键前置：让「这台设备已经看过引导」，但账号记录不存在
  // ⚠️ 隐私同意必须写成 {agreed:true, version:<当前 LEGAL_VERSION>}。
  //    第一版写成 {data:true}，hasAgreedConsent() 判 false → ConsentGate 一直盖着 →
  //    引导被 consentAgreed 条件挡掉，于是我得出了「补引导不生效」的**错误结论**。
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try{
      ${process.env.NODEV ? '' : "localStorage.setItem('onboarded-v2', JSON.stringify({data:true}));"}
      localStorage.setItem('privacy-consent', JSON.stringify({data:{agreed:true,version:'v1.8-20261026'}}));
      ${process.env.BINDONLY ? '' : "localStorage.setItem('sxm-phone-bind-done', JSON.stringify({data:true}));"}
    }catch(e){}`
  });
  // 关于 sxm-phone-bind-done：它表示「本机已绑过手机」。内部号没有真实号码可收短信，
  // 所以这里按「设备已绑定」预置，等价于老用户在这台机器上绑过 —— 只影响本地判定，
  // 不改服务端账号状态。BINDONLY 模式不预置，因为它要验的就是「弹窗必须出现」。

  await send('Page.navigate', { url: `${BASE}/#/pages/login/index` });
  await sleep(9000);
  await ev(`(() => { const b = [...document.querySelectorAll('taro-view-core')].find(e => e.textContent.trim() === '点击进入'); if (b) b.click(); return !!b; })()`);
  await sleep(1500);
  await ev(HELPERS);

  const preState = await ev(`JSON.stringify({
    deviceOnboarded: !!localStorage.getItem('onboarded-v2'),
    accountKeys: Object.keys(localStorage).filter((k) => k.indexOf('onboarded-v2:') === 0).length
  })`);
  const pre = JSON.parse(String(preState));

  // 登录：邮箱 → 验证码页签 → 勾协议 → 填邮箱 → 取码 → 提交
  await ev(`window.__clickText('邮箱登录')`);
  await sleep(1200);
  await ev(`window.__clickText('验证码登录')`);
  await sleep(1200);

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
  await sleep(600);

  const filled = await ev(`(() => {
    const inputs = [...document.querySelectorAll('input')];
    const m = inputs.find(i => (i.placeholder || '').includes('邮箱') || i.type === 'email') || inputs[0];
    if (!m) return 'no-input';
    window.__setInput(m, ${JSON.stringify(mail.address)});
    return m.value ? 'ok' : 'empty';
  })()`);
  await sleep(400);
  // 发码前拍快照：复用内部号时邮箱里必然还躺着上一次的验证码，只认新到的
  const beforeIds = await listMessageIds(mail.token);
  const sent = await ev(`window.__clickText('获取验证码')`);
  check('L1 能在线上发出验证码（真实邮箱）', filled === 'ok' && sent === true, `fill=${filled} send=${sent}`);

  const code = await waitForCode(mail.token, beforeIds);
  check('L2 收到真实验证码邮件', !!code, code ? 'len=6' : '150s 内未收到');
  if (!code) { ws.close(); child.kill(); process.exit(1); }

  await ev(`window.__setInput([...document.querySelectorAll('input')].find(i => (i.placeholder||'').includes('验证码')), ${JSON.stringify(code)})`);
  await sleep(400);
  // 提交：登录页的主按钮是 styles.submit，**文案不是「登录」**（按文本找必然找不到，
  // 我上一版就是这么失败的）。按 class 定位，CSS Module 编译后形如 `index-module__submit___xxx`。
  const submitted = await ev(`(() => {
    const hit = [...document.querySelectorAll('[class*="__submit"]')]
      .find((e) => e.getBoundingClientRect().width > 100);
    if (hit) { hit.click(); return hit.className.slice(0, 30); }
    const btns = [...document.querySelectorAll('taro-button-core, button')]
      .filter((e) => e.getBoundingClientRect().width > 100);
    if (btns.length) { btns[btns.length - 1].click(); return 'fallback:' + btns[btns.length - 1].textContent.trim().slice(0, 10); }
    return 'no-button';
  })()`);
  log('  提交按钮:', submitted);
  await sleep(8000);
  await ev(`window.__clickText('稍后再说')`); // 绑手机弹窗
  await sleep(3000);

  const loggedIn = await ev(`(() => ({
    onLogin: location.hash.includes('login'),
    hasAccountKey: Object.keys(localStorage).some((k) => k.indexOf('onboarded-v2:') === 0)
  }))()`);
  if (loggedIn.onLogin === true) {
    const diag = await ev(`(() => {
      const inputs = [...document.querySelectorAll('input')].map((i) => ({ ph: (i.placeholder || '').slice(0, 10), len: (i.value || '').length }));
      // ⚠️ 别用 textContent：它把 <script> 里的源码也算进来（上次诊断就被骨架 JS 注释刷屏）
      const btns = [...document.querySelectorAll('taro-button-core, button, taro-view-core')]
        .filter((e) => e.getBoundingClientRect().width > 40)
        .map((e) => e.textContent.trim().slice(0, 12))
        .filter((t) => t && t.length < 14)
        .slice(0, 14);
      return JSON.stringify({ inputs, btns, text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 200) });
    })()`);
    log('  诊断（仍在登录页）:', diag);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(process.cwd(), '.tmp-verify/onb-login-stuck.png'), Buffer.from(shot.data, 'base64'));
  }
  check('L3 真实登录成功（已离开登录页）', loggedIn.onLogin === false, JSON.stringify(loggedIn));

  // 会话形状诊断：只打印**键名**与类型，不打印任何值（凭据/邮箱/uid 都不落日志）
  const shape = await ev(`(() => {
    const out = {};
    Object.keys(localStorage).forEach((k) => {
      if (!/session|auth|wb|sb-/i.test(k)) return;
      let v = localStorage.getItem(k);
      let parsed = null;
      try { parsed = JSON.parse(v); } catch (e) { parsed = null; }
      const path = [];
      let cur = parsed;
      for (let i = 0; i < 3 && cur && typeof cur === 'object'; i++) {
        path.push(Object.keys(cur).slice(0, 8).join(','));
        cur = cur.data || cur.session || cur.user || null;
      }
      out[k.slice(0, 24)] = { type: typeof parsed, layers: path };
    });
    return JSON.stringify(out).slice(0, 700);
  })()`);
  log('  会话形状:', shape);

  // 直接问 SDK：那一刻它到底给不给 session（这决定 onboarded 走账号级还是设备级）
  const sdkView = await ev(`(async () => {
    const g = window.WorkBuddyCloud;
    if (!g) return JSON.stringify({ sdk: false });
    try {
      const c = g.createWorkBuddyCloud({
        endpoint: location.origin,
        publishableKey: ${JSON.stringify(process.env.WB_PK || '')}
      });
      const r = await c.auth.getSession();
      return JSON.stringify({
        sdk: true,
        hasData: !!r && !!r.data,
        hasUserId: !!(r && r.data && r.data.user && r.data.user.id),
        errorKind: (r && r.error && (r.error.kind || r.error.message)) || null
      });
    } catch (e) {
      return JSON.stringify({ sdk: true, threw: String(e && e.message || e).slice(0, 80) });
    }
  })()`);
  log('  SDK 视角:', sdkView);

  // 绑手机弹窗：本轮的强制口径验证（只在 BINDONLY 时用它收尾）
  const bindDlg = JSON.parse(String(await ev(`(() => {
    const t = (document.body.innerText || '').replace(/\\s+/g, ' ');
    return JSON.stringify({
      hasDialog: /绑定手机|验证码已发送|手机号/.test(t),
      hasSkip: t.includes('稍后再说'),
      snippet: t.slice(0, 90)
    });
  })()`)));
  if (process.env.BINDONLY) {
    check('B1 邮箱登录后弹出绑手机（强制口径生效）', bindDlg.hasDialog === true, bindDlg.snippet);
    check('B2 弹窗里**没有**「稍后再说」（不再是常驻逃生口）', bindDlg.hasSkip === false, bindDlg.snippet);
    const pass1 = results.filter((r) => r.ok).length;
    log(`\n绑定口径核查：PASS ${pass1} / FAIL ${results.length - pass1}（共 ${results.length} 条）`);
    ws.close();
    child.kill();
    process.exit(pass1 === results.length ? 0 : 1);
  }

  // ⚠️ 登录后开屏会**再出现一次**（z-index 9999 的「点击进入」），而引导的渲染条件是
  //    `consentAgreed && shellReady && !onboarded` —— shellReady 要等开屏退场才置 true。
  //    不关它，引导永远被挡在后面；我前几轮就是在这里判成「补引导不生效」的，**是测试漏了这一步**。
  for (let i = 0; i < 6; i++) {
    const gone = await ev(`(() => {
      // 直接点开屏容器（按 class），不靠文案 —— 文案节点可能是 taro-text-core，
      // 点它不一定触发容器的 onClick。仍然不消失就发真实鼠标事件兜底。
      const el = document.querySelector('[class*="__splash"]');
      if (!el) return true;
      el.click();
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    if (gone === true) break;
    if (gone && typeof gone === 'object' && gone.x) {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: gone.x, y: gone.y, button: 'left', clickCount: 1 });
      }
    }
    await sleep(1200);
  }
  await sleep(2500);

  // 核心断言：设备看过、账号没记录 → 登录后必须补一次引导
  await sleep(2000);
  const onbShown = await ev(`document.body.textContent.includes(${JSON.stringify(ONB_TITLE)})`);
  if (onbShown !== true) {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(process.cwd(), '.tmp-verify/onb-after-login.png'), Buffer.from(shot.data, 'base64'));
    const layers = await ev(`(() => {
      const cls = (sel) => [...document.querySelectorAll(sel)].map((e) => String(e.className).slice(0, 34)).slice(0, 3);
      return JSON.stringify({
        text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 160),
        masks: cls('[class*="mask"]'),
        consent: cls('[class*="consent"]'),
        onb: cls('[class*="panel"]')
      });
    })()`);
    log('  层级诊断:', layers);
    const overlays = await ev(`(() => {
      const out = [];
      document.querySelectorAll('*').forEach((el) => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const z = Number(cs.zIndex) || 0;
        if (cs.position === 'fixed' && z > 50 && r.width > 200 && r.height > 200) {
          out.push({ cls: String(el.className).slice(0, 30), z, size: Math.round(r.width) + 'x' + Math.round(r.height), t: (el.innerText || '').replace(/\\s+/g, ' ').slice(0, 30) });
        }
      });
      return JSON.stringify(out.slice(0, 6));
    })()`);
    log('  固定覆盖层:', overlays);
  }
  check('L4 登录后补引导真的弹出（设备已看过、账号无记录）', onbShown === true, `pre=${JSON.stringify(pre)}`);

  // L4b：如果登录那一刻没弹，刷新同一会话再看 —— 用来区分
  //   「会话未就绪导致这一次判定退化」和「整个功能没接上」。
  if (onbShown !== true) {
    await send('Page.navigate', { url: `${BASE}/#/pages/briefing/index` });
    await sleep(13000);
    const afterReload = await ev(`document.body.textContent.includes(${JSON.stringify(ONB_TITLE)})`);
    const keys = await ev(`JSON.stringify(Object.keys(localStorage).filter((k) => k.indexOf('onboarded') === 0))`);
    log(`  L4b 同一会话刷新后是否弹: ${afterReload}；本地键: ${keys}`);
  }

  if (onbShown === true) {
    await ev(`window.__clickText('跳过')`);
    await sleep(1500);
    const marked = await ev(`Object.keys(localStorage).filter((k) => k.indexOf('onboarded-v2:') === 0)`);
    check('L5 跳过时按账号落库（onboarded-v2:<uid>）', Array.isArray(marked) && marked.length === 1, JSON.stringify(marked));

    // 同一账号再进：不应重复弹
    await send('Page.navigate', { url: `${BASE}/#/pages/briefing/index` });
    await sleep(12000);
    const again = await ev(`document.body.textContent.includes(${JSON.stringify(ONB_TITLE)})`);
    check('L6 同一账号再次进入不重复弹', again === false, `again=${again}`);
  }

  const pass = results.filter((r) => r.ok).length;
  log(`\n线上「登录后补引导」E2E：PASS ${pass} / FAIL ${results.length - pass}（共 ${results.length} 条）`);
  ws.close();
  child.kill();
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => {
  console.error('harness 出错:', e);
  process.exit(2);
});
