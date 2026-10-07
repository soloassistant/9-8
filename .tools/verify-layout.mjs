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
 * ⚠️ 变异验证的结论（2026-10-07 实测，务必保留这几条认知）：
 *   1. 把产物里的 `width:20rem` 改回 `auto` 复现原 bug 后，**「近白像素占比」没有报警**。
 *      在**正确的页面**上重测（见下条）依然是：修复态 0.2488 / 变异态 0.2488，
 *      逐像素仅 8.5% 不同。原因是绝对定位的页面内容**会逃出 0 宽父容器**照常绘制 ——
 *      也就是说这个缺陷在 1280×720 下**并不产生"白屏"**（见第 3 条）。
 *      真正抓到 bug 的是「面板宽度/居中/页面宽度非 0」这三条几何断言。
 *   2. **开屏封面必须点掉再截图**。本应用的开屏不自动关闭（要点击），
 *      不点它，截到的就是全屏遮罩：不同视口/档位截出的图**字节完全相同**，
 *      而"近白占比"看着还挺正常。实测开屏态与页面态 **99.4% 像素不同**。
 *      所以脚本里带 `--dismiss-splash`，并单独断言「开屏已关闭」——
 *      否则像素类结论全是错的，而且错误极难察觉（图看着有内容）。
 *   3. **本缺陷的视觉症状是"布局带偏移 ~8.5% 像素"，不是白屏。**
 *      因此外部审计报的"1280×720 全白"**不能**由这条根因解释；
 *      本次修复能主张的只是"容器几何恢复正确"，不要宣称修好了白屏。
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

/** 面板封顶宽度（rem 基准 20 => 500px），见 src/app.scss 的 @media (min-width:500px)。
 *  ⚠️ 这是**标准档位（--ui-scale: 1）**下的值。容器宽 = min(vw,500px) × scale，
 *  非标准档位由下面的 SCALE_CASES 单独覆盖。 */
const PANEL_MAX = 500;

const VIEWPORTS = [
  { w: 375, h: 812, note: 'iPhone X（不触发桌面规则）' },
  { w: 414, h: 896, note: 'iPhone 11 Pro Max' },
  { w: 768, h: 1024, note: 'iPad 竖屏（进入桌面规则）' },
  { w: 1280, h: 720, note: '外部审计报告的白屏尺寸' },
  { w: 1440, h: 900, note: 'MacBook' },
  { w: 1920, h: 1080, note: '外接显示器' },
];

/** 界面大小档位 → 预设 id 与系数（须与 src/store/uiScale.ts 的 UI_SCALE_PRESETS 一致）。
 *  为什么要覆盖：容器宽写成 20rem 后，它会跟着 --ui-scale 同比变化；
 *  不把这维纳入回归，将来改档位或改 rem 基准时没人会发现"桌面卡片宽度漂了"。 */
const SCALE_CASES = [
  { id: 'small', scale: 0.85 },
  { id: 'large', scale: 1.15 },
  { id: 'xlarge', scale: 1.3 },
];
const SCALE_VIEWPORT = { w: 1280, h: 720 };

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

/** 读 PNG → 近白像素占比 + 量化后的不同颜色数。
 *  两个都要，因为**单看近白占比会误判**：手机视口下白卡片本就多，
 *  修好的页面实测近白 54.8%（比有些"坏页"还高）。而真正"什么都没画"的页面
 *  特征是"几乎全白 **且** 颜色数 ≤3"（纯背景 + 一个边框色）。
 *  纯标准库实现（本机无 Pillow，不引依赖）。 */
function pngStats(file) {
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
  const colors = new Set();
  for (let i = 0; i + 2 < out.length; i += ch) {
    total++;
    if (out[i] >= 250 && out[i + 1] >= 250 && out[i + 2] >= 250) white++;
    colors.add(((out[i] >> 4) << 8) | ((out[i + 1] >> 4) << 4) | (out[i + 2] >> 4));
  }
  const nearWhite = total ? white / total : 1;
  return {
    nearWhite,
    distinctColors: colors.size,
    // 与 .tools/png-stats.py 的判据保持一致：既要几乎全白，又要几乎没有颜色
    whiteScreen: nearWhite > 0.985 && colors.size <= 3,
  };
}

