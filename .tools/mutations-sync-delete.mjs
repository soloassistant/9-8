// 变异用例：删除跨端同步（缺陷 B3，harness: .tools/verify-sync-delete.mjs）
// 每个 from 都必须在目标文件里**正好出现一次**（工具会断言）。
export default [
  {
    label: 'forced 删除不再写墓碑（删除只在本机生效）',
    file: 'src/services/cloudSync.ts',
    from: "      items.push({ key: `${k}${TOMBSTONE_SUFFIX}`, value: ts, ts });",
    to: '      /* MUT: no tombstone */',
    cmd: 'node .tools/verify-sync-delete.mjs'
  },
  {
    label: '接收端忽略墓碑（另一端旧数据复活）',
    file: 'src/services/cloudSync.ts',
    from: '      const base = row.key.slice(0, -TOMBSTONE_SUFFIX.length);',
    to: '      const base = row.key.slice(0, -TOMBSTONE_SUFFIX.length); continue; /* MUT: ignore tombstone */',
    cmd: 'node .tools/verify-sync-delete.mjs'
  },
  {
    label: '推送后用 Date.now() 抬高 meta（墓碑被当成过旧而跳过）',
    file: 'src/services/cloudSync.ts',
    from: '      meta[it.key] = Math.max(Number(meta[it.key]) || 0, it.ts);',
    to: '      meta[it.key] = Date.now(); /* MUT: advance meta to now */',
    cmd: 'node .tools/verify-sync-delete.mjs'
  }
];
