/**
 * 关联产品入口（「网页版服务」区块）的地址集中配置。
 *
 * 背景：灵犀课堂与省心买都是**独立的成熟产品**，本应用不重写它们，只做入口跳转。
 * 两处地址**故意不同**，因为形态受平台硬约束：
 *
 * - **省心买**是纯静态 PWA，已作为**同源子页**挂在 `/sxm/`（构建期由
 *   `.tools/copy-assets.js` 从 `vendor/shengxinmai/` 拷入，出处见其 PROVENANCE.md）。
 *   所以 H5 端用**相对路径**打开，源码里不需要也不应该出现本应用自己的沙箱域名
 *   —— 那个域名会变、也可能被回收，钉在源码里就是一颗定时炸弹。
 * - **小程序端**统一走「复制链接，由用户自己在浏览器打开」：本仓没有任何 `web-view` 页面，
 *   而微信的 `web-view` 只对企业主体开放，所以小程序内无法内嵌网页。
 *
 * 复制给用户的地址取各自那一套「耐久」的：
 * - 省心买用它的 GitHub Pages —— 上游 `index.html` 自己也把分享卡片钉在这一套上
 *   （理由写在上游注释里：沙箱部署被回收的话，已发出去的分享卡片会一起掉图）。
 * - 灵犀课堂用它当前的 WorkBuddy 发布域。它的旧自定义域
 *   `https://lingxi-class.app.workbuddy.host/` 已实测 404，不要再用。
 */

/** H5：同源子页。显式带 `index.html`，不依赖静态服务的「目录索引」行为。 */
export const SXM_H5_PATH = '/sxm/index.html';

/** 小程序端复制给用户的地址（绝对 URL，耐久） */
export const SXM_DURABLE_URL = 'https://soloassistant.github.io/shengxinmai/';

/** 灵犀课堂当前唯一可用地址（H5 与小程序都用它） */
export const LINGXI_URL = 'https://bb6ae4d03fbd4b109cbbe6dbbc84502d.app.workbuddy.host/';

/**
 * 供 UI 直接使用的「按端解析好」的入口地址。
 *
 * 平台分支集中放在这里，而不是散落在各个页面里 —— 页面不该知道
 * "H5 走同源子页、小程序只能复制外链"这件事，那是配置层的知识。
 * `process.env.TARO_ENV` 是编译期常量，所以两端各自只会留下一个分支。
 */
export const SXM_ENTRY_URL = process.env.TARO_ENV === 'h5' ? SXM_H5_PATH : SXM_DURABLE_URL;
export const LINGXI_ENTRY_URL = LINGXI_URL;
