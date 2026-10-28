#!/usr/bin/env node
/**
 * verify-site.mjs —— 官网落地页门禁（2026-10-27）。
 *
 * 落地页有三个特有的失效方式，都不会报错、也不会崩：
 *   ① **色值漂移**：落地页自己写了一套色值，半年后和应用变成两个产品。
 *      这里把 theme.scss 的变量逐条和 site.css 的 :root 比对。
 *   ② **乱承诺**：落地页最容易被写满「一键搞定」「全部自动」。本仓有专门的
 *      绝对句口径（verify:legal），落地页同样适用；另外三条能力边界
 *      （看图提取 / 网页端语音转写 / 编数据）必须写成**否认式**，不能含糊。
 *   ③ **发不出去**：文件在仓库里但没进 dist —— 用户点开 /site/ 是 404，
 *      而本地 `open site/index.html` 一切正常。
 *
 * 用法: node .tools/verify-site.mjs
 * 退出码: 0 = 全绿；1 = 有断言失败；2 = harness 自身出错
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

let pass = 0;
let fail = 0;
function assert(name, cond, detail = '') {
  if (typeof cond !== 'boolean') {
    throw new Error(`断言「${name}」的 cond 不是 boolean，而是 ${typeof cond}：${String(cond)}`);
  }
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ' → ' + detail : ''}`);
  }
}
const section = (t) => console.log(`\n── ${t} ──`);

/**
 * 剥掉注释再判。⚠️ 本仓的 CSS/SCSS 注释里**照抄了被废弃的色值**（说明改动缘由），
 * HTML 注释里还写着「不许出现唯一 / 一键」这类**规则本身**。
 * 不剥注释会把「注释里提到某词」判成「正文里承诺了某词」——
 * 这类假红和假绿一样浪费时间。所以 CSS 与 HTML 的注释都要剥。
 */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const stripHtmlComments = (src) => src.replace(/<!--[\s\S]*?-->/g, '');

/* ================================================================== */
section('A. 文件与自包含（不依赖任何外部 CDN）');

assert('A1 site/index.html 存在', exists('site/index.html'));
assert('A2 site/site.css 存在', exists('site/site.css'));

const html = stripHtmlComments(stripComments(read('site/index.html')));
const css = stripComments(read('site/site.css'));

assert('A3 页面引用了自己的样式表', html.includes('href="./site.css"'));
/* ⚠️ 官网已**独立发布**（自己的子域），页面里必然有一个外部链接：「进入应用」指回应用域名。
   要禁的是外部**资源加载**（会让离线打开和大陆网络都出问题），不是外链导航。 */
