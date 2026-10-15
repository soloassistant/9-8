#!/usr/bin/env node
/**
 * reg-full.mjs — 真实 Chrome 端到端回归（一次性会话内完成所有多步交互）。
 * 流程：邮箱登录(OTP 回贴) → 强制绑手机弹窗「短信失败→稍后再说」跳过 →
 *       P0 同意层拦截 Tab/FAB 测试 → 点「同意并继续」 → P1 五 Tab FAB 遮挡 + 桌面定位 → P2。
 * 关键状态写入 OUT/status.txt：OTP_REQUESTED（此时把邮箱收到的码写进 REG_OTP_FILE）→ LOGGED_IN → DONE / FAIL:...
 *
 * 环境变量：
 *   REG_URL       站点根（默认线上）
 *   REG_EMAIL     登录邮箱（必填，无默认值 —— 本仓库是 public，不把个人邮箱硬编码进来）
 *   REG_OTP_FILE  回贴验证码文件（脚本轮询；默认 OUT/otp.txt）
 *   REG_OUT       输出目录（默认 <repo>/.tmp-verify/reg，Windows 风格绝对路径）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME_BIN || 'C:\\Users\\geral\\.agent-browser\\browsers\\chrome-154.0.8037.92\\chrome.exe';
const BASE = process.env.REG_URL || 'https://48f86dcd48e3462dbe897b5fce534551.app.workbuddy.host/';
const EMAIL = process.env.REG_EMAIL || '';
if (!EMAIL) { console.error('REG_EMAIL is required (no default: this repo is public)'); process.exit(2); }
// 输出目录默认**必须由 __dirname 推导**：曾写成 Git-Bash 风格 '/d/Agent/.tmp-verify/reg'，
// path.join 在 Windows 上会把它变成当前盘根下的相对路径 '\d\Agent\...' → Chrome 的
// --user-data-dir 建不出来 → 进程静默死亡 → CDP endpoint 永远连不上（表现为
// 「CDP endpoint 未就绪」，极易误判成 Chrome/网络问题）。2026-10-15 实测踩到。
const OUT = process.env.REG_OUT || path.join(__dirname, '..', '.tmp-verify', 'reg');
const OTP_FILE = process.env.REG_OTP_FILE || path.join(OUT, 'otp.txt');
fs.mkdirSync(OUT, { recursive: true });
if (fs.existsSync(OTP_FILE)) fs.unlinkSync(OTP_FILE); // 清掉上一次的码

const LOG = [];
function log(...a) { const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); LOG.push(s); console.log(s); }
function setStatus(s) { fs.writeFileSync(path.join(OUT, 'status.txt'), s); log('STATUS', s); }
function fail(msg) { setStatus('FAIL: ' + msg); fs.writeFileSync(path.join(OUT, 'log.txt'), LOG.join('\n')); try { child.kill('SIGKILL'); } catch {} process.exit(1); }

const proxyUrl = process.env.CDP_PROXY || process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY || '';
const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(BASE);
const profileDir = path.join(OUT, 'profile');
const port = 9500 + Math.floor(Math.random() * 200);
const child = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  ...(isLocal ? ['--no-proxy-server'] : proxyUrl ? [`--proxy-server=${proxyUrl}`] : []),
  '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`,
  '--window-size=390,844', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function endpoint() { for (let i = 0; i < 60; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return await r.json(); } catch {} await sleep(250); } throw new Error('CDP endpoint 未就绪'); }

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } }); }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 45000); }); }
}

let cdp;
async function evalJs(expr) { const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return { __err: r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || '') }; return r.result?.value; }
async function realClick(x, y) { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }); await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }); }
async function findText(text, exact, yMinRatio) {
  return evalJs(`(() => { const t=${JSON.stringify(text)}; const exact=${exact ? 'true' : 'false'}; const yMin=${(yMinRatio || 0)}*window.innerHeight; let best=null;
    for(const e of Array.from(document.querySelectorAll('body *'))){ const txt=(e.textContent||'').trim(); if(!txt) continue; const m=exact?txt===t:(txt.includes(t)&&txt.length<t.length+14); if(!m) continue; const r=e.getBoundingClientRect(); if(r.width<6||r.height<6) continue; if(r.top<yMin) continue; const a=r.width*r.height; if(!best||a<best.a) best={a,x:r.left+r.width/2,y:r.top+r.height/2,txt}; }
    return best?{x:best.x,y:best.y,txt:best.txt}:null; })()`);
}
async function clickText(text, exact, yMinRatio) { const p = await findText(text, exact, yMinRatio); if (!p || p.__err) { log('clickText NOT FOUND', text); return false; } await realClick(p.x, p.y); log('clicked', JSON.stringify(text), '->', JSON.stringify(p.txt)); return true; }
async function fillInput(idx, value) { return evalJs(`(() => { const ins=document.querySelectorAll('input'); const el=ins[${idx}]; if(!el) return 'no-input@'+${idx}; const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; setter.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return 'ok:'+el.value; })()`); }
async function shot(name) { try { const s = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); const p = path.join(OUT, name); fs.writeFileSync(p, Buffer.from(s.data, 'base64')); log('shot', name, fs.statSync(p).size); } catch (e) { log('shot FAIL', name, String(e.message)); } }
async function dismissSplash() { const s = await evalJs(`(()=>{const e=document.querySelector('[class*="splash"],[class*="Splash"]'); if(!e) return null; const r=e.getBoundingClientRect(); if(r.width<10) return null; return {x:r.left+r.width/2,y:r.top+r.height/2};})()`); if (s && !s.__err && s && s.x !== undefined) { await realClick(s.x, s.y); await sleep(1600); log('splash dismissed'); } else log('no splash'); }
async function hash() { return await evalJs('location.hash'); }

// P1: 找到 AiAssistant 里最小的 fixed 元素（FAB 按钮），返回其 rect + 与之相交的文字叶子
async function fabOverlap() {
  return evalJs(`(() => {
    const root=document.querySelector('[class*="AiAssistant"]'); if(!root) return {fab:null,hits:[]};
    let best=null;
    for(const e of [root,...root.querySelectorAll('*')]){ const cs=getComputedStyle(e); if(cs.position!=='fixed'&&cs.position!=='absolute') continue; const r=e.getBoundingClientRect(); if(r.width<20||r.width>220||r.height<20||r.height>220) continue; const a=r.width*r.height; if(!best||a<best.a) best={a,x:r.left,y:r.top,w:r.width,h:r.height}; }
    if(!best) return {fab:null,hits:[]};
    const fr={x:best.x,y:best.y,w:best.w,h:best.h}; const hits=[];
    for(const e of Array.from(document.querySelectorAll('body *'))){ if(e.closest('[class*="AiAssistant"]')) continue; if(e.children.length) continue; const t=(e.textContent||'').trim(); if(!t) continue; const r=e.getBoundingClientRect(); if(r.width<2||r.height<2) continue; if(r.right>fr.x+2 && r.left<fr.x+fr.w-2 && r.bottom>fr.y+2 && r.top<fr.y+fr.h-2){ hits.push(t.slice(0,28)); } }
    return {fab:fr, hits:[...new Set(hits)].slice(0,12)};
  })()`);
}

const RESULTS = { login: {}, p0: {}, p1: {}, p2: {} };

// 读取登录页当前可见的错误/提示文字（React 渲染到 .error / .notice）
async function readErrorText() {
  return evalJs(`(() => {
    const out = [];
    for (const e of Array.from(document.querySelectorAll('body *'))) {
      const cls = (e.className || '').toString();
      const txt = (e.textContent || '').trim();
      if ((cls.includes('error') || cls.includes('notice') || cls.includes('hint')) && txt && txt.length < 120) out.push(txt);
    }
    return [...new Set(out)].join(' | ') || '(no error/notice text)';
  })()`);
}
// 回读两个登录输入框的真实 DOM 值，确认代码真的填进去了
async function loginInputValues() {
  return evalJs(`Array.from(document.querySelectorAll('input')).slice(0,4).map(i => i.value)`);
}

(async () => {
  try {
    await endpoint();
    const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json();
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws fail')), { once: true }); });
    cdp = new Cdp(ws);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await cdp.send('Page.navigate', { url: BASE });
    // 轮询直到 hash 路由就绪（避免偶发 7s 白屏导致后续点击全 miss）
    let loaded = false;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      const h = await hash();
      if (String(h || '').includes('login')) { loaded = true; break; }
    }
    if (!loaded) await sleep(3000);
    RESULTS.login.landedHash = await hash();
    log('landed', RESULTS.login.landedHash);
    await dismissSplash();
    await shot('00-after-nav.png');

    // 1) 隐私勾选
    const boxBefore = await evalJs(`(()=>{const e=Array.from(document.querySelectorAll('body *')).find(e=>(e.textContent||'').trim()==='☑'); return !!e;})()`);
    if (!boxBefore) { await clickText('我已阅读并同意', false); await sleep(600); }
    RESULTS.login.privacyChecked = await evalJs(`(()=>{const e=Array.from(document.querySelectorAll('body *')).find(e=>(e.textContent||'').trim()==='☑'); return !!e;})()`);
    log('privacyChecked', RESULTS.login.privacyChecked);

    // 2) 邮箱通道 → 切 OTP 模式（邮箱默认是「邮箱+密码」，需再点「验证码登录」才是邮件 OTP）→ 填邮箱 → 获取验证码
    await clickText('邮箱登录', false); await sleep(1200);
    await clickText('验证码登录', false); await sleep(1000);
    RESULTS.login.emailInputs = await evalJs(`Array.from(document.querySelectorAll('input')).map(i=>i.placeholder)`);
    log('email inputs', RESULTS.login.emailInputs);
    await fillInput(0, EMAIL); await sleep(400);
    const sent = await clickText('获取验证码', false);
    if (!sent) fail('未找到「获取验证码」按钮（邮箱 OTP 模式未就绪）inputs=' + JSON.stringify(RESULTS.login.emailInputs));
    setStatus('OTP_REQUESTED');
    await shot('01-otp-requested.png');
    log('>>> OTP requested for', EMAIL, '; write code to', OTP_FILE);

    // 3) OTP 回贴 + 提交（带自动重试，最多 3 次：过期/错码/限流都不再整轮报废）
    const MAX_OTP = 3;
    let loggedIn = false;
    for (let attempt = 1; attempt <= MAX_OTP && !loggedIn; attempt++) {
      if (attempt > 1) {
        log('--- OTP retry #' + attempt + ' ---');
        const tStart = Date.now();
        while (Date.now() - tStart < 75000) {
          const can = await evalJs(`(() => { const el=[...document.querySelectorAll('body *')].find(e=>(e.textContent||'').trim()==='获取验证码'); if(!el) return false; const p=el.closest('[class*="codeBtn"]'); return !p||!p.className.includes('btnDisabled'); })()`);
          if (can) break;
          await sleep(2000);
        }
        await clickText('获取验证码', true);
        await sleep(1500);
      }
      setStatus('OTP_REQUESTED');
      await shot(`01-otp-requested-a${attempt}.png`);
      log('>>> OTP requested (attempt ' + attempt + ') for ' + EMAIL + ' ; write code to ' + OTP_FILE);

      let code = ''; const t0 = Date.now();
      while (Date.now() - t0 < 1800000) { try { if (fs.existsSync(OTP_FILE)) { const c = fs.readFileSync(OTP_FILE, 'utf8').trim(); if (c) { code = c; break; } } } catch {} await sleep(2000); }
      if (!code) fail('OTP_TIMEOUT');
      log('OTP received', code, '(attempt ' + attempt + ')');
      await fillInput(1, code); await sleep(500);
      const vals = await loginInputValues();
      log('inputs after fill', JSON.stringify(vals));
      await clickText('登录', true);
      await sleep(7000);
      RESULTS.login['afterSubmitHash_a' + attempt] = await hash();
      RESULTS.login['error_a' + attempt] = await readErrorText();
      log('after submit hash', RESULTS.login['afterSubmitHash_a' + attempt], '| err:', RESULTS.login['error_a' + attempt]);
      await shot(`02-after-login-a${attempt}.png`);

      const h = await hash();
      // 邮箱登录成功后会强弹「绑定手机号」，hash 仍停在 login 页；不能只看 hash
      const bindNow = await findText('绑定手机号', false);
      const bindPhonePresent = !!(bindNow && !bindNow.__err);
      RESULTS.login['bindPhone_a' + attempt] = bindPhonePresent;
      if (String(h || '').includes('briefing') || bindPhonePresent) { loggedIn = true; RESULTS.login.otpAttempts = attempt; }
      else {
        log('login FAILED attempt ' + attempt + ', error=', RESULTS.login['error_a' + attempt]);
        try { if (fs.existsSync(OTP_FILE)) fs.unlinkSync(OTP_FILE); } catch {}
        if (attempt < MAX_OTP) log('re-requesting OTP...');
      }
    }
    if (!loggedIn) fail('OTP 登录连续 ' + MAX_OTP + ' 次失败，最终 hash=' + RESULTS.login.afterSubmitHash_a3);


    // 4) 强制绑手机弹窗 → 短信失败 → 稍后再说
    const bindHit = (await findText('稍后再说', false)) || (await findText('绑定手机', false));
    RESULTS.login.bindModal = !!(bindHit && !bindHit.__err);
    log('bind modal present', RESULTS.login.bindModal);
    if (RESULTS.login.bindModal) {
      const nInputs = await evalJs(`document.querySelectorAll('input').length`);
      log('input count with modal', nInputs);
      await fillInput(Number(nInputs) - 2, '13800138000'); await sleep(400); // 弹窗里的手机号输入（登录页 2 个在前）
      await clickText('获取验证码', false); await sleep(5000); // SMS 未开 → 发码失败 → 露出「稍后再说」
      const skip = await findText('稍后再说', false);
      if (skip && !skip.__err) { await realClick(skip.x, skip.y); log('clicked 稍后再说'); } else log('稍后再说 NOT FOUND after failed send');
      await sleep(3500);
    }
    RESULTS.login.finalHash = await hash();
    log('final hash', RESULTS.login.finalHash);
    await shot('03-logged-in.png');
    if (!String(RESULTS.login.finalHash || '').includes('briefing')) { fail('未进入晨报页 finalHash=' + RESULTS.login.finalHash); }
    setStatus('LOGGED_IN');

    // ===== P0：同意层拦截（未同意时）=====
    const consentHit = await findText('同意并继续', false);
    RESULTS.p0.consentPresent = !!(consentHit && !consentHit.__err);
    log('P0 consent gate present', RESULTS.p0.consentPresent);
    const fabHiddenPre = await evalJs(`!!document.querySelector('[class*="AiAssistant"]')`);
    RESULTS.p0.fabMountedPreConsent = fabHiddenPre;
    // 尝试点 Tab（应被遮罩拦截）
    await clickText('收件箱', false, 0.6); await sleep(2500);
    RESULTS.p0.hashAfterTabClickUnderConsent = await hash();
    const consentStill = await findText('同意并继续', false);
    RESULTS.p0.consentStillAfterTab = !!(consentStill && !consentStill.__err);
    log('P0 blocked?', RESULTS.p0.hashAfterTabClickUnderConsent, 'consentStill', RESULTS.p0.consentStillAfterTab);
    await shot('p0-under-consent.png');
    // 同意
    if (consentHit && !consentHit.__err) { await realClick(consentHit.x, consentHit.y); log('clicked 同意并继续'); await sleep(2500); }
    RESULTS.p0.consentGoneAfterAgree = !(await findText('同意并继续', false));
    log('P0 consent gone after agree', RESULTS.p0.consentGoneAfterAgree);
    await dismissSplash();
    await shot('p0-after-agree.png');

    // ===== P1：五 Tab FAB 遮挡（移动 390）=====
    const tabs = [['晨报', 'briefing'], ['收件箱', 'inbox'], ['热点', 'library'], ['日历', 'calendar'], ['我的', 'mine']];
    RESULTS.p1.mobile = {};
    for (const [label, frag] of tabs) {
      await clickText(label, false, 0.6); await sleep(2600);
      const h = await hash();
      const ov = await fabOverlap();
      RESULTS.p1.mobile[label] = { hash: h, navOk: String(h || '').includes(frag), fab: ov.fab, hits: ov.hits };
      await shot(`p1-m-${frag}.png`);
      log('P1 mobile', label, JSON.stringify({ navOk: RESULTS.p1.mobile[label].navOk, fab: ov.fab, hits: ov.hits }));
    }

    // ===== P1：桌面 1280 FAB 定位 =====
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(1500);
    await clickText('晨报', false, 0.6); await sleep(2600);
    const desk = await evalJs(`(() => {
      const ov = (function(){ const root=document.querySelector('[class*="AiAssistant"]'); if(!root) return null; let best=null; for(const e of [root,...root.querySelectorAll('*')]){ const cs=getComputedStyle(e); if(cs.position!=='fixed'&&cs.position!=='absolute') continue; const r=e.getBoundingClientRect(); if(r.width<20||r.width>220||r.height<20||r.height>220) continue; const a=r.width*r.height; if(!best||a<best.a) best={x:r.left,y:r.top,w:r.width,h:r.height}; } return best?{x:best.x,y:best.y,w:best.w,h:best.h}:null; })();
      // 内容栏：找最宽的居中主容器（taro page）
      let col=null; const pages=document.querySelectorAll('[class*="page_"], [class*="__page"], #app > div'); for(const p of pages){ const r=p.getBoundingClientRect(); if(r.width>200 && r.width<760){ if(!col || r.width>col.w) col={x:r.left,y:r.top,w:r.width,h:r.height}; } }
      return { fab: ov, contentCol: col };
    })()`);
    RESULTS.p1.desktop = desk;
    await shot('p1-desktop-1280.png');
    log('P1 desktop', JSON.stringify(desk));

    // ===== P2 =====
    RESULTS.p2 = await evalJs(`JSON.stringify({ faviconLink: !!document.querySelector('link[rel~="icon" i]'), appleIcon: !!document.querySelector('link[rel="apple-touch-icon"]'), mobileWebAppCapable: !!document.querySelector('meta[name="mobile-web-app-capable"]'), appleMobileWebAppCapable: !!document.querySelector('meta[name="apple-mobile-web-app-capable"]') })`);
    try { RESULTS.p2 = JSON.parse(RESULTS.p2); } catch {}
    log('P2', JSON.stringify(RESULTS.p2));

    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(RESULTS, null, 2));
    fs.writeFileSync(path.join(OUT, 'log.txt'), LOG.join('\n'));
    setStatus('DONE');
    try { child.kill('SIGKILL'); } catch {}
    process.exit(0);
  } catch (err) {
    log('FATAL', String(err && err.stack || err));
    fail(String(err && err.message || err));
  }
})();
