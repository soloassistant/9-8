/**
 * cdp-probe.mjs —— 直接用本机已安装的 Chrome（CDP）做页面探针。
 *
 * 为什么不用 agent-browser：它在长会话/首次启动时经常挂住（SIGTERM 无输出）。
 * 这里自己拉起一个独立 user-data-dir 的 headless Chrome，用完即关，互不干扰。
 *
 * 用法:
 *   node .tools/cdp-probe.mjs <url> <width> <height> [--expr "<js>"] [--png <out.png>] [--wait <ms>]
 *
 * 输出: 一行 JSON（--expr 的求值结果），出错时非 0 退出。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** --logs：把页面控制台输出与未捕获异常一并带回（排查"为什么重定向/为什么空白"必需） */
const CHROME =
  process.env.CHROME_BIN ||
  'C:\\Users\\geral\\.agent-browser\\browsers\\chrome-154.0.8037.92\\chrome.exe';

const args = process.argv.slice(2);
const url = args[0];
const width = Number(args[1] || 1280);
const height = Number(args[2] || 720);
const exprIdx = args.indexOf('--expr');
const expr = exprIdx >= 0 ? args[exprIdx + 1] : null;
const pngIdx = args.indexOf('--png');
const png = pngIdx >= 0 ? args[pngIdx + 1] : null;
const waitIdx = args.indexOf('--wait');
const waitMs = waitIdx >= 0 ? Number(args[waitIdx + 1]) : 2500;
/** --init-script <file>：在页面脚本之前注入（用于伪造登录态、埋点等测试态） */
const initIdx = args.indexOf('--init-script');
const initScript = initIdx >= 0 ? fs.readFileSync(args[initIdx + 1], 'utf8') : null;
const port = Number(process.env.CDP_PORT || 9333 + Math.floor(Math.random() * 200));
const withLogs = args.includes('--logs');
/** --block-url <pattern>...：屏蔽指定请求（如外部 CDN，避免它覆盖测试桩）。
 *  只取到下一个 `--` 开头的参数为止，避免把后面的 --expr 一起吞掉。 */
const blockIdx = args.indexOf('--block-url');
const blockUrls = [];
if (blockIdx >= 0) {
  for (let i = blockIdx + 1; i < args.length && !args[i].startsWith('--'); i++) blockUrls.push(args[i]);
}
/** --dismiss-splash：点掉开屏封面再截图。
 *  ⚠️ 本应用的开屏**不会自动关闭，必须点击**（见 src/components/Splash）。
 *  不点它，截图与像素统计测到的是全屏开屏遮罩而不是页面 ——
 *  后果极具欺骗性：不同视口/档位截出的图**字节完全相同**，而"近白占比"看起来很"正常"。
 *  几何量测（getBoundingClientRect）不受影响，所以只有像素类判据会被它骗。 */
const dismissSplash = args.includes('--dismiss-splash');

const udd = path.join(os.tmpdir(), `cdp-probe-${Date.now()}`);
const child = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--no-proxy-server', // 本地探测必须绕开代理，否则 localhost 也会被 CONNECT 掉
    '--hide-scrollbars',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${udd}`,
    `--window-size=${width},${height}`,
    'about:blank',
  ],
  { stdio: 'ignore' }
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function endpoint() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return await r.json();
    } catch {
      /* not ready */
    }
    await sleep(250);
  }
  throw new Error('CDP endpoint 未就绪（chrome 没能起来？）');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.logs = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
        if (msg.method === 'Runtime.consoleAPICalled') {
          this.logs.push(
            `[${msg.params.type}] ` +
              (msg.params.args || [])
                .map((a) => a.value ?? a.description ?? a.type)
                .join(' ')
                .slice(0, 300)
          );
        } else if (msg.method === 'Runtime.exceptionThrown') {
          const d = msg.params.exceptionDetails || {};
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
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 45000);
    });
  }
}

function cleanup(code) {
  try {
    child.kill('SIGKILL');
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(udd, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exit(code);
}

try {
  const ver = await endpoint();
  const target = await (
    await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, {
      method: 'PUT',
    })
  ).json();

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('ws 连接失败')), { once: true });
  });

  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  if (blockUrls.length) {
    await cdp.send('Network.enable');
    await cdp.send('Network.setBlockedURLs', { urls: blockUrls });
  }
  const result = {};
  if (initScript) {
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: initScript });
    result.initScript = true;
  }
  if (blockUrls.length) result.blocked = blockUrls;  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 600,
  });

  await cdp.send('Page.navigate', { url });
  await sleep(waitMs);

  if (dismissSplash) {
    const r = await cdp.send('Runtime.evaluate', {
      expression: `(()=>{const s=document.querySelector('[class*="__splash__"]')||document.querySelector('[class*="splash"]');if(!s)return 'no-splash';s.click();return 'clicked'})()`,
      returnByValue: true,
    });
    result.splash = r.result?.value;
    await sleep(1200); // 450ms 淡出过渡 + 卸载
    const still = await cdp.send('Runtime.evaluate', {
      expression: `(()=>{const s=document.querySelector('[class*="__splash__"]');return s?getComputedStyle(s).display:'gone'})()`,
      returnByValue: true,
    });
    result.splashAfter = still.result?.value;
  }

  result.browser = ver.Browser;
  result.viewport = `${width}x${height}`;
  if (expr) {
    const r = await cdp.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      result.error = r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || '');
    } else {
      const v = r.result.value;
      try {
        result.value = typeof v === 'string' ? JSON.parse(v) : v;
      } catch {
        result.value = v;
      }
    }
  }

  if (png) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(png, Buffer.from(shot.data, 'base64'));
    result.png = png;
    result.pngBytes = fs.statSync(png).size;
  }

  if (withLogs) result.logs = cdp.logs.slice(-40);

  console.log(JSON.stringify(result, null, 2));
  cleanup(0);
} catch (err) {
  console.log(JSON.stringify({ error: String(err && err.message ? err.message : err) }, null, 2));
  cleanup(1);
}
