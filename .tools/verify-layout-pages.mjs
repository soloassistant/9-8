#!/usr/bin/env node
/**
 * verify-layout-pages.mjs —— 把布局回归从「只有晨报一页」扩到**全部 5 个内页**，
 * 并对 2026-10-12 那批 UI 修复做**针对性断言**（不只看「没塌」，看「修复真的生效了」）。
 *
 * 为什么必须补这个（2026-10-12）：
 *   `verify-layout.mjs` 的 6 视口 × 3 字号档**全部只访问 `#/pages/briefing/index`**
 *   （源码第 195 行写死）。所以：
 *     · 收件箱 / 热点 / 日历 / 我的 / 资料库 这 5 页**从未**进入过自动布局回归；
 *     · 我在那一轮改的 `resize:none`、源名截断、底部安全区，**一条都没被自动验证过** ——
 *       它们只被「浏览器里单视口看过一眼」覆盖过。
 *   也就是说：我上一轮汇报的「三档面板全 PASS」**不能**证明这批修复有效。
 *
 * 断言分两层：
 *   通用层（每页每视口）：容器/面板几何、非 0 宽度、无横向溢出、已绘制、开屏已关、桩生效、只挂 1 页
 *   针对层（按页）：见下方 CASES 的 probeExtra —— 这是本脚本相对 verify-layout 的**真正增量**
 *
 * 用法: node .tools/verify-layout-pages.mjs [--json] [--only=briefing]
 * 退出码: 0 = 全通过（或环境缺 Chrome 时 SKIP）；1 = 有断言不达标
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
const OUTDIR = path.join(ROOT, '.tools', '.layout-shots-pages');

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  'C:\\Users\\geral\\.agent-browser\\browsers\\chrome-154.0.8037.92\\chrome.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const PANEL_MAX = 500;

/** 只挑手机两档：上一轮已经证明 ≥768 的桌面规则下几何稳定，
 *  这里要把预算花在**真实用户尺寸**上，而不是重复跑已经稳定的大视口。 */
const VIEWPORTS = [
  { w: 375, h: 812, note: 'iPhone X / SE 基准宽' },
  { w: 640, h: 800, note: '上一轮发现 D1 裁切缺陷的那个视口' },
];

/** 真实语料里出现过的源名片段（用于 D6「源名铺满 4 行」断言）。
 *  取几个稳定的中文源名即可 —— 判据是「同一个文本节点里出现了几个源名」。 */
const SOURCE_TOKENS = ['量子位', '少数派', 'IT之家', '爱范儿', '钛媒体', '掘金', 'InfoQ', '经济观察报', '车东西'];

/** CSS Modules 在产物里的形态是 `index-module__quickRow___FoHc4`，
 *  所以一律用 [class*="..."] 子串选择，不要写死完整类名。 */
