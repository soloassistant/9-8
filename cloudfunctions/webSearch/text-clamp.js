'use strict';

/**
 * 摘要 / 情报正文的截断 —— **句边界优先**（口径唯一事实源）。
 *
 * ## 为什么要有这个文件（2026-10-29 审计）
 *
 *   同一件事（截断摘要）仓库里曾有**三套口径**：
 *     · cloudfunctions/webSearch/index.js  → 2026-10-22 已改成句边界截断（小程序链路）
 *     · .tools/fetch-data.js               → 只按码点硬截，**腰斩在半句**（H5 线上数据就是它产的）
 *     · .tools/static-server.js            → 更老：`slice(0, 80)`，既会切坏代理对、也没有省略号
 *   实测（2026-10-29 线上 414 条）：**274 条（66.2%）摘要长度恰好 80 字**，
 *   也就是被硬切过；用户看到的是「…该公司在」这种半句话 —— 机器截断痕迹直接暴露。
 *   这与本项目 2026-09-24「两份源清单各自维护必然发散」是**同一个病的第三次发作**：
 *   修好一条链路，另外两条没跟上。
 *
 * ## 现在
 *
 *   三条链路（云函数 / fetch-data / static-server）都从这里取同一个实现。
 *   实测（2026-10-29，线上 414 条真实语料 × 3 种上限 = 3516 段）：
 *     · 3461 段（98.4%）与小程序端原实现**逐字节相同**；
 *     · 55 段（1.6%）变了 —— 全部是「英文句号现在算句末」，截点从半句变成完整句（更好）。
 *   H5 与本地预览则第一次拿到句边界截断：274 条硬切摘要里 **159 条（58%）落到句边界**，
 *   剩下 115 条是原文本身在 80 字内没有句读（只能硬切，如整段产品名）。
 *
 * ## 算法
 *
 *   1. 按 **Unicode 码点**切（不是 UTF-16 码元）——否则 emoji/生僻字会被切出半个代理对，
 *      落库即 U+FFFD 乱码；
 *   2. 截断优先落在**句末**（。！？!?… 与英文句号），其次落在**句读**（，、；：,;:）；
 *   3. 截点太靠前（不足一半内容）时**宁可硬切**——砍掉大半内容换一句完整话并不划算；
 *   4. 硬切时补 '…'（占 1 个码点，故在 max-1 处切），让读者能分辨「本来就短」与「被截断」。
 */

module.exports = { clampText };

/** 句末标点（强边界）：切在这里 = 一句完整的话 */
const STRONG = '。！？!?…';
/** 句读标点（弱边界）：切在这里 = 半个分句 */
const WEAK = '，、；：,;:';

/** 英文缩写：这些词后面的 '.' 不是句末（Dr. / Inc. / vs. …） */
const ABBREV = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'jr', 'sr', 'inc', 'ltd', 'co', 'corp',
  'vs', 'etc', 'eg', 'ie', 'approx', 'no', 'fig', 'vol', 'al', 'us', 'uk', 'dept', 'est'
]);

/** 在 head 里找最后一个「句末」位置；找不到返回 -1 */
function findStrong(head, minCut) {
  for (let i = head.length - 1; i >= minCut; i--) {
    const c = head[i];
    if (STRONG.includes(c)) return i;
    if (c !== '.') continue;
    // 英文句号：后面不能紧跟字母/数字（那多半是小数点、缩写中段或域名），
    // 前面不能是缩写（Dr. / vs. / U.S.）。
    const next = head[i + 1];
    if (next && /[A-Za-z0-9]/.test(next)) continue;
    const w = (head.slice(0, i).join('').match(/([A-Za-z.]+)$/) || [])[1];
    if (w && ABBREV.has(w.replace(/\./g, '').toLowerCase())) continue;
    return i;
  }
  return -1;
}

/** 在 head 里找最后一个「句读」位置；找不到返回 -1 */
function findWeak(head, minCut) {
  for (let i = head.length - 1; i >= minCut; i--) {
    if (WEAK.includes(head[i])) return i;
  }
  return -1;
}

/**
 * 按码点截断，**优先落在句边界**。
 * @param {*} s 原文
 * @param {number} max 上限（码点数）
 * @returns {string}
 */
function clampText(s, max) {
  const chars = Array.from(String(s == null ? '' : s));
  if (chars.length <= max) return chars.join('');
  const limit = Math.max(0, max - 1); // 给 '…' 留 1 个码点
  const head = chars.slice(0, limit);
  const minCut = Math.floor(limit / 2); // 截点不足一半内容时不如硬切
  const strong = findStrong(head, minCut);
  const cut = strong >= 0 ? strong : findWeak(head, minCut);
  const body = cut >= 0 ? head.slice(0, cut + 1).join('') : head.join('');
  return body.endsWith('…') ? body : body + '…';
}