function runProbe(port, vp, png, initFile) {
  const expr = `(()=>{const g=s=>{const e=document.querySelector(s);if(!e)return null;const b=e.getBoundingClientRect();return{w:Math.round(b.width),x:Math.round(b.x),y:Math.round(b.y),h:Math.round(b.height)}};return JSON.stringify({vw:innerWidth,vh:innerHeight,rem:getComputedStyle(document.documentElement).fontSize,uiScale:getComputedStyle(document.documentElement).getPropertyValue('--ui-scale').trim(),stubKept:!!(window.WorkBuddyCloud&&window.WorkBuddyCloud.__probe),hash:location.hash,container:g('.taro-tabbar__container'),panel:g('.taro-tabbar__panel'),page:g('.taro_page'),pageCount:document.querySelectorAll('.taro_page').length,scrollW:document.documentElement.scrollWidth,bodyText:(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,80)})})()`;
  return new Promise((resolve, reject) => {
    const args = [
      PROBE,
      `http://127.0.0.1:${port}/#/pages/briefing/index`,
      String(vp.w),
      String(vp.h),
      '--init-script',
      initFile,
      '--block-url',
      '*cdn.jsdelivr.net*',
      '--dismiss-splash',
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
        // splash / splashAfter 在探针输出的顶层（不在 value 里），要显式带出来
        resolve({ ...parsed.value, splash: parsed.splash, splashAfter: parsed.splashAfter });
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

  // 默认测试态：只有假 SDK
  const stubSrc = fs.readFileSync(SESSION_STUB, 'utf8');
  const defaultInit = path.join(OUTDIR, '_init_default.js');
  fs.writeFileSync(defaultInit, stubSrc);

  // 档位测试态：先把 ui-scale 写进 localStorage 再加载（Taro 的存储格式是 {"data":"<id>"}）
  const scaleInits = {};
  for (const sc of SCALE_CASES) {
    const f = path.join(OUTDIR, `_init_${sc.id}.js`);
    fs.writeFileSync(
      f,
      `try{localStorage.setItem('ui-scale','{"data":"${sc.id}"}')}catch(e){}\n` + stubSrc
    );
    scaleInits[sc.id] = f;
  }

  const { server, port } = await serveDist();
  const rows = [];
  let failed = 0;

  for (const vp of VIEWPORTS) {
    const png = path.join(OUTDIR, `${vp.w}x${vp.h}.png`);
    try {
      const v = await runProbe(port, vp, png, defaultInit);
      const st = pngStats(png);
      const white = st.nearWhite;
      const expectPanel = Math.min(vp.w, PANEL_MAX);
      const expectX = Math.round((vp.w - expectPanel) / 2);
      const checks = [
        ['容器未塌陷', (v.container?.w || 0) === vp.w, `container=${v.container?.w} 期望 ${vp.w}`],
        ['面板宽度正确', Math.abs((v.panel?.w || 0) - expectPanel) <= 1, `panel=${v.panel?.w} 期望 ${expectPanel}`],
        ['面板水平居中', Math.abs((v.panel?.x || 0) - expectX) <= 1, `panel.x=${v.panel?.x} 期望 ${expectX}`],
        ['页面宽度非 0', (v.page?.w || 0) > 0, `page=${v.page?.w}`],
        ['无横向溢出', (v.scrollW || 0) <= vp.w + 1, `scrollW=${v.scrollW} 期望 <=${vp.w}`],
        // ⚠️ 这条**不能用来证明本缺陷已修**：实测把修复撤掉后，本判据的数字几乎不变
        //    （修复态 0.2488 / 变异态 0.2488，逐像素仅 8.5% 不同）——
        //    因为绝对定位的页面内容会逃出 0 宽父容器照常绘制。它只能防"整页真的什么都没绘制"。
        ['页面已绘制（辅助判据，对本缺陷无判别力）', !st.whiteScreen, `近白=${(white * 100).toFixed(1)}% 颜色数=${st.distinctColors}`],
        // 这条才是像素类结论的前提：不点掉开屏，截到的就是全屏遮罩（实测两态 99.4% 像素不同）
        ['开屏已关闭（否则像素判据测的是遮罩）', v.splash === 'no-splash' || v.splashAfter === 'gone', `splash=${v.splash} 之后=${v.splashAfter}`],
        ['测试态生效', v.stubKept === true && /briefing/.test(v.hash || ''), `hash=${v.hash} stub=${v.stubKept}`],
        ['只挂载 1 个页面', v.pageCount === 1, `pageCount=${v.pageCount}`],
      ];
      const bad = checks.filter((c) => !c[1]);
      if (bad.length) failed++;
      rows.push({ vp, v, white, st, checks, bad, png });
    } catch (e) {
      failed++;
      rows.push({ vp, error: String(e.message || e), checks: [], bad: [['探针执行', false, String(e.message || e)]] });
    }
  }

  // 第二段：界面大小档位 × 1280 —— 面板宽应随 scale 同比变化（且仍居中、不溢出）
  const scaleRows = [];
  for (const sc of SCALE_CASES) {
    const png = path.join(OUTDIR, `scale-${sc.id}-${SCALE_VIEWPORT.w}x${SCALE_VIEWPORT.h}.png`);
    const vp = { ...SCALE_VIEWPORT, note: `界面大小=${sc.id}` };
    try {
      const v = await runProbe(port, vp, png, scaleInits[sc.id]);
      const st = pngStats(png);
      const white = st.nearWhite;
      const expectPanel = Math.round(Math.min(vp.w, PANEL_MAX) * sc.scale);
      const expectX = Math.round((vp.w - expectPanel) / 2);
      const checks = [
        ['系数已生效', Math.abs(Number(v.uiScale) - sc.scale) < 1e-6, `--ui-scale=${v.uiScale} 期望 ${sc.scale}`],
        ['面板随档位同比', Math.abs((v.panel?.w || 0) - expectPanel) <= 1, `panel=${v.panel?.w} 期望 ${expectPanel}`],
        ['面板水平居中', Math.abs((v.panel?.x || 0) - expectX) <= 1, `panel.x=${v.panel?.x} 期望 ${expectX}`],
        ['页面宽度非 0', (v.page?.w || 0) > 0, `page=${v.page?.w}`],
        ['无横向溢出', (v.scrollW || 0) <= vp.w + 1, `scrollW=${v.scrollW} 期望 <=${vp.w}`],
        ['页面已绘制（辅助判据）', !st.whiteScreen, `近白=${(white * 100).toFixed(1)}% 颜色数=${st.distinctColors}`],
        ['开屏已关闭', v.splash === 'no-splash' || v.splashAfter === 'gone', `splash=${v.splash} 之后=${v.splashAfter}`],
      ];
      const bad = checks.filter((c) => !c[1]);
      if (bad.length) failed++;
      scaleRows.push({ sc, v, white, st, checks, bad });
    } catch (e) {
      failed++;
      scaleRows.push({ sc, error: String(e.message || e), checks: [], bad: [['探针执行', false, String(e.message || e)]] });
    }
  }
  server.close();

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          failed,
          viewports: rows.map((r) => ({ vp: r.vp, white: r.white, colors: r.st && r.st.distinctColors, bad: r.bad, error: r.error })),
          scales: scaleRows.map((r) => ({ scale: r.sc?.id, white: r.white, colors: r.st && r.st.distinctColors, bad: r.bad, error: r.error })),
        },
        null,
        2
      )
    );
  } else {
    console.log('视口布局回归 (verify:layout)');
    console.log('─'.repeat(96));
    console.log(
      '视口'.padEnd(12) + 'rem'.padEnd(9) + '容器'.padEnd(9) + '面板'.padEnd(15) + '页面'.padEnd(14) + '近白/颜色'.padEnd(13) + '结论'
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
          `${(r.white * 100).toFixed(1)}%/${r.st.distinctColors}`.padEnd(13) +
          (r.bad.length ? `FAIL ${r.bad.map((b) => b[0]).join(',')}` : 'PASS')
      );
    }
    console.log('─'.repeat(96));
    for (const r of rows) {
      for (const b of r.bad) console.log(`  ✗ ${r.vp.w}x${r.vp.h} ${b[0]}: ${b[2]}`);
    }

    console.log('\n界面大小档位回归（1280x720，容器宽应 = min(vw,500) × scale）');
    console.log('─'.repeat(96));
    console.log('档位'.padEnd(12) + '系数'.padEnd(9) + 'rem'.padEnd(9) + '面板'.padEnd(15) + '页面'.padEnd(14) + '近白/颜色'.padEnd(13) + '结论');
    for (const r of scaleRows) {
      if (r.error) {
        console.log(`${r.sc.id}`.padEnd(12) + `错误: ${r.error.slice(0, 70)}`);
        continue;
      }
      const v = r.v;
      console.log(
        `${r.sc.id}`.padEnd(12) +
          String(r.sc.scale).padEnd(9) +
          String(v.rem).padEnd(9) +
          `${v.panel?.w}@${v.panel?.x}`.padEnd(15) +
          `${v.page?.w}x${v.page?.h}`.padEnd(14) +
          `${(r.white * 100).toFixed(1)}%/${r.st.distinctColors}`.padEnd(13) +
          (r.bad.length ? `FAIL ${r.bad.map((b) => b[0]).join(',')}` : 'PASS')
      );
    }
    console.log('─'.repeat(96));
    for (const r of scaleRows) {
      for (const b of r.bad) console.log(`  ✗ scale=${r.sc.id} ${b[0]}: ${b[2]}`);
    }
    const total = rows.length + scaleRows.length;
    console.log(`结果: ${failed === 0 ? 'PASS' : `FAIL ${failed}/${total}`}（截图在 .tools/.layout-shots/）`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('verify:layout 异常:', e);
  process.exit(1);
});