const CASES = [
  {
    // 2026-10-27：底部 AI 输入条（含快捷指令 chip 行）已撤销，原 D1 判据
    // （quickRow 存在 / 有渐隐遮罩 / 内容比容器宽）失去了被测对象 —— 那些断言不是"通过了"，
    // 是"再也测不到"了。改成测**撤掉之后**真正要守的两件事：
    //   ① 页面没有横向溢出（右缘被裁切是同一类缺陷的通用形态，不依赖某一行还在）；
    //   ② 底部那条输入栏确实不在产物里（防止「删了源码、产物还留着」）。
    id: 'briefing',
    route: '#/pages/briefing/index',
    note: 'D1 无横向溢出 + 底部输入栏确已移除',
    probeExtra: `
      const doc=document.documentElement;
      const pg=document.querySelector('[class*="index-module__page___"]');
      return {overflowX: Math.round(doc.scrollWidth - window.innerWidth),
        hasInputBar: !!document.querySelector('[class*="inputBar"]'),
        h: pg?Math.round(pg.getBoundingClientRect().height):0,
        pgExists:!!pg, pgPadBottom: pg?parseFloat(getComputedStyle(pg).paddingBottom)||0:0};`
  },
  {
    id: 'inbox',
    route: '#/pages/inbox/index',
    note: 'D4 textarea 原生 resize 手柄 + D8 底部安全区',
    probeExtra: `
      const ta=document.querySelector('[class*="__textarea___"]');
      const pg=document.querySelector('[class*="index-module__page___"]');
      const cs=ta?getComputedStyle(ta):null;
      return {taExists:!!ta,taResize:cs?cs.resize:'n/a',
        pgPadBottom:pg?parseFloat(getComputedStyle(pg).paddingBottom)||0:0};`
  },
  {
    id: 'calendar',
    route: '#/pages/calendar/index',
    note: 'D8 底部标题被 tabbar 压半行',
    probeExtra: `
      const pg=document.querySelector('[class*="index-module__page___"]');
      return {pgExists:!!pg,pgPadBottom:pg?parseFloat(getComputedStyle(pg).paddingBottom)||0:0};`
  },
  {
    id: 'mine',
    route: '#/pages/mine/index',
    note: 'D8 底部安全区 + 「开发环境提示」不应出现在生产产物里',
    probeExtra: `
      const pg=document.querySelector('[class*="index-module__page___"]');
      const txt=(document.body.innerText||'');
      return {pgExists:!!pg,pgPadBottom:pg?parseFloat(getComputedStyle(pg).paddingBottom)||0:0,
        h: pg?Math.round(pg.getBoundingClientRect().height):0,
        vh: window.innerHeight,
        hasDevText:txt.indexOf('开发环境')>=0,hasPaySoon:txt.indexOf('支付功能即将开放')>=0};`
  },
  {
    id: 'library',
    route: '#/pages/library/index',
    note: 'D6 源名截断 + D8 底部安全区；**热点资讯流就在这一页**（本项目没有独立的 hotspot 路由）',
    probeExtra: `
      const toks=${JSON.stringify(SOURCE_TOKENS)};
      const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
      let worst=0,worstTxt='',n;
      while((n=walker.nextNode())){
        const t=(n.nodeValue||'');
        const c=toks.filter(k=>t.indexOf(k)>=0).length;
        if(c>worst){worst=c;worstTxt=t.trim().slice(0,120);}
      }
      const pg=document.querySelector('[class*="index-module__page___"]');
      const cards=document.querySelectorAll('[class*="__newsCard___"]');
      const titles=[...document.querySelectorAll('[class*="__newsTitle___"]')].map(e=>(e.innerText||'').trim()).filter(Boolean);
      return {maxSourcesInOneTextNode:worst,worstText:worstTxt,
        pgExists:!!pg,pgPadBottom:pg?parseFloat(getComputedStyle(pg).paddingBottom)||0:0,
        newsCards:cards.length,firstTitle:titles[0]||'',
        hasHalfHtml:document.body.innerHTML.indexOf('点击查看原文>')>=0};`
  },
  /* 2026-10-27 新增的三个二级页。它们此前**从未**进过布局回归 ——
     而「新页面第一次上线」恰恰是最该量的时刻（我的页那一轮就是这么发现 1780px/2.1 屏的）。 */
  {
    id: 'membership',
    route: '#/pages/membership/index',
    note: '交易与计量页：订阅卡 + 订阅记录 + 额度记账 + 连续阅读',
    probeExtra: `
      const pg=document.querySelector('[class*="index-module__page___"]');
      const txt=(document.body.innerText||'');
      return {pgExists:!!pg, pgPadBottom: pg?parseFloat(getComputedStyle(pg).paddingBottom)||0:0,
        h: pg?Math.round(pg.getBoundingClientRect().height):0,
        hasBlank: txt.trim().length < 40};`
  },
  {
    id: 'prefs',
    route: '#/pages/prefs/index',
    note: '偏好设置页：称呼/推送/提醒/城市/语速/音色',
    probeExtra: `
      const pg=document.querySelector('[class*="index-module__page___"]');
      const txt=(document.body.innerText||'');
      return {pgExists:!!pg, pgPadBottom: pg?parseFloat(getComputedStyle(pg).paddingBottom)||0:0,
        h: pg?Math.round(pg.getBoundingClientRect().height):0,
        hasBlank: txt.trim().length < 40};`
  },
  {
    id: 'assistant',
    route: '#/pages/assistant/index',
    note: '全站唯一 AI 对话页（整页模式）：进来必须已有欢迎语，不是空白',
    probeExtra: `
      const pg=document.querySelector('[class*="index-module__page___"]');
      const txt=(document.body.innerText||'');
      const fab=document.getElementById('ai-fab');
      // ⚠️ 类名是 msgBubble（CSS Modules 产物里大小写保留），用 bubble 会命中 0 个 —— 
      //    第一次跑就是这么误判成「没有欢迎语」的（txtLen 却是 6354，自相矛盾才暴露）。
      return {pgExists:!!pg, hasFab: !!fab,
        msgCount: document.querySelectorAll('[class*="msgBubble"]').length,
        txtLen: txt.trim().length};`
  }
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
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
  '.txt': 'text/plain; charset=utf-8'
};

