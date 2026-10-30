// 构建后置：拷贝 tabBar PNG 与品牌素材到产物目录（Taro H5 不执行 config.copy）。
// 用法：node .tools/copy-assets.js [distDir]，默认 dist。
//
// 额外职责（2026-10-09 补）：兜底数据 dist/api/hotspot.json 会被**每次构建清掉**
// （Taro 构建先清空产物目录）。前端兜底链第 3 跳读不到它，就只剩更新的那一跳，
// 而"发布时烘焙的数据会停在打包那一刻"这件事此前只能靠人手动备份/还原 ——
// 实践证据是它在一次构建后真的丢了（见 docs/实施手册-2026-10-09.md）。
// 因此这里在**发现它缺失时**尝试取一份当日数据补回。
// best-effort：失败只告警、绝不抛错，不阻塞构建。
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dist = path.resolve(root, process.argv[2] || 'dist');
const src = path.resolve(root, 'src/assets');

// 可用 HOTSPOT_LIVE_URL 覆盖（测试负路径时指到一个必然失败的地方）
const LIVE_HOTSPOT_URL =
  process.env.HOTSPOT_LIVE_URL || 'https://soloassistant.github.io/9-8/api/hotspot.json';
const HOTSPOT_OUT = path.join(dist, 'api/hotspot.json');

const jobs = [
  { from: path.join(src, 'tabbar-png'), to: path.join(dist, 'assets/tabbar-png') },
  { from: path.join(src, 'logo.png'), to: path.join(dist, 'assets/logo.png') },
  { from: path.join(src, 'share-cover.png'), to: path.join(dist, 'assets/share-cover.png') },
  // 2026-10-14 自托管云服务 SDK：不再从 jsdelivr CDN 拉取（中国大陆常被墙 → 登录不可用）。
  // 同源 ./assets/wb-sdk.js，随产物上线，去掉对外部 CDN 的运行时依赖。
  { from: path.join(src, 'wb-sdk.js'), to: path.join(dist, 'assets/wb-sdk.js') }
];

let copied = 0;
for (const job of jobs) {
  if (!fs.existsSync(job.from)) {
    console.warn('[copy-assets] missing:', job.from);
    continue;
  }
  fs.mkdirSync(path.dirname(job.to), { recursive: true });
  if (fs.statSync(job.from).isDirectory()) {
    fs.mkdirSync(job.to, { recursive: true });
    for (const f of fs.readdirSync(job.from)) {
      if (f.endsWith('.png')) {
        fs.copyFileSync(path.join(job.from, f), path.join(job.to, f));
        copied++;
      }
    }
  } else {
    fs.copyFileSync(job.from, job.to);
    copied++;
  }
}
console.log(`[copy-assets] ${copied} files -> ${dist}`);

// ---------------------------------------------------------------------------
// 「省心买」同源子页：vendor/shengxinmai 的静态白名单 → dist/sxm/
// ---------------------------------------------------------------------------
// 为什么用**显式白名单**而不是整目录拷贝：dist/ 是公开发布目录，多出来的任何文件都会被打包上线。
// 这份清单与上游 server/lib/static-whitelist.js 的 STATIC_WHITELIST 一一对应，
// 作为闸门可以保证 vendor/ 里将来多出的文件（例如 PROVENANCE.md）永远上不了线。
// 出处、指纹与两条"别自作聪明"的规矩见 vendor/shengxinmai/PROVENANCE.md。
const SXM_VENDOR = path.resolve(root, 'vendor/shengxinmai');
const SXM_OUT = path.join(dist, 'sxm');
const SXM_FILES = [
  'index.html',
  'app.js',
  'data.js',
  'styles.css',
  'sw.js',
  'manifest.json',
  'icon.svg',
  'favicon-32.png',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'apple-touch-icon.png',
  'og-image.png'
];

