/**
 * mutations-topic-cluster.mjs —— 证明 verify-topic-cluster.mjs 有判别力（2026-11-03）。
 * 契约同其它 mutations-*.mjs：from 正好出现一次 / 目标必须先提交 / 恢复后字节级一致。
 */
export default [
  {
    // 判定恒真 = 把所有标题合成一个话题，用户本该看到的新闻全部消失（最严重的误合并）
    label: '同事件判定恒真（全合并）',
    file: 'cloudfunctions/webSearch/topic-cluster.js',
    from: 'function isSameEvent(aKey, bKey, aTokens, bTokens) {',
    to: 'function isSameEvent(aKey, bKey, aTokens, bTokens) { return true;',
    cmd: 'node .tools/verify-topic-cluster.mjs'
  },
  {
    // 同机构自抄被当成多家媒体佐证 —— 不诚实的产品信号（cross-source.js 2026-10-22 校准结论）
    label: '同机构也被算进 alsoFrom（虚高佐证）',
    file: 'cloudfunctions/webSearch/topic-cluster.js',
    from: "      if (org && org !== orgOf(g.main.source) && g.alsoFrom.length < maxAlsoFrom && !g.alsoFrom.includes(org)) {",
    to: "      if (org && g.alsoFrom.length < maxAlsoFrom && !g.alsoFrom.includes(org)) {",
    cmd: 'node .tools/verify-topic-cluster.mjs'
  },
  {
    // 跨天同题被合并 = 吞掉事件的新进展（第二天的报道是最该被看到的）
    label: '跨天同题也被合并',
    file: 'cloudfunctions/webSearch/topic-cluster.js',
    from: "      if (di && dj && di !== dj) continue;",
    to: '',
    cmd: 'node .tools/verify-topic-cluster.mjs'
  },
];
