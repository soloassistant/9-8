/**
 * 跨源合并的「机构归一」口径（共享模块）—— 2026-10-22 新增。
 *
 * 为什么需要（2026-10-22 真实数据校准结论，勿再重复调研）：
 *  对 16 个 RSS 源预配额全量抓取（181 条）实测：归一化标题相等（同题）5 组，
 *  其中 4~5 组的「多源」全是**中新网自己的子 feed 互抄**（财经/社会/即时三个
 *  子频道同一条通稿各发一遍），**跨机构同题 0 组**。
 *  → 若按 feed 名计数，「N 个来源」会把一家通讯社的自抄当成多家媒体佐证 ——
 *    这是**不诚实的产品信号**（用户会读成「多家媒体报道了这事」）。
 *  → 机构归一是 alsoFrom 能诚实展示的前提；同时它也让配额选取受益：
 *    同一通稿不再从中新网三个子 feed 各占一个席位。
 *
 * 放置理由与 news-trust.js 相同：云函数部署只打包自身目录，共享模块必须放在
 * cloudfunctions/webSearch/ 内；.tools/ 两条链路（fetch-data.js / static-server.js）
 * 在本地与 GitHub Actions 的完整仓库里反向 require 是安全的。
 *
 * ⚠️ 本模块只回答「这个来源属于哪家机构」，**不定义「同题怎么判」**：
 *  · 云函数侧（index.js mergeCrossSource）用归一化标题**精确相等**分组 —— 保守，
 *    实测同题信号全部来自精确相等；近重复合并是 static-server 的四通道 isSameEvent
 *    领域（那边有 96 对金色基准集校准，precision 1.000），不在这里另写一套；
 *  · fetch-data.js 用标题前 24 字符（既有口径，本模块不改判定只改佐证计数）。
 *  三条链路的同题判定强度不同是既有事实，强行统一它们不是本模块的职责。
 */

/**
 * 子 feed → 所属机构。
 * ⚠️ 新增「同主体多 feed」源时必须在这里登记，否则互抄会被当成跨机构佐证
 *    （alsoFrom 虚高），且同一通稿会在配额里重复占席。
 */
const FEED_ORG_MAP = {
  '中新网-财经': '中新网',
  '中新网-社会': '中新网',
  '中新网-即时': '中新网'
};

/**
 * 来源名 → 机构名。未登记的来源（绝大多数）原样返回 —— 机构名即来源名。
 * 用 hasOwnProperty 取自有属性：来源名若为 `constructor` 等原型键，
 * 直接下标会读到 Object 原型上的函数（truthy），把机构名变成一个函数对象。
 */
function orgOfSource(name) {
  const s = String(name == null ? '' : name);
  return Object.prototype.hasOwnProperty.call(FEED_ORG_MAP, s) ? FEED_ORG_MAP[s] : s;
}

/** alsoFrom 长度上限（与 src/types/index.ts 的 HotspotNews.alsoFrom 注释对齐） */
const ALSO_FROM_MAX = 8;

module.exports = { FEED_ORG_MAP, orgOfSource, ALSO_FROM_MAX };
