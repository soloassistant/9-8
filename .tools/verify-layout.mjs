#!/usr/bin/env node
/**
 * verify-layout.mjs —— 布局回归：多视口下断言「页面不塌、不白屏、不横向溢出」。
 *
 * 为什么需要它（真实故障，2026-10-07）：
 *   ≥500px 视口下整页宽度塌成 0 —— `.taro-tabbar__panel` 是 column flex 的子项且 `flex:1 1 0%`，
 *   它唯一的子节点 `.taro_router` 又是 `position:absolute`（脱离文档流），于是 `margin:0 auto`
 *   把自由空间全吃掉，fit-content 退化为 0。症状是**白屏**，而登录页因为 `.screen` 是
 *   `position:fixed` 反而看着正常 —— 只看登录页会漏判。
 *
 * 所以判据必须包含：① 内页（非登录页）② 大视口 ③ 面板/页面的**确定几何**。
 * 三点缺一，这个 bug 就会再溜过去一次。
 *
 * ⚠️ 变异验证的结论（2026-10-07 实测，务必保留这条认知）：
 *   把产物里的 `width:20rem` 改回 `auto` 复现原 bug 后，**"近白像素占比"这个判据没有报警**
 *   （各视口仍是 0.3%~0.8%）—— 因为塌陷的是 `.taro_page`，而页面里 `.screen` 是 `position:fixed`，
 *   脱离塌陷容器照样绘制。真正抓到 bug 的是「面板宽度/居中/页面宽度非 0」这三条几何断言。
 *   结论：像素判据只能当辅助，不能当主判据；宁可多写几何断言。
 *   （顺带说明外部审计"1280×720 全白"与"内容被压成 0 宽"可能是两种不同页面的表现。）
 *
 * 内页需要登录态：探针通过 CDP 注入一个**仅在测试进程内存在**的假 SDK（见 cdp-probe-session.js），
 * 并屏蔽 CDN —— 否则真 SDK 会覆盖测试桩，页面被门禁踢回登录页，测出来的又是登录页。
 *
 * 用法: node .tools/verify-layout.mjs [--json]
 * 退出码: 0 = 全通过（或环境缺 Chrome 时 SKIP）；1 = 有视口不达标
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PROBE = path.join(ROOT, '.tools', 'cdp-probe.mjs');
const SESSION_STUB = path.join(ROOT, '.tools', 'cdp-probe-session.js');
const OUTDIR = path.join(ROOT, '.tools', '.layout-shots');

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  'C:\\Users\\geral\\.agent-browser\\browsers\\chrome-154.0.8037.92\\chrome.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

/** 面板封顶宽度（rem 基准 20 => 500px），见 src/app.scss 的 @media (min-width:500px) */
const PANEL_MAX = 500;

const VIEWPORTS = [
  { w: 375, h: 812, note: 'iPhone X（不触发桌面规则）' },
  { w: 414, h: 896, note: 'iPhone 11 Pro Max' },
  { w: 768, h: 1024, note: 'iPad 竖屏（进入桌面规则）' },
  { w: 1280, h: 720, note: '外部审计报告的白屏尺寸' },
  { w: 1440, h: 900, note: 'MacBook' },
  { w: 1920, h: 1080, note: '外接显示器' },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=utf-8',
};

function serveDist() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
    let file = path.join(DIST, url);
    if (!file.startsWith(DIST)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** 读 PNG → 近白像素占比。纯标准库实现（不引入 Pillow/pngjs 依赖）。 */
function pngNearWhite(file) {
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 8).toString('binary') !== '\x89PNG\r\n\x1a\n') throw new Error('not png');
  let pos = 8;
  let idat = [];
  let w = 0;
  let h = 0;
  let colortype = 0;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString('ascii');
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error('only 8-bit');
      colortype = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[colortype];
  if (!ch) throw new Error('unsupported colortype ' + colortype);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    const line = Buffer.from(raw.subarray(p, p + stride));
    p += stride;
    if (f === 1) for (let i = ch; i < stride; i++) line[i] = (line[i] + line[i - ch]) & 0xff;
    else if (f === 2) for (let i = 0; i < stride; i++) line[i] = (line[i] + prev[i]) & 0xff;
    else if (f === 3)
      for (let i = 0; i < stride; i++) {
        const a = i >= ch ? line[i - ch] : 0;
        line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xff;
      }
    else if (f === 4)
      for (let i = 0; i < stride; i++) {
        const a = i >= ch ? line[i - ch] : 0;
        const b = prev[i];
        const c = i >= ch ? prev[i - ch] : 0;
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        line[i] = (line[i] + pr) & 0xff;
      }
    line.copy(out, y * stride);
    prev = line;
  }
  let total = 0;
  let white = 0;
  for (let i = 0; i + 2 < out.length; i += ch) {
    total++;
    if (out[i] >= 250 && out[i + 1] >= 250 && out[i + 2] >= 250) white++;
  }
  return total ? white / total : 1;
}