/** dist 烘焙的热点条目数（main() 里赋给 BAKED）。用来断言「页面渲染的条数 == dist 里的条数」，
 *  从而暴露「应用静默回退到了线上旧快照」这类问题。
 * ⚠️ 踩过的坑：原先本脚本的静态服务把无扩展名的 `/api/hotspot` 兜底成 index.html，
 *   应用 JSON.parse 失败后按 `api.ts:41` 的顺序回退到 gh-pages —— 拿到的是**线上 198 条旧数据**，
 *   而 dist 里装的是 220 条。也就是说「页面渲染 198 张卡片」看着正常，其实测错了对象。 */
let BAKED = -1;
function bakedItemCount() {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(DIST, 'api', 'hotspot.json'), 'utf8'));
    return Array.isArray(p.items) ? p.items.length : 0;
  } catch {
    return -1;
  }
}

function serveDist() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
    let file = path.join(DIST, url);
    if (!file.startsWith(DIST)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    // 应用按 `['/api/hotspot', LIVE_HOTSPOT_URL, './api/hotspot.json']` 顺序取数据。
    // 第一条是**无扩展名**的动态路由，纯静态托管下必然 404 → 应用回退到 gh-pages 旧快照。
    // 这里把 `/api/hotspot` 映射到烘焙的 `.json`，让探针测的确实是 dist 里那份数据。
    if (url === '/api/hotspot') {
      file = path.join(DIST, 'api', 'hotspot.json');
      if (fs.existsSync(file)) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        fs.createReadStream(file).pipe(res);
        return;
      }
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

/** 读 PNG → 近白像素占比 + 量化后的不同颜色数（判据与 verify-layout.mjs 完全一致，避免两套口径）。 */
function pngStats(file) {
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 8).toString('binary') !== '\x89PNG\r\n\x1a\n') throw new Error('not png');
  let pos = 8;
  const idat = [];
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
      colortype = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (colortype !== 6 && colortype !== 2) throw new Error('仅支持 RGB/RGBA，实得 colortype ' + colortype);
  // ⚠️ CDP 的 Page.captureScreenshot 不保证带 alpha：colortype 6 = RGBA(bpp4)、2 = RGB(bpp3)。
  //   只认 6 会让脚本在「截出来的是 RGB」时直接抛 —— 而且抛的是解码错误，
  //   看起来像探针挂了，其实截图早就落盘、页面也早渲染完了。踩过。
  const bpp = colortype === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[p++];
    const line = raw.subarray(p, p + stride);
    p += stride;
    const cur = out.subarray(y * stride, y * stride + stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, (y - 1) * stride + stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
  }
  const colors = new Set();
  let white = 0;
  let total = 0;
  for (let i = 0; i + 2 < out.length; i += bpp) {
    total++;
    if (out[i] >= 250 && out[i + 1] >= 250 && out[i + 2] >= 250) white++;
    colors.add(((out[i] >> 4) << 8) | ((out[i + 1] >> 4) << 4) | (out[i + 2] >> 4));
  }
  const nearWhite = total ? white / total : 1;
  return { nearWhite, distinctColors: colors.size, whiteScreen: nearWhite > 0.985 && colors.size <= 3 };
}