const externalResource =
  /(?:^|\s)src\s*=\s*["']https?:\/\//i.test(html) ||
  /<link[^>]+href\s*=\s*["']https?:\/\//i.test(html) ||
  /url\(\s*["']?https?:\/\//i.test(css);
assert('A4 没有任何外部资源加载（离线可看、无 CDN 依赖；外链导航不算）', !externalResource);
assert('A5 没有内联 <script>（静态页，不跑 JS）', !/<script/i.test(html));

/* 应用正式域名只认 cloudAuth.ts 里的 CLOUD_ENDPOINT —— 落地页不许自己再写一份。
   两处各写一个域名，改一处忘一处 = 官网把访客送到一个不存在的站。 */
const appUrl = (() => {
  const m = /const CLOUD_ENDPOINT = '([^']+)'/.exec(read('src/services/cloudAuth.ts'));
  return m ? m[1].replace(/\/+$/, '') : null;
})();
const anchors = [...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)].map((m) => m[1]);
const externalAnchors = anchors.filter((h) => /^https?:\/\//i.test(h));
const toApp = externalAnchors.filter((h) => h === `${appUrl}/`);

assert('A6 能从 cloudAuth.ts 取到应用域名（不在这里另写一份）', !!appUrl, `appUrl=${appUrl}`);
assert(
  `A6b 「进入应用」全部指向 CLOUD_ENDPOINT（外链 ${externalAnchors.length} 个，其中 ${toApp.length} 个正确）`,
  !!appUrl && toApp.length >= 2 && externalAnchors.length === toApp.length,
  `appUrl=${appUrl} 其它外链=${externalAnchors.filter((h) => h !== `${appUrl}/`).join(',') || '无'}`
);
assert(
  'A6c 没有残留 href="../"（独立域名下 ../ 解析到官网自己，点了等于原地刷新）',
  !/href="\s*\.\.\/?\s*"/.test(html)
);
assert('A7 有视口声明（手机上不是缩小的桌面页）', /name="viewport"[^>]*width=device-width/.test(html));
assert('A8 有 description（分享出去不是空白摘要）', /name="description"\s+content="[^"]{20,}"/.test(html));
assert('A9 语言声明为 zh-CN', /<html lang="zh-CN">/.test(html));

/* ================================================================== */
section('B. 色值与应用同源（theme.scss ⇄ site.css）');

const theme = read('src/styles/theme.scss');
const scssVar = (name) => {
  const m = new RegExp(`^\\$${name}:\\s*([^;]+);`, 'm').exec(theme);
  return m ? m[1].trim() : null;
};
const cssVar = (name) => {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(css);
  return m ? m[1].trim() : null;
};

/** 必须一一对应的色值对：scss 变量名 → site.css 变量名 */
const COLOR_PAIRS = [
  ['color-primary', 'brand'],
  ['color-primary-strong', 'brand-strong'],
  ['color-secondary', 'secondary'],
  ['color-gold', 'gold'],
  ['color-bg-page', 'bg-page'],
  ['color-bg-card', 'bg-card'],
  ['color-bg-header', 'bg-header'],
  ['color-bg-hover', 'bg-hover'],
  ['color-text-primary', 'text-primary'],
  ['color-text-secondary', 'text-secondary'],
  ['color-text-tertiary', 'text-tertiary'],
  ['color-border', 'border'],
  ['color-divider', 'divider']
];

const drift = [];
for (const [s, c] of COLOR_PAIRS) {
  const sv = scssVar(s);
  const cv = cssVar(c);
  if (!sv || !cv) {
    drift.push(`${s}/${c}: 取值失败(scss=${sv} site=${cv})`);
    continue;
  }
  if (sv.toLowerCase() !== cv.toLowerCase()) drift.push(`${s}=${sv} ≠ --${c}=${cv}`);
}
assert(
  `B1 ${COLOR_PAIRS.length} 个基础色值逐条一致（改主题色必须两边一起改）`,
  drift.length === 0,
  drift.join('；')
);

/* 强调渐变的两个 stop 最容易只改一边：改了 theme 忘了 site，落地页按钮就成了旧色。 */
const grad = scssVar('gradient-emphasis') || '';
const stops = [...grad.matchAll(/#[0-9a-fA-F]{6}/g)].map((m) => m[0].toLowerCase());
const siteGrad = cssVar('gradient-emphasis') || '';
const siteStops = [...siteGrad.matchAll(/#[0-9a-fA-F]{6}/g)].map((m) => m[0].toLowerCase());
assert(
  'B2 强调渐变的两个色标一致',
  stops.length === 2 && siteStops.length === 2 && stops.every((s, i) => s === siteStops[i]),
  `theme=${stops.join(',')} site=${siteStops.join(',')}`
);

/* 白字压在强调渐变上必须 ≥ 4.5。这条不是审美：换色时最容易忘的就是它。 */
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.substr(i, 2), 16) / 255);
  const l = c.map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2];
};
const ratio = (a, b) => {
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const worstStop = stops.reduce((worst, s) => (ratio(s, '#ffffff') < ratio(worst, '#ffffff') ? s : worst), stops[0] || '#000000');
const worst = stops.length ? Number(ratio(worstStop, '#ffffff').toFixed(2)) : 0;
assert(
  `B3 强调渐变上白字的最差对比度 ${worst}:1 ≥ 4.5（换色时必须重算）`,
  worst >= 4.5,
  `worst stop = ${worstStop}`
);

/* ================================================================== */
section('C. 文案诚实性（能力边界必须写成否认式）');

/** 与本仓 verify:legal 同一口径的绝对句黑名单 */
const ABSOLUTE = ['唯一', '仅需', '一键', '全部自动', '百分之百', '永久免费', '无需配置'];
const absoluteHits = ABSOLUTE.filter((w) => html.includes(w));
assert(
  `C1 没有绝对句（${ABSOLUTE.join(' / ')}）`,
  absoluteHits.length === 0,
  `命中：${absoluteHits.join(',')}`
);

/* 网页端模型通道只收文本（LlmMessage.content 是 string）→ 不能宣称看图提取。
   ⚠️ 判据不能只是「出现某词」：正文里必须能提到这条边界，而「不做截图提取」
   这句话本身就含「截图提取」四个字 —— 纯子串匹配会把**否认**判成**承诺**。
   所以按句子判：含该词的句子里必须有否定词，否则才算正面承诺。 */
const plainText = html
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ');
const POSITIVE_IMAGE_CLAIMS = ['截图提取', '识别截图', '看懂图片', '读图提取', '截图识别'];
const NEGATIONS = /不|没|无法|不支持/;
const positiveImage = [];
for (const sentence of plainText.split(/[。！？；\n]/)) {
  for (const w of POSITIVE_IMAGE_CLAIMS) {
    if (sentence.includes(w) && !NEGATIONS.test(sentence)) {
      positiveImage.push(`「${sentence.trim().slice(0, 40)}」`);
    }
  }
}
assert(
  'C2 没有任何一句在正面宣称「能看图提取」（含该词的句子必须是否认式）',
  positiveImage.length === 0,
  positiveImage.join(' | ')
);
assert(
  'C3 明确写出「不做看图提取」这条边界（不是回避，是否认）',
  html.includes('不做看图提取')
);

/* 语音转写只在小程序端（AiAssistant 里 !isWeapp 提前 return） */
assert('C4 明确写出语音只在小程序端', html.includes('语音只在小程序端'));

/* 数据来源失败要标注 —— 这是本仓的诚实性铁律，落地页也要说 */
assert('C5 写明数据不可信时标注示例、不编内容', html.includes('不会拿内容把版面填满'));

/* 额度是真数：免费档 20 条，来自 mine.subDesc；落地页不许写别的数字 */
assert(
  'C6 语音额度写的是真实的 20 条，且说明订阅后不限次',
  /20\s*条语音/.test(html) && html.includes('不限次')
);

/* 落地页最容易被塞进没有依据的社会证明（用户数、评分、媒体报道）。
   本仓库没有任何真实来源 → 出现就是编的。 */
const SOCIAL_PROOF = ['万用户', '万+', '好评率', '%的用户', '行业第一', '市场份额'];
const proofHits = SOCIAL_PROOF.filter((w) => html.includes(w));
assert('C7 没有编造的社会证明（用户数 / 好评率 / 排名）', proofHits.length === 0, `命中：${proofHits.join(',')}`);

/* ================================================================== */
section('D. 能发出去（构建产物里有它）');

assert('D1 copy-assets 的白名单包含落地页两个文件', (() => {
  const src = read('.tools/copy-assets.js');
  return src.includes("const SITE_FILES = ['index.html', 'site.css']");
})());

/* 配图（2026-10-28 用真实界面截图替换灰色占位）：页面引用的每张图必须真的存在，
   否则上线就是破图 —— 而破图不会报错，只会显示一个空框，比没有还糟。 */
const shotRefs = [...html.matchAll(/src="\.\/(shots\/[^"]+\.png)"/g)].map((m) => m[1]);
assert('D1b 官网配图引用 ≤ 4 张且至少 1 张（发布目录不膨胀）', shotRefs.length >= 1 && shotRefs.length <= 4, `引用了 ${shotRefs.length} 张`);
const missingShots = shotRefs.filter((rel) => !exists(`site/${rel}`));
assert('D1c 页面引用的每张配图在 site/ 下都存在', missingShots.length === 0, `缺：${missingShots.join(',')}`);

if (exists('dist')) {
  assert('D2 dist/site/index.html 存在（构建 + copy-assets 之后）', exists('dist/site/index.html'));
  assert('D3 dist/site/site.css 存在（缺了会变成没有样式的裸 HTML）', exists('dist/site/site.css'));
  if (exists('dist/site/index.html')) {
    const built = read('dist/site/index.html');
    assert('D4 产物里的引用仍是相对路径 ./site.css', built.includes('href="./site.css"'));
  }
} else {
  console.log('  SKIP  dist/ 不存在（还没构建）—— 发布前必须重跑本门禁');
}

/* ================================================================== */
console.log(`\n${'='.repeat(52)}`);
console.log(`官网落地页门禁：${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log('有断言失败 —— 落地页要么和应用不同源，要么承诺了做不到的事，要么发不出去。');
  process.exit(1);
}
console.log('全部通过。');
process.exit(0);
