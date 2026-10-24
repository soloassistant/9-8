/**
 * visual-pass.mjs —— 单 Chrome 多页面视觉巡检（复用 cdp-probe.mjs 的 CDP 逻辑）。
 * 一次启动拉起一个 headless Chrome，依次访问多个 Taro H5 页面，逐个截图并采集：
 *   - bodyOk / title / body 文本长度（判断是否白屏/空态）
 *   - console error / exception 数量（判断是否运行时报错）
 *   - 页面关键 section 计数（[class*=page] / [class*=section]）
 *
 * 登录态：默认注入 .tools/cdp-probe-session.js 桩绕过门禁看内页；
 *   传 --no-session 则不注入（用于看登录页本身）。
 *
 * 用法：node .tools/visual-pass.mjs [--no-session] login briefing inbox calendar mine library
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = process.argv.slice(2);
const noSession = args.includes('--no-session');
const pages = args.filter((a) => !a.startsWith('--'));
const ROOT = path.resolve(process.env.PROJECT_ROOT || path.join(__dirname, '..'));
const BASE = 'http://127.0.0.1:8137';
const OUT_DIR = path.join(ROOT, '.tmp-verify', 'visual-pass');
fs.mkdirSync(OUT_DIR, { recursive: true });

const CHROME =
  process.env.CHROME_BIN ||
  'C:\\Users\\geral\\.agent-browser\\browsers\\chrome-154.0.8037.92\\chrome.exe';

const sessionStub = noSession
  ? null
  : fs.readFileSync(path.join(ROOT, '.tools', 'cdp-probe-session.js'), 'utf8');

// 预置「已同意隐私协议」：legal.ts 的 CONSENT_KEY='privacy-consent'，版本号从该文件现读。
// Taro H5 storage 是 {data:...} 包装。不预置则每次全新 user-data-dir 都弹协议窗，
// 等它消失 + 点掉要多花 ~3s，会把「8s 自动收起的建议气泡」挤出截图窗口，验证不了遮挡问题。
// ⚠️ 2026-10-24：原先硬编码 'v1.5-20261013'，法务文本升版后预置即失效（同意层会挡住每张截图）。
// 与 verify-visual-patrol.mjs 同一做法：从源码读，避免版本号漂移。
const legalSrc = fs.readFileSync(path.join(ROOT, 'src', 'data', 'legal.ts'), 'utf8');
const legalVersion = (legalSrc.match(/LEGAL_VERSION = '([^']+)'/) || [])[1];
if (!legalVersion) throw new Error('读不到 LEGAL_VERSION（legal.ts 变了？）');
const consentSeed =
  `(function(){try{localStorage.setItem('privacy-consent',JSON.stringify({data:{agreed:true,version:'${legalVersion}',time:Date.now()}}))}catch(e){}})();`;
const initSource = consentSeed + (sessionStub ? '\n' + sessionStub : '');

const udd = path.join(os.tmpdir(), `visual-pass-${Date.now()}`);
const port = 9333 + Math.floor(Math.random() * 200);
const child = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--no-proxy-server',
  '--hide-scrollbars',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${udd}`,
  '--window-size=414,896',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const width = 414, height = 896;

async function endpoint() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return await r.json();
    } catch { /* not ready */ }
    await sleep(250);
  }
  throw new Error('CDP endpoint 未就绪');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.logs = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method) {
        if (m.method === 'Runtime.consoleAPICalled') {
          const t = m.params.type;
          if (t === 'error' || t === 'warning') {
            this.logs.push(`[${t}] ` + (m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 300));
          }
        } else if (m.method === 'Runtime.exceptionThrown') {
          const d = m.params.exceptionDetails || {};
          this.logs.push(`[EXCEPTION] ${d.text || ''} ${d.exception?.description || ''}`.slice(0, 400));
        }
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }
      }, 45000);
    });
  }
}

function cleanup(code) {
  try { child.kill('SIGKILL'); } catch {}
  try { fs.rmSync(udd, { recursive: true, force: true }); } catch {}
  process.exit(code);
}

(async () => {
  const ver = await endpoint();
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('ws 连接失败')), { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  if (initSource) {
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: initSource });
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });

  async function gotoHash(name) {
    const url = `${BASE}/#/pages/${name}/index`;
    await cdp.send('Page.navigate', { url });
  }

  const results = [];
  for (let i = 0; i < pages.length; i++) {
    const name = pages[i];
    if (i === 0) await gotoHash(name);
    else await cdp.send('Runtime.evaluate', { expression: `location.hash='#/pages/${name}/index'`, returnByValue: true });
    await sleep(i === 0 ? 9000 : 3500); // 首屏留足 9s，避免把"未加载完"误判白屏

    // 开屏 Splash 必须点掉，否则截图测到的是全屏遮罩
    const splash = await cdp.send('Runtime.evaluate', {
      expression: `(()=>{const s=document.querySelector('[class*="__splash__"]')||document.querySelector('[class*="splash"]');if(!s)return 'no-splash';s.click();return 'clicked'})()`,
      returnByValue: true,
    });
    if (splash.result?.value === 'clicked') await sleep(1200);

    // 首启「服务协议与隐私政策」弹窗：点「同意并继续」关掉，否则盖住整个页面
    const consent = await cdp.send('Runtime.evaluate', {
      expression: `(()=>{
        const all=[...document.querySelectorAll('*')];
        for(const el of all){
          if(el.children.length===0 && el.textContent && el.textContent.trim()==='同意并继续'){
            const t=el.closest('button')||el.closest('[class*="btn"]')||el;
            t.click(); return 'clicked';
          }
        }
        return 'not-found';
      })()`,
      returnByValue: true,
    });
    if (consent.result?.value === 'clicked') await sleep(1500);

    const probe = await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        href: location.href,
        title: document.title,
        bodyOk: !!document.body,
        bodyLen: document.body ? document.body.innerText.length : 0,
        pageEls: document.querySelectorAll('[class*="page"]').length,
        sectionEls: document.querySelectorAll('[class*="section"]').length,
        hasLoginForm: !!document.querySelector('[class*="login"]')
      })`,
      returnByValue: true,
    });
    let info = {};
    try { info = JSON.parse(probe.result?.value || '{}'); } catch {}

    const png = path.join(OUT_DIR, `${name}.png`);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(png, Buffer.from(shot.data, 'base64'));

    const errCount = cdp.logs.filter((l) => l.startsWith('[error]')).length;
    const excCount = cdp.logs.filter((l) => l.startsWith('[EXCEPTION]')).length;
    results.push({
      name,
      png,
      pngBytes: fs.statSync(png).size,
      ...info,
      consoleErrors: errCount,
      exceptions: excCount,
      recentLogs: cdp.logs.slice(-8),
    });
    cdp.logs = [];
  }

  console.log(JSON.stringify({ browser: ver.Browser, results }, null, 2));
  cleanup(0);
})().catch((err) => {
  console.log(JSON.stringify({ error: String(err && err.message ? err.message : err) }, null, 2));
  cleanup(1);
});