function runProbe(port, page, vp, png, initFile) {
  const expr = `(()=>{
    const g=s=>{const e=document.querySelector(s);if(!e)return null;const b=e.getBoundingClientRect();
      return{w:Math.round(b.width),x:Math.round(b.x),y:Math.round(b.y),h:Math.round(b.height)}};
    const base={vw:innerWidth,vh:innerHeight,hash:location.hash,
      stubKept:!!(window.WorkBuddyCloud&&window.WorkBuddyCloud.__probe),
      container:g('.taro-tabbar__container'),panel:g('.taro-tabbar__panel'),page:g('.taro_page'),
      pageCount:document.querySelectorAll('.taro_page').length,
      scrollW:document.documentElement.scrollWidth,
      bodyText:(document.body.innerText||'').replace(/\\s+/g,' ').slice(0,80)};
    const extra=(function(){${page.probeExtra}})();
    return JSON.stringify(Object.assign(base,extra));
  })()`;
  return new Promise((resolve, reject) => {
    const args = [
      PROBE,
      `http://127.0.0.1:${port}/${page.route}`,
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
      '6000'
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
        resolve({ ...parsed.value, splash: parsed.splash, splashAfter: parsed.splashAfter });
      } catch (e) {
        reject(new Error(`解析失败: ${out.slice(0, 300)} ${err.slice(0, 200)}`));
      }
    });
  });
}

/** 针对层断言：每页自己的修复是否真的生效。
 *  阈值说明：$page-pad-bottom-tab: 120rpx 在 375px 宽下 ≈ 60px（旧的 80rpx ≈ 40px），
 *  故取 50px 作分界 —— 既能区分 120 与 80，又不给 rem 换算留歧义。 */
