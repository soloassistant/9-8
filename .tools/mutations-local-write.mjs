// 变异用例：X8 本地写失败吞提示（harness: .tools/verify-local-write.js）
export default [
  {
    label: '账本 addEntry 忽略写盘结果（失败也返回条目）',
    file: 'src/data/ledger.ts',
    from: '  if (!writeRaw(LEDGER_KEYS.entries, [entry, ...list])) return null;\n  return entry;',
    to: '  writeRaw(LEDGER_KEYS.entries, [entry, ...list]); /* MUT */\n  return entry;',
    cmd: 'node .tools/verify-local-write.js'
  },
  {
    label: '收藏删除失败时仍返回内存列表（刷新后复活）',
    file: 'src/data/collectionStore.ts',
    from: "    console.warn('[collectionStore] remove failed:', err);\n    return null;",
    to: "    console.warn('[collectionStore] remove failed:', err);\n    return next; /* MUT */",
    cmd: 'node .tools/verify-local-write.js'
  },
  {
    label: '购物清单 save 吞掉失败恒返回 true',
    file: 'src/data/shopping.ts',
    from: "    console.warn('[mock:shopping] save failed:', err);\n    return false;",
    to: "    console.warn('[mock:shopping] save failed:', err);\n    return true; /* MUT */",
    cmd: 'node .tools/verify-local-write.js'
  },
  {
    label: '收藏页无视写失败（照常显示已删除）',
    file: 'src/pages/library/index.tsx',
    from: '        if (!next) {',
    to: '        if (false) { /* MUT */',
    cmd: 'node .tools/verify-local-write.js'
  },
  {
    label: '转存购物清单改回 H5 本地 mock（小程序端条目消失）',
    file: 'src/pages/inbox/index.tsx',
    from: 'shoppingHits.map((s) => apiShoppingAdd({ name: s.title.slice(0, 30) }).catch(() => null))',
    to: 'shoppingHits.map((s) => Promise.resolve({ id: s.title, name: s.title })) /* MUT */',
    cmd: 'node .tools/verify-local-write.js'
  }
];
