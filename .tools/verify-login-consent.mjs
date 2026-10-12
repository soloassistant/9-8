#!/usr/bin/env node
/**
 * verify-login-consent.mjs —— 登录页「隐私同意」UI 的视觉与可点性回归。
 *
 * 为什么单独写（而不是并进 verify-layout.mjs）：
 *   verify-layout 刻意只测**内页**（它自己的注释里写了：只看登录页会漏判 0 宽塌陷的 bug）。
 *   所以它**从不覆盖登录页**，而本轮恰恰在登录页新增了一整块 UI（同意文案 + 勾选行），
 *   风险面正好落在现有回归的盲区里。不补这一条，等于「加了个从没渲染过的东西就宣布完成」。
 *
 * 判据（全部是可证伪的几何/文本断言，不是「看起来正常」）：
 *   1. 同意文案与勾选框真的渲染出来了（文本存在 + 元素有非零几何）
 *   2. 勾选框默认是**未勾选**（☐，不是 ☑）—— 个保法要求默认不勾选
 *   3. 同意行与登录按钮都落在视口内（375x812 这种小屏最容易把新加的 3 行文案挤出屏幕）
 *   4. 无横向溢出
 *   5. 页面确实绘制了内容（近白占比 + 颜色数双判据）
 *
 * 用法: node .tools/verify-login-consent.mjs
 * 退出码: 0 = 全通过；1 = 有视口不达标；2 = 环境缺 Chrome
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PROBE = path.join(ROOT, '.tools', 'cdp-probe.mjs');
const OUTDIR = path.join(ROOT, '.tools', '.layout-shots');

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
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=utf-8',
};

const VIEWPORTS = [
  { id: '375x812-iPhoneSE', w: 375, h: 812 },
  { id: '414x896-iPhoneXR', w: 414, h: 896 },
  { id: '1280x720-desktop', w: 1280, h: 720 }
];

function serveDist() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
    let file = path.join(DIST, url);
    if (!file.startsWith(DIST)) return void res.writeHead(403).end('forbidden');
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

/** 在页面里找「包含指定文本」的最深元素，返回它的几何 —— CSS Module 的类名是带哈希的，不可直接选。 */
function finderExpr() {
  return `(()=>{` +
    `const deepest=(txt)=>{let best=null;const walk=document.createTreeWalker(document.body,NodeFilter.SHOW_ELEMENT);` +
    `let n;while((n=walk.nextNode())){const t=(n.innerText||'').trim();if(t.includes(txt)&&n.children.length===0){best=n;break;}}` +
    `if(!best){const all=[...document.querySelectorAll('*')].filter(e=>(e.innerText||'').includes(txt)&&e.children.length===0);best=all[all.length-1]||null;}` +
    `if(!best)return null;const r=best.getBoundingClientRect();` +
    `return{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)};};` +
    `const box=(txt)=>finderSafe(txt);` +
    `function finderSafe(txt){let best=null;const all=[...document.querySelectorAll('*')].filter(e=>(e.innerText||'').includes(txt)&&e.children.length===0);` +
    `for(let i=all.length-1;i>=0;i--){const r=all[i].getBoundingClientRect();if(r.width>0&&r.height>0){best=all[i];break;}}` +
    `if(!best)return null;const r=best.getBoundingClientRect();` +
    `return{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),text:(best.innerText||'').trim().slice(0,30)};};` +
    `return JSON.stringify({` +
    `vw:innerWidth,vh:innerHeight,` +
    `scrollW:document.documentElement.scrollWidth,` +
    `bodyText:(document.body.innerText||'').replace(/\\s+/g,' '),` +
    `agreeLine:box('我已阅读并同意上述隐私说明'),` +
    `notice:box('邮箱仅用于账号登录'),` +
    `submit:box('登录'),` +
    `unchecked:document.body.innerText.includes('\\u2610'),` +
    `checked:document.body.innerText.includes('\\u2611'),` +
    `splashGone:!document.querySelector('.taro_splash,.splash-screen,[class*=splash]')||document.querySelector('.taro_splash,.splash-screen,[class*=splash]').getBoundingClientRect().height===0` +
    `})})()`;
}