function pageChecks(page, v) {
  const C = [];
  const push = (name, ok, detail) => C.push([name, !!ok, detail]);

  if (page.id === 'briefing') {
    push('D1 页面无横向溢出（右缘不被裁切）', (v.overflowX || 0) <= 1, `scrollWidth-innerWidth=${v.overflowX}px`);
    push('D1 底部输入栏不在产物里（页面上没有第二条对话入口）', v.hasInputBar === false, `hasInputBar=${v.hasInputBar}`);
    push('D8 页面根节点存在', v.pgExists, `pgExists=${v.pgExists}`);
    // 输入条撤掉后底部留白必须回落：原来为固定输入条预留 360rpx≈180px，
    // 留着就是滑到底一大片死白。tabBar 档 120rpx≈60px + 呼吸位，取 50px 作分界。
    push('D8 底部留白回落到 tabBar 档（不再为已删的输入条留 180px 死白）',
      (v.pgPadBottom || 0) >= 50 && (v.pgPadBottom || 0) <= 120,
      `paddingBottom=${v.pgPadBottom}px｜页面总高=${v.h}px（内容页，不设上限）`);
  }

  if (page.id === 'inbox') {
    push('D4 textarea 存在', v.taExists, `taExists=${v.taExists}`);
    push('D4 禁用原生 resize 手柄', v.taResize === 'none', `resize=${v.taResize}`);
    push('D8 底部安全区 ≥ 50px', (v.pgPadBottom || 0) >= 50, `paddingBottom=${v.pgPadBottom}px`);
  }

  if (page.id === 'hotspot' || page.id === 'library') {
    // D6 的症状是「一个文本节点里塞满源名」。截断后最多 3 个 + 一个「还有 N 个」。
    push('D6 单个文本节点里源名 ≤ 4 个', (v.maxSourcesInOneTextNode || 0) <= 4, `max=${v.maxSourcesInOneTextNode} 文本=「${v.worstText}」`);
  }  if (page.id === 'calendar') {
    push('D8 页面根节点存在', v.pgExists, `pgExists=${v.pgExists}`);
    push('D8 底部安全区 ≥ 50px', (v.pgPadBottom || 0) >= 50, `paddingBottom=${v.pgPadBottom}px`);
  }

  if (page.id === 'mine') {
    push('D8 页面根节点存在', v.pgExists, `pgExists=${v.pgExists}`);
    push('D8 底部安全区 ≥ 50px', (v.pgPadBottom || 0) >= 50, `paddingBottom=${v.pgPadBottom}px`);
    push('生产产物里不出现「开发环境」字样', v.hasDevText === false, `hasDevText=${v.hasDevText}`);
    // 2026-10-27：我的页从 1780px（2.1 屏）压到 991px（1.22 屏 @375）——靠把交易与偏好拆到
    // pages/membership 与 pages/prefs。这条断言锁住瘦身成果：谁再往我的页堆卡片就红。
    // ⚠️ 上限取 1.8 屏而不是 1.5：本项目全站尺寸走 rem，html 基准是 min(100vw,500px)/20，
    //    所以 640 视口下所有字号/间距按 500/375 放大 33%，同样的内容自然从 1.22 屏变成 1.65 屏。
    //    拿一个固定倍数卡两档会变成「卡视口」而不是「卡内容」。
    // ⚠️ 量的是页面根节点的 getBoundingClientRect().height，不是 documentElement.scrollHeight
    //    —— 后者在 Taro H5 里恒等于视口高（内层容器才是滚动体），第一次写就因此空过了这条断言。
    push('我的页总高 ≤ 1.8 屏（IA 瘦身成果不许回潮）',
      v.h > 0 && v.vh > 0 && v.h <= v.vh * 1.8, `h=${v.h}px / 上限=${Math.round((v.vh || 0) * 1.8)}px`);
  }

  if (page.id === 'membership' || page.id === 'prefs') {
    push('页面根节点存在', v.pgExists, `pgExists=${v.pgExists}`);
    push('页面不是空白（有真实内容渲染）', v.hasBlank === false, `txtLen<40? hasBlank=${v.hasBlank}`);
    push('D8 底部安全区 ≥ 50px', (v.pgPadBottom || 0) >= 50,
      `paddingBottom=${v.pgPadBottom}px｜页面总高=${v.h}px`);
  }

  if (page.id === 'assistant') {
    push('页面根节点存在', v.pgExists, `pgExists=${v.pgExists}`);
    // 整页模式没有悬浮球可点：如果还渲染出 ai-fab，说明 embedded 分支没生效
    push('整页模式不渲染悬浮球', v.hasFab === false, `hasFab=${v.hasFab}`);
    // 欢迎语必须自己补上（旧逻辑只在点悬浮球时 push），否则进来是一片空白
    push('进来已有欢迎语（不是空白对话页）', (v.msgCount || 0) >= 1 && (v.txtLen || 0) >= 20,
      `msgCount=${v.msgCount} txtLen=${v.txtLen}｜页面总高=${v.h}px`);
  }

  if (page.id === 'library') {
    push('D8 页面根节点存在', v.pgExists, `pgExists=${v.pgExists}`);
    push('D8 底部安全区 ≥ 50px', (v.pgPadBottom || 0) >= 50, `paddingBottom=${v.pgPadBottom}px`);
    // 热点资讯流就在这一页，所以「页里有几条真实条目」也归它管
    push('热点资讯流真的渲染出条目（≥1 张卡片）', (v.newsCards || 0) >= 1, `newsCards=${v.newsCards}`);
    push('首条标题非空', !!(v.firstTitle || '').length, `firstTitle=「${v.firstTitle || ''}」`);
    // B2：摘要里的半截 HTML 是「半修」的典型 —— 数据层已 0 条，但若产物没吃到干净数据就会复现
    push('页面 DOM 里没有「点击查看原文>」残留', v.hasHalfHtml === false, `hasHalfHtml=${v.hasHalfHtml}`);
    // 防「静默回退到线上旧快照」：渲染条数必须等于 dist 烘焙的条数。
    // 若不等，几乎一定是应用走了 gh-pages 兜底分支 —— 那测的就不是本地产物了。
    if (page.id === 'library' && BAKED > 0) {
      push('渲染条数 == dist 烘焙条数（未静默回退线上旧快照）', v.newsCards === BAKED, `渲染 ${v.newsCards} vs dist ${BAKED}`);
    }
  }

  return C;
}

