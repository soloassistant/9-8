/**
 * mutations-source-prefs.mjs —— 证明 verify-source-prefs.mjs 有判别力（2026-11-02）。
 * 契约同其它 mutations-*.mjs：from 正好出现一次 / 目标必须先提交 / 恢复后字节级一致。
 */
export default [
  {
    // 下限保护被删 = 用户可以把 48 个源全关掉，第二天打开热点页一片空白，以为是故障
    label: '下限保护被删（可把源全关光）',
    file: 'src/utils/sourcePrefs.ts',
    from: "    if (enabledCount < MIN_ENABLED_SOURCES) return { ok: false, reason: 'min_keep' };",
    to: '',
    cmd: 'node .tools/verify-source-prefs.mjs'
  },
  {
    // 过滤只看关没关，不看条目 source —— 等于开关点了没效果（最隐蔽的假实现）
    label: '过滤失效（开关点了不生效）',
    file: 'src/utils/sourcePrefs.ts',
    from: "  return items.filter((it) => !(it && typeof it.source === 'string' && disabled.includes(it.source)));",
    to: '  return items.filter(() => true);',
    cmd: 'node .tools/verify-source-prefs.mjs'
  },
];