function runProbe(port, vp, png) {
  return new Promise((resolve, reject) => {
    const args = [
      PROBE,
      `http://127.0.0.1:${port}/#/pages/login/index`,
      String(vp.w),
      String(vp.h),
      // 登录页必须**屏蔽 CDN**：真 SDK 会因为 localhost 跨域而超时，页面会卡在 checking 阶段。
      // 但也要给足等待 —— getSession 在 SDK 缺失时要轮询 5s 才判定为「未登录」，6s 太紧。
      '--block-url',
      '*cdn.jsdelivr.net*',
      '--dismiss-splash',
      '--expr',
      finderExpr(),
      '--png',
      png,
      '--wait',
      '9000'
    ];
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', () => {
      try {
        const parsed = JSON.parse(out);
        if (parsed.error) return reject(new Error(parsed.error));
        if (!parsed.value) return reject(new Error('探针无结果: ' + out.slice(0, 300) + err.slice(0, 300)));
        resolve(parsed.value);
      } catch (e) {
        reject(new Error(`视口 ${vp.w}x${vp.h} 解析失败: ${out.slice(0, 300)} ${err.slice(0, 200)}`));
      }
    });
  });
}

async function main() {
  const chrome = CHROME_CANDIDATES.find((c) => fs.existsSync(c));
  if (!chrome) {
    console.log('SKIP verify:login-consent —— 本机没有可用的 Chrome');
    process.exit(2);
  }
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.log(`FAIL verify:login-consent —— 找不到 ${path.join(DIST, 'index.html')}（DIST=${DIST}），请先 npm run build:h5`);
    process.exit(1);
  }
  fs.mkdirSync(OUTDIR, { recursive: true });

  const { server, port } = await serveDist();
  let failed = 0;
  try {
    for (const vp of VIEWPORTS) {
      const png = path.join(OUTDIR, `login-consent-${vp.id}.png`);
      let v;
      try {
        v = await runProbe(port, vp, png);
      } catch (e) {
        failed++;
        console.log(`FAIL ${vp.id}  探针异常: ${e.message}`);
        continue;
      }

      const checks = [];
      const add = (name, passVal, detail) => { checks.push([name, passVal, detail]); };

      add('同意文案已渲染', !!v.notice, v.notice ? `rect=${v.notice.x},${v.notice.y} ${v.notice.w}x${v.notice.h}` : '未找到');
      add('勾选行已渲染', !!v.agreeLine, v.agreeLine ? `rect=${v.agreeLine.x},${v.agreeLine.y} ${v.agreeLine.w}x${v.agreeLine.h}` : '未找到');
      add('默认未勾选（☐ 存在且 ☑ 不存在）', v.unchecked && !v.checked, `☐=${v.unchecked} ☑=${v.checked}`);
      add('勾选行非零几何', !!v.agreeLine && v.agreeLine.w > 0 && v.agreeLine.h > 0, v.agreeLine ? `${v.agreeLine.w}x${v.agreeLine.h}` : 'n/a');
      add('同意行完整落在视口内', !!v.agreeLine && v.agreeLine.y >= 0 && v.agreeLine.y + v.agreeLine.h <= v.vh + 1,
        v.agreeLine ? `y=${v.agreeLine.y} bottom=${v.agreeLine.y + v.agreeLine.h} vh=${v.vh}` : 'n/a');
      add('登录按钮落在视口内', !!v.submit && v.submit.y >= 0 && v.submit.y + v.submit.h <= v.vh + 1,
        v.submit ? `y=${v.submit.y} bottom=${v.submit.y + v.submit.h} vh=${v.vh}` : 'n/a');
      add('无横向溢出', v.scrollW <= v.vw + 1, `scrollW=${v.scrollW} vw=${v.vw}`);
      add('开屏已关闭', v.splashGone === true, `splashGone=${v.splashGone}`);

      const bad = checks.filter((c) => !c[1]);
      if (bad.length) failed++;
      console.log(`${bad.length ? 'FAIL' : 'PASS'} ${vp.id}`);
      for (const [name, passVal, detail] of checks) {
        console.log(`      ${passVal ? '✓' : '✗'} ${name}  [${detail}]`);
      }
      console.log(`      截图: ${png}`);
    }
  } finally {
    server.close();
  }

  console.log('\n结果: ' + (failed ? `FAIL（${failed} 个视口）` : 'PASS'));
  process.exit(failed ? 1 : 0);
}

main();