#!/usr/bin/env node
/**
 * verify-boot-path.mjs —— 首屏**关键路径**门禁（2026-10-30）
 *
 * 背景：2026-10-30 线上实测「用户打开页面 30 秒还卡在骨架屏」。根因查清了，是**两件事叠加**：
 *
 *   ① **投递侧首字节长尾**（平台问题，我们改不了）：
 *      真浏览器网络时间线实测，同一批并行请求里**单个**请求的首字节被卡了
 *      20402ms / 23851ms / 30877ms，而同一批里其余请求只要 0.4–3 秒。
 *      也就是说：**长尾是按请求随机的，不是"整个站都慢"**。
 *
 *   ② **我们自己的 defer 链把第三方 SDK 串在了主包前面**（可以改，已改）：
 *      `defer` 脚本按**文档序**执行 ⇒ src/index.html 里排在 webpack 注入脚本之前的
 *      `assets/wb-sdk.js` 一旦卡住，**整个应用就卡住**（app.js 早就下载完了也不能执行）。
 *      受控实验（用线上那份字节，本地给 SDK 注入 8 秒延迟）：
 *        · 原样（defer）→ 挂载耗时 8823ms
 *        · 改 async      → 挂载耗时 636ms
 *
 * 这道门禁守的就是「不要再把第三方脚本放回 defer 链前面」，以及首屏骨架不许再撒谎。
 *
 * 判据分两层：
 *   A 源码层：SDK 标签的加载语义、SDK 的容错、chunk 失败不整页重载、骨架的状态机。
 *   A' 产物层：dist/index.html 里的真实标签形态 + 首屏引用的资源都存在（缺一个 = 404 白屏）。
 *
 * 用法: node .tools/verify-boot-path.mjs
 * 退出码: 0 = 全绿；1 = 有断言失败；2 = harness 自身出错
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const rows = [];
let pass = 0;
let fail = 0;
function assert(name, cond, detail = '') {
  if (typeof cond !== 'boolean') throw new Error(`断言「${name}」的 cond 不是 boolean：${typeof cond}`);
  rows.push({ name, ok: cond, detail });
  if (cond) pass++;
  else fail++;
}

/** 剥掉 HTML 注释 —— 判据不能把注释当事实（本文件里解释这些坑的注释就写着 defer/async） */
const stripHtmlComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
/** 剥掉 JS 行注释与块注释（同样地，源码注释里就写着这些关键字） */
const stripJsComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/* ───────────── A. 源码层 ───────────── */
const indexHtmlRaw = read('src/index.html');
const indexHtml = stripHtmlComments(indexHtmlRaw);
const cloudAuth = stripJsComments(read('src/services/cloudAuth.ts'));
const appTsx = stripJsComments(read('src/app.tsx'));
const fragRaw = read('src/assets/boot-skeleton.html');
const frag = stripHtmlComments(fragRaw);

/** 取 src/index.html 里那个 SDK 的 <script> 标签 */
function sdkTag(html) {
  const m = html.match(/<script[^>]*wb-sdk\.js[^>]*>/);
  return m ? m[0] : '';
}

// C1：SDK 必须是 async，且**不得**是 defer —— defer 会让它排在主包前面串行等待
const tag = sdkTag(indexHtml);
assert('C1 产物模板里有 SDK 的 script 标签', !!tag, tag);
assert(
  'C2 SDK 标签不是 defer（defer 会把它串行卡在主包前面）',
  !!tag && !/\bdefer\b/.test(tag),
  tag
);
assert('C3 SDK 标签是 async（与主包并行下载，互不阻塞）', !!tag && /\basync\b/.test(tag), tag);
assert(
  'C4 SDK 仍然同源自托管（src 不带外部 URL）',
  !!tag && /src="\.\/assets\/wb-sdk\.js"/.test(tag) && !/https?:\/\//.test(tag),
  tag
);

