#!/usr/bin/env node
/**
 * check-bundle-markers.js —— 确认本轮改动真的打进了 dist 产物。
 *
 * 为什么需要：改了 src/ 只说明源码对；产物没重建、或重建了但被 tree-shaking /
 * 压缩吃掉，页面上照样是旧行为。判据只能是**产物里搜得到标记**。
 *
 * 用法: node .tools/check-bundle-markers.js
 * 退出码: 0 = 全部命中；1 = 有标记缺失
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const JS_DIR = path.join(ROOT, 'dist', 'js');

// 取最新构建的 app bundle（文件名带内容 hash，按 mtime 排序最稳）
const cands = fs
  .readdirSync(JS_DIR)
  .filter((f) => /^app\..*\.js$/.test(f))
  .map((f) => ({ f, t: fs.statSync(path.join(JS_DIR, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t);

if (!cands.length) {
  console.log('FAIL dist/js 下找不到 app.*.js，请先 npm run build:h5');
  process.exit(1);
}

const bundle = cands[0].f;
const src = fs.readFileSync(path.join(JS_DIR, bundle), 'utf8');
console.log(`产物: js/${bundle}  ${src.length} B\n`);

/** 源码文本：**只给「产物里按设计就不该存在」的判据用**。
 *  典型是裸语句形式的 console.*（见下方「外链拒绝日志」那条）——
 *  config/prod.ts 的 terser `pure_funcs` 会把它们整条删除，去产物里搜必然 MISS，
 *  那是判据写错了，不是修复丢了。这类判据要么改成搜产物里的**守卫函数**，
 *  要么（像这条）退到源码层核对，并在标签里写明原因。 */
const externalLinkSrc = fs.readFileSync(path.join(ROOT, 'src', 'utils', 'externalLink.ts'), 'utf8');

/** 把「i18n 键在产物里出现过」拆成两件不同的事（2026-10-12 踩过）：
 *   · **字典条目** `"briefing.degraded":"当前为演示数据…"` —— 只证明翻译表里有这条
 *   · **调用点**   `…?le("briefing.degraded"):…`              —— 才证明页面真的消费了它
 * 搜中文文案/键名两边都会命中，于是「加了文案但没接线」会被判成 IN —— 假通过。
 * 这两个判据按**分隔符形态**区分，与压缩后的函数名（le/t/u…）无关，改构建也不会失效。 */
const esc = (key) => key.replace(/\./g, '\\.');
const dictEntries = (key) => (src.match(new RegExp(`"${esc(key)}"\\s*:`, 'g')) || []).length;
const callSites = (key) => (src.match(new RegExp(`[,(]\\s*"${esc(key)}"\\s*[),]`, 'g')) || []).length;

const marks = [
  // ⚠️ 探针必须按**压缩后**的形态写。2026-10-12 踩过两次：
  //   ① 源码里的模板串 `${id.slice(0,2)}***${id.slice(-2)}` 会被压成
  //      `.concat(U.slice(0,2),"***").concat(U.slice(-2))` —— 按 `slice(0,2)}***` 搜必然 MISS；
  //   ② 更糟的是把 `.slice(0,2)` 和 `***` 分成两个独立 includes 判断 ——
  //      两者各自都在别处出现，于是判成 IN，**假通过**。
  //   所以每条都写成一条能唯一命中该语义的连续片段。
  ['昵称兜底为「晨友」（不再回落 id 片段）', /maskIdentifier\([A-Za-z_$][\w$]*\)\|\|\s*["']晨友["']/.test(src)],
  ['数字 id 走脱敏 slice(0,2)+***', /slice\(0,\s*2\)\s*,\s*["']\*\*\*["']/.test(src)],
  // 定位合规表述（本轮）
  ['授权文案已含「第三方地图服务」', /第三方地图服务/.test(src)],
  ['location 出境事实已进注释', /个人信息出境|不落库/.test(src)],
  // 摘要截断（本轮）
  ['省略号常量 …', src.includes('…')],
  // 免责声明按档位（本轮）
  ['i18n common.disclaimerAI', src.includes('common.disclaimerAI')],
  ['中性免责文案', src.includes('仅供参考，不构成任何投资建议')],
  // 登录页同意（本轮）
  ['i18n auth.privacyNotice', src.includes('auth.privacyNotice')],
  ['同意勾选文案', src.includes('我已阅读并同意上述隐私说明')],
  // 外链白名单（本轮）
  ['外链协议白名单', src.includes('isSafeExternalUrl')],
  // ⚠️ 这条判据**不能**搜产物：`console.warn('[externalLink] 拒绝非 http(s) 外链：'…)`
  //    是裸语句，会被 config/prod.ts 的 terser `pure_funcs` 整条删掉。
  //    （2026-10-12 复核：标签从「外链拒绝日志」在产物里 MISS → 先确认过是判据老了，
  //      不是修复丢了；产物里能证明该语义的是**守卫函数**本身，由上一行
  //      `isSafeExternalUrl` 覆盖。）故此处退到源码层核对，并保留产物层那句作为
  //    「pure_funcs 确实在生效」的**反向**观测。
  ['外链拒绝日志（源码在、产物里按设计被 pure_funcs 剥离）', /拒绝非 http/.test(externalLinkSrc) && !/拒绝非 http/.test(src)],
  // 日期显示（本轮）
  ['更新时间格式 MM-DD HH:mm', src.includes('MM-DD HH:mm')],
  // ── UI / 增长修复（2026-10-12 第二批）────────────────────────────────
  // 这批里能靠几何断言证明的（resize:none / 底部 padding / 源名截断 / 快捷指令渐隐）
  // 由 verify-layout-pages.mjs 在**渲染后**验证，比这里搜字符串强得多。
  // 这里只补「几何探针覆盖不到」的两条纯文案/纯逻辑：
  ['i18n library.dataSourcesMore（源名「等 N 个」）', callSites('library.dataSourcesMore') >= 1],
  ['i18n briefing.emptyCta（空态可点 CTA 文案）', callSites('briefing.emptyCta') >= 1],
  // 降级链路要的是「调用点存在」，不是「字典里有这条」——
  // 2026-10-12 实测：briefing.degraded 两个语言都定义了却零消费，搜文案会判成 IN。
  ['降级文案在翻译表里（中英各一条）', dictEntries('briefing.degraded') >= 2],
  ['降级文案真的被空态消费（不是孤儿键）', callSites('briefing.degraded') >= 1],
  ['收藏配额错误码 collection-quota-exceeded', src.includes('collection-quota-exceeded')],
  ['生产态文案「支付功能即将开放」', src.includes('支付功能即将开放')]
];

let bad = 0;
for (const [name, hit] of marks) {
  if (!hit) bad++;
  console.log(`${hit ? 'IN  ' : 'MISS'}  ${name}`);
}
console.log(`\n${bad === 0 ? 'ALL MARKERS PRESENT' : bad + ' MISSING'}`);
process.exit(bad === 0 ? 0 : 1);