async function main() {
  const asJson = process.argv.includes('--json');
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const pages = onlyArg ? CASES.filter((c) => c.id === onlyArg.slice(7)) : CASES;
  if (!pages.length) {
    console.error('未知页面: ' + onlyArg);
    process.exit(1);
  }
  const chrome = CHROME_CANDIDATES.find((c) => fs.existsSync(c));
  if (!chrome) {
    console.log('SKIP verify:layout-pages —— 本机没有可用的 Chrome，跳过（不影响 CI）');
    process.exit(0);
  }
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.log('FAIL verify:layout-pages —— dist/index.html 不存在，请先 npm run build:h5');
    process.exit(1);
  }
  process.env.CHROME_BIN = chrome;
  fs.mkdirSync(OUTDIR, { recursive: true });
  const initFile = path.join(OUTDIR, '_init.js');
  fs.writeFileSync(initFile, fs.readFileSync(SESSION_STUB, 'utf8'));
  BAKED = bakedItemCount();
  console.log('dist 烘焙热点数据：' + (BAKED > 0 ? BAKED + ' 条' : '⚠️ 缺失或不可解析'));

  const { server, port } = await serveDist();
  const rows = [];
  let failed = 0;
  let pass = 0;

  for (const page of pages) {
    for (const vp of VIEWPORTS) {
      const png = path.join(OUTDIR, `${page.id}-${vp.w}x${vp.h}.png`);
      let v;
      let st;
      try {
        v = await runProbe(port, page, vp, png, initFile);
        st = pngStats(png);
      } catch (e) {
        failed++;
        rows.push({ page: page.id, vp, error: String(e.message || e), checks: [['探针执行', false, String(e.message || e)]], bad: [1] });
        continue;
      }
      const expectPanel = Math.min(vp.w, PANEL_MAX);
      const expectX = Math.round((vp.w - expectPanel) / 2);
      const common = [
        ['容器未塌陷', (v.container?.w || 0) === vp.w, `container=${v.container?.w} 期望 ${vp.w}`],
        ['面板宽度正确', Math.abs((v.panel?.w || 0) - expectPanel) <= 1, `panel=${v.panel?.w} 期望 ${expectPanel}`],
        ['面板水平居中', Math.abs((v.panel?.x || 0) - expectX) <= 1, `panel.x=${v.panel?.x} 期望 ${expectX}`],
        ['页面宽度非 0', (v.page?.w || 0) > 0, `page=${v.page?.w}`],
        ['无横向溢出', (v.scrollW || 0) <= vp.w + 1, `scrollW=${v.scrollW} 期望 <=${vp.w}`],
        ['页面已绘制', !st.whiteScreen, `近白=${(st.nearWhite * 100).toFixed(1)}% 颜色数=${st.distinctColors}`],
        ['开屏已关闭（否则像素判据测的是遮罩）', v.splash === 'no-splash' || v.splashAfter === 'gone', `splash=${v.splash} 之后=${v.splashAfter}`],
        ['测试态生效', v.stubKept === true, `stub=${v.stubKept}`],
        ['路由正确', (v.hash || '').indexOf(page.route.replace(/^#/, '')) >= 0, `hash=${v.hash}`],
        ['只挂载 1 个页面', v.pageCount === 1, `pageCount=${v.pageCount}`]
      ];
      const checks = common.concat(pageChecks(page, v));
      const bad = checks.filter((c) => !c[1]);
      pass += checks.length - bad.length;
      if (bad.length) failed++;
      rows.push({ page: page.id, vp, v, st, checks, bad, png });
    }
  }

  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    console.log('页面        视口        近白/颜色   结论');
    console.log('─'.repeat(72));
    for (const r of rows) {
      if (r.error) {
        console.log(r.page.padEnd(11) + (r.vp.w + 'x' + r.vp.h).padEnd(11) + '—'.padEnd(11) + 'FAIL(探针)');
        continue;
      }
      const st = (r.st.nearWhite * 100).toFixed(1) + '%/' + r.st.distinctColors;
      console.log(r.page.padEnd(11) + (r.vp.w + 'x' + r.vp.h).padEnd(11) + st.padEnd(11) + (r.bad.length ? `FAIL(${r.bad.length})` : 'PASS'));
    }
    console.log('─'.repeat(72));
    console.log('通过 ' + pass + ' / 失败 ' + failed + '（不达标组合）');
    console.log('');
    for (const r of rows) {
      for (const c of r.checks || []) {
        console.log((c[1] ? 'PASS  ' : 'FAIL  ') + r.page.padEnd(9) + String(r.vp.w).padEnd(5) + c[0] + (c[2] ? '  [' + c[2] + ']' : ''));
      }
    }
    console.log('');
    console.log('截图: ' + OUTDIR);
  }

  server.close();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('verify:layout-pages fatal:', e && e.stack);
  process.exit(1);
});