// C5：SDK 必须有「卡住就重试」的容错 —— 长尾按请求随机，重换一个请求往往就快了
assert(
  'C5 SDK 加载有重注入兜底（网关首字节长尾时重试）',
  /createElement\(\s*['"]script['"]\s*\)/.test(cloudAuth) && /reinjectSdkScript/.test(cloudAuth),
  'cloudAuth.ts 缺 SDK 脚本重注入'
);
assert(
  'C6 SDK 重试带 cache-busting（不能又命中同一个被缓存的坏响应）',
  /r='\s*\+\s*Date\.now\(\)/.test(cloudAuth) || /\+Date\.now\(\)/.test(cloudAuth),
  'cloudAuth.ts 的重注入没有 cache-busting'
);

// C7：chunk 加载失败**不得**在启动期整页重载（会把一次局部抖动放大成重下 900KB）
// ⚠️ 判据必须框到「启动期分支真的在 reload 之前 return」，只查 `BOOT_GRACE_MS` 这个
//    标识符存在是**假判据**：把 `if (inBoot)` 改成 `if (false && inBoot)`，标识符还在，
//    但整页重载又回来了。所以这里比位置与控制流，不比字符串。
const guardIdx = appTsx.indexOf('if (inBoot) {');
const reloadIdx = appTsx.indexOf('window.location.reload()');
const bootBranch = guardIdx >= 0 && reloadIdx > guardIdx ? appTsx.slice(guardIdx, reloadIdx) : '';
assert(
  'C7 chunk 失败处理在启动期提前返回（启动期不整页重载）',
  guardIdx >= 0 && reloadIdx > guardIdx && /\breturn;/.test(bootBranch),
  `guard=${guardIdx} reload=${reloadIdx}`
);
assert(
  'C7b 启动期豁免用 performance.now() 判启动阶段（不能用别的东西猜）',
  /BOOT_GRACE_MS/.test(appTsx) && /performance\.now\(\)/.test(appTsx),
  'src/app.tsx 没有启动期豁免判据'
);

// C8–C13：骨架不许再撒谎
assert(
  'C8 骨架报真实下载进度（performance resource timing）',
  /getEntriesByType\(\s*['"]resource['"]\s*\)/.test(frag),
  '骨架没有取 resource timing'
);
// ⚠️ C9/C10 不能只查 `is-stall` 这个字符串在不在：把 classList.add 改成别的名字、
//   或者把 CSS 选择器改掉，字符串都还在，但状态机已经废了。
//   ⇒ 必须「CSS 里定义了这个状态」且「JS 会真的加上这个状态」两件事同时成立。
assert(
  'C9 骨架有「卡住」态（CSS 定义 + JS 真会加上）',
  frag.includes('#boot-skeleton.is-stall .bs-stall') && frag.includes("classList.add('is-stall')"),
  'is-stall 态没有同时出现在 CSS 与 JS'
);
assert(
  'C10 骨架有「失败」态（CSS 定义 + JS 真会加上）',
  frag.includes('#boot-skeleton.is-fail .bs-fail') && frag.includes("classList.add('is-fail')"),
  'is-fail 态没有同时出现在 CSS 与 JS'
);
assert('C11 骨架保留 10s 慢加载兜底（既有不变量）', frag.includes('is-slow') && frag.includes('10000'), '');
assert(
  'C12 骨架的重试带 cache-busting（重试要能绕开被缓存的坏响应）',
  /r='\s*\+\s*Date\.now\(\)/.test(frag),
  '骨架的重试没有 cache-busting'
);
assert(
  'C13 骨架里不许出现 id="app"（会与真挂载点撞 id）',
  (frag.match(/id="app"/g) || []).length === 0,
  `count=${(frag.match(/id="app"/g) || []).length}`
);

/* ───────────── A'. 产物层 ─────────────
 * ⚠️ 只在「产物是干净构建」时才跑：
 *   产物层断言的是「**这份产物**里有没有」，而 dist 常常落后于源码（改完没重建）。
 *   那样就会变成「改完 src 未重建 ⇒ 必然红」的常红门禁 —— 仓库自己把
 *   verify:deploy-fresh 排除出默认集合正是这个理由（见 verify-all.mjs 的例外表）。
 *   ⇒ 这里按 build-stamp 的 dirty 标记决定：脏构建 ⇒ 跳过并说明原因，不假装通过。
 */
const DIST = path.join(ROOT, 'dist');
const distIndexPath = path.join(DIST, 'index.html');
const stampPath = path.join(DIST, 'build-stamp.json');
let stamp = null;
try {
  stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
} catch {
  stamp = null;
}
const artifactFresh = !!stamp && stamp.dirty === false && !!stamp.head;
if (fs.existsSync(distIndexPath) && artifactFresh) {
  const distHtml = stripHtmlComments(fs.readFileSync(distIndexPath, 'utf8'));
  const dTag = sdkTag(distHtml);
  assert('C14 产物里的 SDK 标签是 async', !!dTag && /\basync\b/.test(dTag) && !/\bdefer\b/.test(dTag), dTag);

  assert(
    'C15 产物里没有残留的进度占位符（copy-assets 没注入成功）',
    !distHtml.includes('__BOOT_TOTAL_BYTES__'),
    'dist/index.html 仍含 __BOOT_TOTAL_BYTES__'
  );

  // 首屏引用的本地资源必须都在（缺一个 = 线上 404 = 白屏）
  const refs = [...distHtml.matchAll(/(?:src|href)="\.?\/?([^"?#]+\.(?:js|css))"/g)].map((m) => m[1]);
  const missing = refs.filter((rel) => {
    const f = path.join(DIST, rel.replace(/^\.?\//, ''));
    return !fs.existsSync(f);
  });
  assert('C16 产物首屏引用的本地 JS/CSS 都存在（缺一个就是线上 404）', missing.length === 0, `missing=${missing.join(',')}`);

  // 首屏**阻塞型**脚本（defer 且不是 async）必须都是 webpack 的 initial chunk。
  // 第三方脚本一旦混进来，它卡住就会把整个应用卡住（2026-10-30 实测 30 秒起）。
  const scriptTags = [...distHtml.matchAll(/<script[^>]*src="([^"]+)"[^>]*>/g)].map((m) => ({ tag: m[0], src: m[1] }));
  const deferScripts = scriptTags.filter((s) => /\bdefer\b/.test(s.tag) && !/\basync\b/.test(s.tag));
  const appIdx = deferScripts.findIndex((s) => /\/js\/app\./.test(s.src));
  const beforeApp = appIdx >= 0 ? deferScripts.slice(0, appIdx) : deferScripts;
  const foreign = beforeApp.filter((s) => !/^\.?\/?js\//.test(s.src));
  assert(
    'C17 主包之前的 defer 链里没有第三方脚本（第三方脚本卡住会把整个应用卡住）',
    foreign.length === 0,
    `foreign=${foreign.map((s) => s.src).join(',')} deferChain=${deferScripts.map((s) => s.src).join(' → ')}`
  );
  assert(
    'C18 首屏阻塞型脚本数 ≤ 3（预算：每多一个就多一次被长尾卡住的机会）',
    deferScripts.length <= 3,
    `deferScripts=${deferScripts.length} [${deferScripts.map((s) => s.src).join(', ')}]`
  );
} else if (!fs.existsSync(distIndexPath)) {
  console.log('（没有 dist：跳过 C14–C18「产物层」断言，构建后再跑）');
} else {
  console.log(
    `（dist 是脏构建或缺指纹（dirty=${stamp ? stamp.dirty : 'n/a'}）：` +
      '跳过 C14–C18「产物层」断言 —— 产物层判的是「这份产物里有没有」，' +
      '拿旧产物判源码会得到必然红的假失败。干净构建后重跑即可。）'
  );
}

console.log('\n首屏关键路径门禁');
for (const r of rows) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  → ' + r.detail}`);
console.log(`\n${fail === 0 ? `PASS ${pass} / FAIL 0（共 ${rows.length} 条）` : `PASS ${pass} / FAIL ${fail}（共 ${rows.length} 条）`}`);
process.exit(fail === 0 ? 0 : 1);
