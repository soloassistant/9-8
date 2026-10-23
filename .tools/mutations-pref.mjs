// 变异用例：H5 客户端偏好选位（harness: .tools/verify-pref-select.js）
// from 必须在目标文件里**正好出现一次**（工具会断言）。
export default [
  {
    // 直接忽略偏好：这样「科学/文化」选项又变成"能点但没效果"
    label: 'selectByPreference 忽略偏好，直接按时间倒序取前 N 条',
    file: 'src/utils/prefSelect.ts',
    from: '  if (!prefTags.length) return sorted.slice(0, max);',
    to: "  if (!prefTags.length) return sorted.slice(0, max);\n  return sorted.slice(0, max); // 变异：忽略偏好",
    cmd: 'node .tools/verify-pref-select.js'
  },
  {
    // 放开单源配额：高产源会连占全部席位，「今日情报」的观感塌成一个媒体
    label: '去掉每源上限（高产源连占全部席位）',
    file: 'src/utils/prefSelect.ts',
    from: '  const maxPerSource = opts.maxPerSource ?? MAX_ITEMS_PER_SOURCE;',
    to: '  const maxPerSource = opts.maxPerSource ?? Infinity; // 变异',
    cmd: 'node .tools/verify-pref-select.js'
  },
  {
    // 去掉收尾排序：偏好条目未必出现在最前面 —— 用户体感就是"没生效"
    label: '去掉收尾排序（偏好条目不置前）',
    file: 'src/utils/prefSelect.ts',
    from: '  const prefSet = new Set(hitTags);',
    to: '  const prefSet = new Set(); // 变异：不置前\n  if (prefSet.size < 0) new Set(hitTags);',
    cmd: 'node .tools/verify-pref-select.js'
  },
  {
    // 函数写好了但没人调 —— 这类"死代码"在本项目反复出现，必须守
    label: 'getBriefing 改回 slice(0, 3) 硬切（偏好不再参与）',
    file: 'src/services/cloud.ts',
    from: '          const picked = selectByPreference(hotspot.items, prefs, 3)',
    to: '          const picked = hotspot.items.slice(0, 3)',
    cmd: 'node .tools/verify-pref-select.js'
  },
  {
    // 删掉初始排序：夹具本身就是按时间倒序存的，所以**必须**靠"打乱输入"那条断言才抓得住
    // （2026-10-23 补断言时发现：只靠原顺序断言，这个变异是 NOT-CAUGHT 的假绿）。
    label: '删掉全池初始排序（入参顺序直接当选位结果）',
    file: 'src/utils/prefSelect.ts',
    from: '  const sorted = pool.slice().sort((a, b) => itemTs(b) - itemTs(a));',
    to: '  const sorted = pool.slice(); // 变异：不排序',
    cmd: 'node .tools/verify-pref-select.js'
  }
];
