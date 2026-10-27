/**
 * mutations-site.mjs —— 证明 verify-site.mjs 的断言有判别力（2026-10-27）。
 *
 * 落地页的三类缺陷都属于「看起来没问题」：色值悄悄漂移、文案悄悄变成做不到的承诺、
 * 文件悄悄没进 dist。改完都不会报错，只有用户打开页面才会发现。
 *
 * 每一条把「已经做对的事」改回「常见的偷懒写法」，`node .tools/verify-site.mjs`
 * 必须由 PASS 变 FAIL。改不红 = 门禁是假绿的。
 */
import fs from 'node:fs';

/** 应用域名从 cloudAuth.ts 读 —— 变异这里再写死一份，域名换了这条会静默失效（假绿） */
const APP = (() => {
  const src = fs.readFileSync(new URL('../src/services/cloudAuth.ts', import.meta.url), 'utf8');
  const m = /const CLOUD_ENDPOINT = '([^']+)'/.exec(src);
  return m ? m[1].replace(/\/+$/, '') : 'https://example.invalid';
})();

export default [
  {
    label: '落地页的 brand 色值自己改了一个（半年后与应用变成两个产品）',
    file: 'site/site.css',
    from: '--brand: #ff7a45;',
    to: '--brand: #ff6a35;',
    cmd: 'node .tools/verify-site.mjs'
  },
  {
    label: '强调渐变只改了 theme.scss、site.css 留在旧值（落地页按钮是过期的色）',
    file: 'site/site.css',
    from: '--gradient-emphasis: linear-gradient(135deg, #c7371a 0%, #a82c13 100%);',
    to: '--gradient-emphasis: linear-gradient(135deg, #c7371a 0%, #ff7a45 100%);',
    cmd: 'node .tools/verify-site.mjs'
  },
  {
    label: '渐变末端换回旧亮橙（白字对比度掉到 2.59，按钮字读不清）',
    file: 'src/styles/theme.scss',
    from: '$gradient-emphasis: linear-gradient(135deg, #c7371a 0%, #a82c13 100%);',
    to: '$gradient-emphasis: linear-gradient(135deg, #c7371a 0%, #ff7a45 100%);',
    cmd: 'node .tools/verify-site.mjs'
  },
  {
    label: '文案写「一键」（本仓绝对句黑名单里的词，落地页最容易被塞进去）',
    file: 'site/index.html',
    from: '<h2>三件事，每天都会用到</h2>',
    to: '<h2>三件事，一键搞定</h2>',
    cmd: 'node .tools/verify-site.mjs'
  },
  {
    label: '把「不假装看懂图片」改成「支持识别截图」（模型通道只收文本，这是假承诺）',
    file: 'site/index.html',
    from: '<b>不假装看懂图片。</b>网页端的模型通道只收文本，所以不做截图提取。',
    to: '<b>支持识别截图。</b>网页端的模型通道会帮你读懂图片内容。',
    cmd: 'node .tools/verify-site.mjs'
  },
  {
    label: '删掉「语音只在小程序端」（网页端没有转写，不说明就等于暗示有）',
    file: 'site/index.html',
    from: '<b>语音只在小程序端。</b>网页端没有转写能力，也就不会消耗你的语音额度 ——',
    to: '<b>语音随时可用。</b>网页端一样能说话，也不会消耗你的语音额度 ——',
    cmd: 'node .tools/verify-site.mjs'
  },
  {
    label: 'copy-assets 白名单少写 site.css（发布出没有样式的裸 HTML，比 404 更糟）',
    file: '.tools/copy-assets.js',
    from: "const SITE_FILES = ['index.html', 'site.css'];",
    to: "const SITE_FILES = ['index.html'];",
    cmd: 'node .tools/verify-site.mjs'
  },
  {
    label: '「进入应用」改回相对路径 ../（官网独立域名下它指向官网自己，点了等于原地刷新）',
    file: 'site/index.html',
    from: `<a class="btn btn-primary" href="${APP}/">进入应用</a>`,
    to: '<a class="btn btn-primary" href="../">进入应用</a>',
    cmd: 'node .tools/verify-site.mjs'
  },
  {
    label: '应用域名换过、落地页还写旧域名（改一处忘一处，访客被送到不存在的站）',
    file: 'site/index.html',
    from: `<a href="${APP}/">进入应用</a>`,
    to: '<a href="https://old-endpoint.app.workbuddy.host/">进入应用</a>',
    cmd: 'node .tools/verify-site.mjs'
  }
];