function runProbe(port, vp, png) {
  const expr = `(()=>{const g=s=>{const e=document.querySelector(s);if(!e)return null;const b=e.getBoundingClientRect();return{w:Math.round(b.width),x:Math.round(b.x),y:Math.round(b.y),h:Math.round(b.height)}};return JSON.stringify({vw:innerWidth,vh:innerHeight,rem:getComputedStyle(document.documentElement).fontSize,stubKept:!!(window.WorkBuddyCloud&&window.WorkBuddyCloud.__probe),hash:location.hash,container:g('.taro-tabbar__container'),panel:g('.taro-tabbar__panel'),page:g('.taro_page'),pageCount:document.querySelectorAll('.taro_page').length,scrollW:document.documentElement.scrollWidth,bodyText:(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,80)})})()`;
  return new Promise((resolve, reject) => {
    const args = [
      PROBE,
      `http://127.0.0.1:${port}/#/pages/briefing/index`,
      String(vp.w),
      String(vp.h),
      '--init-script',
      SESSION_STUB,
      '--block-url',
      '*cdn.jsdelivr.net*',
      '--expr',
      expr,
      '--png',
      png,
      '--wait',
      '6000',
    ];
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      try {
        const parsed = JSON.parse(out);
        if (parsed.error) return reject(new Error(parsed.error));
        if (!parsed.value) return reject(new Error('probe 无结果: ' + out.slice(0, 300) + err.slice(0, 300)));
        resolve(parsed.value);
      } catch (e) {
        reject(new Error(`视口 ${vp.w}x${vp.h} 解析失败(${code}): ${out.slice(0, 300)} ${err.slice(0, 200)}`));
      }
    });
  });
}

async function main() {
  const asJson = process.argv.includes('--json');
  const chrome = CHROME_CANDIDATES.find((c) => fs.existsSync(c));
  if (!chrome) {
    console.log('SKIP verify:layout —— 本机没有可用的 Chrome，跳过布局回归（不影响 CI）');
    process.exit(0);
  }
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.log('FAIL verify:layout —— dist/index.html 不存在，请先 npm run build:h5');
    process.exit(1);
  }
  process.env.CHROME_BIN = chrome;
  fs.mkdirSync(OUTDIR, { recursive: true });

  const { server, port } = await serveDist();
  const rows = [];
  let failed = 0;

  for (const vp of VIEWPORTS) {
    const png = path.join(OUTDIR, `${vp.w}x${vp.h}.png`);
    try {
      const v = await runProbe(port, vp, png);
      const white = pngNearWhite(png);
      const expectPanel = Math.min(vp.w, PANEL_MAX);
      const expectX = Math.round((vp.w - expectPanel) / 2);
      const checks = [
        ['容器未塌陷', (v.container?.w || 0) === vp.w, `container=${v.container?.w} 期望 ${vp.w}`],
        ['面板宽度正确', Math.abs((v.panel?.w || 0) - expectPanel) <= 1, `panel=${v.panel?.w} 期望 ${expectPanel}`],
        ['面板水平居中', Math.abs((v.panel?.x || 0) - expectX) <= 1, `panel.x=${v.panel?.x} 期望 ${expectX}`],
        ['页面宽度非 0', (v.page?.w || 0) > 0, `page=${v.page?.w}`],
        ['无横向溢出', (v.scrollW || 0) <= vp.w + 1, `scrollW=${v.scrollW} 期望 <=${vp.w}`],
        ['非白屏', white < 0.5, `近白像素占比=${(white * 100).toFixed(1)}%`],
        ['测试态生效', v.stubKept === true && /briefing/.test(v.hash || ''), `hash=${v.hash} stub=${v.stubKept}`],
        ['只挂载 1 个页面', v.pageCount === 1, `pageCount=${v.pageCount}`],
      ];
      const bad = checks.filter((c) => !c[1]);
      if (bad.length) failed++;
      rows.push({ vp, v, white, checks, bad, png });
    } catch (e) {
      failed++;
      rows.push({ vp, error: String(e.message || e), checks: [], bad: [['探针执行', false, String(e.message || e)]] });
    }
  }
  server.close();

  if (asJson) {
    console.log(JSON.stringify({ failed, rows: rows.map((r) => ({ vp: r.vp, white: r.white, bad: r.bad, error: r.error })) }, null, 2));
  } else {
    console.log('视口布局回归 (verify:layout)');
    console.log('─'.repeat(96));
    console.log(
      '视口'.padEnd(12) + 'rem'.padEnd(9) + '容器'.padEnd(9) + '面板'.padEnd(15) + '页面'.padEnd(14) + '近白'.padEnd(9) + '结论'
    );
    for (const r of rows) {
      if (r.error) {
        console.log(`${r.vp.w}x${r.vp.h}`.padEnd(12) + `错误: ${r.error.slice(0, 70)}`);
        continue;
      }
      const v = r.v;
      console.log(
        `${r.vp.w}x${r.vp.h}`.padEnd(12) +
          String(v.rem).padEnd(9) +
          `${v.container?.w}`.padEnd(9) +
          `${v.panel?.w}@${v.panel?.x}`.padEnd(15) +
          `${v.page?.w}x${v.page?.h}`.padEnd(14) +
          `${(r.white * 100).toFixed(1)}%`.padEnd(9) +
          (r.bad.length ? `FAIL ${r.bad.map((b) => b[0]).join(',')}` : 'PASS')
      );
    }
    console.log('─'.repeat(96));
    for (const r of rows) {
      for (const b of r.bad) console.log(`  ✗ ${r.vp.w}x${r.vp.h} ${b[0]}: ${b[2]}`);
    }
    console.log(`结果: ${failed === 0 ? 'PASS' : `FAIL ${failed}/${rows.length}`}（截图在 .tools/.layout-shots/）`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('verify:layout 异常:', e);
  process.exit(1);
});