function copySxm() {
  if (!fs.existsSync(SXM_VENDOR)) {
    // 硬失败：这不是"可选兜底"—— 缺了它 /sxm/ 就是个打不开的入口，必须让人看见
    console.error(
      `[copy-assets] FATAL: 缺少 ${SXM_VENDOR} —— /sxm/ 子页会 404。见 vendor/shengxinmai/PROVENANCE.md`
    );
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(SXM_OUT, { recursive: true });
  const missing = [];
  let n = 0;
  let bytes = 0;
  for (const f of SXM_FILES) {
    const from = path.join(SXM_VENDOR, f);
    if (!fs.existsSync(from)) {
      missing.push(f);
      continue;
    }
    fs.copyFileSync(from, path.join(SXM_OUT, f));
    n++;
    bytes += fs.statSync(from).size;
  }
  if (missing.length) {
    console.error(
      `[copy-assets] FATAL: vendor 里缺 ${missing.length} 个白名单文件：${missing.join(', ')}`
    );
    process.exitCode = 1;
    return;
  }
  console.log(`[copy-assets] sxm -> ${SXM_OUT}: ${n} files, ${bytes} B`);
  // 反向报警：vendor 里出现了白名单之外的文件 —— 要么上游漂移了，要么该更新白名单了
  const stray = fs.readdirSync(SXM_VENDOR).filter((f) => !SXM_FILES.includes(f));
  if (stray.length) {
    console.log(`[copy-assets] sxm 未纳入白名单（不会上线，符合预期）: ${stray.join(', ')}`);
  }
}
copySxm();

// ---------------------------------------------------------------------------
// 官网落地页：site/ → dist/site/（2026-10-27）
// ---------------------------------------------------------------------------
// 独立静态页，不进 Taro bundle：落地页要能被单独分享、能被搜索引擎直接读到，
// 而且不该因为改了一句文案就让应用包体积 +N KB。
// 白名单同样是显式的 —— dist/ 是公开发布目录，多一个文件就多一份上线风险。
const SITE_SRC = path.resolve(root, 'site');
const SITE_OUT = path.join(dist, 'site');
const SITE_FILES = ['index.html', 'site.css'];
/** 官网配图（2026-10-28 用真实界面截图替换灰色占位）：只放 png，限 4 个文件防膨胀 */
const SITE_SHOT_DIR = 'shots';

function copySite() {
  if (!fs.existsSync(SITE_SRC)) {
    // 不 FATAL：本地开发/别人的分支未必有 site/。但必须让人看见，否则发布后 /site/ 是 404。
    console.log('[copy-assets] 跳过官网落地页：' + SITE_SRC + ' 不存在');
    return;
  }
  fs.mkdirSync(SITE_OUT, { recursive: true });
  const missing = [];
  let n = 0;
  let bytes = 0;
  for (const f of SITE_FILES) {
    const from = path.join(SITE_SRC, f);
    if (!fs.existsSync(from)) {
      missing.push(f);
      continue;
    }
    fs.copyFileSync(from, path.join(SITE_OUT, f));
    n++;
    bytes += fs.statSync(from).size;
  }
  if (missing.length) {
    // 这里必须 FATAL：index.html 在但 site.css 缺了，落地页会变成**没有样式的裸 HTML**，
    // 比 404 更糟 —— 用户会以为这是产品的真实长相。
    console.error(`[copy-assets] FATAL: site/ 缺白名单文件：${missing.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[copy-assets] site -> ${SITE_OUT}: ${n} files, ${bytes} B`);

  /* 配图（shots/*.png）：页面里 <img src="./shots/x.png">，缺一张就是破图 —— 逐个校验 */
  const shotSrc = path.join(SITE_SRC, SITE_SHOT_DIR);
  if (fs.existsSync(shotSrc)) {
    const shotOut = path.join(SITE_OUT, SITE_SHOT_DIR);
    fs.mkdirSync(shotOut, { recursive: true });
    const pngs = fs.readdirSync(shotSrc).filter((f) => f.toLowerCase().endsWith('.png'));
    if (pngs.length > 4) {
      console.error(`[copy-assets] FATAL: 官网配图 ${pngs.length} 张超过上限 4 张（发布目录不该无限膨胀）`);
      process.exitCode = 1;
      return;
    }
    let sb = 0;
    for (const f of pngs) {
      fs.copyFileSync(path.join(shotSrc, f), path.join(shotOut, f));
      sb += fs.statSync(path.join(shotSrc, f)).size;
    }
    console.log(`[copy-assets] site/shots -> ${shotOut}: ${pngs.length} 张, ${Math.round(sb / 1024)} KB`);
  }

  const stray = fs.readdirSync(SITE_SRC).filter((f) => !SITE_FILES.includes(f) && f !== SITE_SHOT_DIR);
  if (stray.length) {
    console.log(`[copy-assets] site 未纳入白名单（不会上线，符合预期）: ${stray.join(', ')}`);
  }
}
copySite();

/**
 * 兜底数据缺失时补一份 —— best-effort，任何失败都只告警。
 * 只在"文件不存在"时才发起请求，所以正常重复构建不会每次都打网络。
 */
async function ensureHotspotFallback() {
  if (fs.existsSync(HOTSPOT_OUT)) {
    // 存在 ≠ 新鲜（2026-10-12 实测踩坑）：本函数过去只看文件在不在，于是 dist 里那份
    // 线上下载回来的 198 条旧快照被反复原样打包上线 —— 它含 5.1% 的半截 HTML，
    // 而修复后本地抓的 220 条干净数据一直躺在 .tools 里进不了产物。
    // 只告警不阻断：数据保旧比重建失败更糟，但「以为发的是新数据」必须让人看见。
    try {
      const parsed = JSON.parse(fs.readFileSync(HOTSPOT_OUT, 'utf8'));
      const n = Array.isArray(parsed.items) ? parsed.items.length : 0;
      const ageH = Math.round((Date.now() - fs.statSync(HOTSPOT_OUT).mtimeMs) / 3600000);
      console.log(
        `[copy-assets] hotspot fallback: 已在位 ${fs.statSync(HOTSPOT_OUT).size} B` +
          ` / ${n} 条 / 文件年龄 ${ageH}h / 数据 updatedAt=${parsed.updatedAt || '(无)'}`
      );
      if (ageH >= 12) {
        console.warn(
          `[copy-assets] ⚠ hotspot 数据已放置 ${ageH} 小时。若 fetch-data 已跑过，请把新数据复制到 ` +
            `${HOTSPOT_OUT}，否则会把旧快照原样发布上线。`
        );
      }
    } catch (e) {
      console.warn(`[copy-assets] hotspot 已存在但无法解析（${String(e.message || e)}），交由 fallback 处理`);
    }
    return;
  }
  try {
    const res = await fetch(LIVE_HOTSPOT_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    // 先校验是可解析的、并且真的是热点结构，避免把错误页当成数据写进去
    const parsed = JSON.parse(buf.toString('utf8'));
    if (!Array.isArray(parsed.items)) throw new Error('items 不是数组，拒绝落盘');
    fs.mkdirSync(path.dirname(HOTSPOT_OUT), { recursive: true });
    fs.writeFileSync(HOTSPOT_OUT, buf);
    console.log(
      `[copy-assets] hotspot fallback restored: ${buf.length} B, ` +
        `${parsed.items.length} items, updatedAt=${parsed.updatedAt || '(无)'}`
    );
    // ⚠️ 这条路径意味着：**本次构建发的不是本地抓的数据，是线上 gh-pages 此刻的那份**。
    // 而 `taro build --type h5` 会清空 dist，所以每次构建都会走这里 ——
    // 只要 gh-pages 上的数据是旧的（修复没推上去、或定时刷新失败），每次构建都会把旧数据原样上线。
    // 2026-10-12 实测：本地 fetch-data 已修好摘要里的半截 HTML，但 git 不可用、修复没推到 main，
    // gh-pages 仍是修复前的 198 条（5.1% 半截 HTML），而本机 build 把它原样烤进了产物。
    const dataAgeH = Math.round((Date.now() - Date.parse(parsed.updatedAt || '')) / 3600000);
    if (!parsed.updatedAt || !Number.isFinite(dataAgeH) || dataAgeH >= 12) {
      console.warn(
        `[copy-assets] ⚠ 本次构建的热点数据来自线上快照${Number.isFinite(dataAgeH) ? `（已放置 ${dataAgeH} 小时）` : ''}，` +
          `共 ${parsed.items.length} 条。若 .tools/fetch-data.js 的修复尚未提交推送，` +
          `gh-pages 会一直供旧数据，构建也会一直发旧数据 —— 先 commit + push 再重建。`
      );
    }
  } catch (err) {
    console.warn(
      `[copy-assets] hotspot fallback MISSING (${(err && err.message) || err}) ` +
        `-- 离线兜底第 3 跳不可用；手动补： curl.exe -sS ${LIVE_HOTSPOT_URL} -o "${HOTSPOT_OUT}"`
    );
  }
}

ensureHotspotFallback();

// ---- 首屏骨架注入（2026-10-29，审计 P1：冷启动 9.1s 纯白）----
// 为什么在**构建后注入**而不是写进 src/index.html 模板：
//   写成模板后 `taro build` 会卡死（实测三次：10 分钟 / 6.7 分钟 / 4 分钟零产出，
//   把内联 <style> 去掉也照样卡；还原模板后 127 秒即完成）。与其跟 html-webpack-plugin 较劲，
//   不如在产物上做：dist/index.html 就是用户真正拿到的那份，注入后由
//   verify:boot-skeleton 直接验产物（比验模板更接近事实）。
// 片段源在 src/assets/boot-skeleton.html（可 review、可 diff），本函数只负责摆放：
//   <style> → </head> 前；骨架 DOM + watchdog → <div id="app"> 前（保持 #app 为空给 React）。
function injectBootSkeleton() {
  const fragPath = path.join(root, 'src/assets/boot-skeleton.html');
  const indexPath = path.join(dist, 'index.html');
  try {
    const frag = fs.readFileSync(fragPath, 'utf8');
    const html = fs.readFileSync(indexPath, 'utf8');
    if (html.includes('id="boot-skeleton"')) return; // 幂等：重复跑不会插两份
    const m = frag.match(/^\s*<style>[\s\S]*?<\/style>\s*/);
    const styleBlock = m ? m[0] : '';
    const bodyBlock = m ? frag.slice(m[0].length) : frag;
    if (!styleBlock || !bodyBlock.trim()) throw new Error('片段格式不对（缺 <style> 或骨架 DOM）');
    if (!html.includes('</head>')) throw new Error('dist/index.html 里找不到 </head>');
    if (!html.includes('<div id="app">')) throw new Error('dist/index.html 里找不到 <div id="app">');
    const out = html
      .replace('</head>', styleBlock + '</head>')
      .replace('<div id="app">', bodyBlock + '<div id="app">');
    fs.writeFileSync(indexPath, out);
    console.log(`[copy-assets] 首屏骨架已注入 dist/index.html（${styleBlock.length + bodyBlock.length} B）`);
  } catch (e) {
    // 失败只告警不阻塞构建：发布前的 verify:boot-skeleton 会把它拦下来
    console.warn(`[copy-assets] 首屏骨架注入失败：${String((e && e.message) || e)}`);
  }
}

injectBootSkeleton();

// ---- Service Worker（2026-10-30）：把 VERSION 换成构建输入哈希后落盘 ----
// 为什么要单独生成而不是直接拷 src/assets/sw.js：VERSION 变了才触发浏览器更新 SW，
// 而「这次构建的输入有没有变」只有构建脚本知道。用 mtime 或时间戳会让每次构建都失效缓存。
// 失败不阻塞构建：verify:sw 会把它拦下来。
function emitServiceWorker(version) {
  const src = path.join(root, 'src/assets/sw.js');
  const out = path.join(dist, 'sw.js');
  try {
    if (!fs.existsSync(src)) throw new Error('缺 src/assets/sw.js');
    const code = fs.readFileSync(src, 'utf8');
    if (!code.includes("'__BUILD_VERSION__'")) throw new Error('模板里找不到 __BUILD_VERSION__ 占位');
    const v = String(version || '').slice(0, 12) || 'dev';
    fs.writeFileSync(out, code.replace("'__BUILD_VERSION__'", `'${v}'`));
    console.log(`[copy-assets] sw.js 已生成（version=${v}）`);
    return v;
  } catch (e) {
    console.warn(`[copy-assets] sw.js 生成失败：${String((e && e.message) || e)}`);
    return null;
  }
}

// ---- 构建指纹（2026-10-23 补）：把「本次构建用的是哪一版源码」写进 dist ----
// 部署脚本据此判定 `dist` 是否真的对应当前源码。**不能用 mtime 判**：读文件就会改 mtime，
// 内容没变也会误报；git 恢复旧内容时 mtime 变新又会漏报。比内容哈希才靠得住。
// 写入失败不阻塞构建（部署时会退化成 mtime 判据并告警）。
try {
  const { writeStamp } = require('./lib/build-inputs');
  const stamp = writeStamp(dist, root);
  console.log(
    `[copy-assets] build-stamp: ${stamp.inputsHash.slice(0, 12)}… ` +
      `(${stamp.inputCount} 个输入, head=${stamp.head ? stamp.head.slice(0, 7) : 'n/a'})`
  );
  emitServiceWorker(stamp.inputsHash);
} catch (e) {
  console.warn(`[copy-assets] build-stamp 写入失败（部署新鲜度闸会退化为 mtime 判据）：${String((e && e.message) || e)}`);
}
