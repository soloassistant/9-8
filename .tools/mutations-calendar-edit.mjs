// 变异用例：日程编辑（缺陷「日历事件没有办法修改」，harness: .tools/verify-calendar-edit.js）
// 每个 from 都必须在目标文件里**正好出现一次**（工具会断言）。
export default [
  {
    label: '本地编辑不做回读校验（storage 写失败也报成功）',
    file: 'src/data/dailyPlan.ts',
    from: '  const check = readPlan().events.find((e) => e.id === id);\n  if (!check) return { ok: false, reason: \'not_persisted\' };',
    to: '  const check = hit; /* MUT: no read-back */\n  if (!check) return { ok: false, reason: \'not_persisted\' };',
    cmd: 'node .tools/verify-calendar-edit.js'
  },
  {
    label: 'H5 编辑不走本地持久化（落到云分支）',
    file: 'src/services/api.ts',
    from: '  if (!isWeapp) {\n    return updateEvent(payload.id, {',
    to: '  if (false) { /* MUT: skip local path */\n    return updateEvent(payload.id, {',
    cmd: 'node .tools/verify-calendar-edit.js'
  },
  {
    label: '小程序编辑丢弃备注（备注永远改不了）',
    file: 'cloudfunctions/chat/index.js',
    from: '        if (item.hasNote) update.note = item.note ? item.note : _.remove();',
    to: '        /* MUT: drop note */',
    cmd: 'node .tools/verify-cloudfunctions-flow.mjs'
  },
  {
    label: '云函数返回的 _id 不再归一成 id（小程序编辑找不到条目）',
    file: 'src/services/api.ts',
    from: "    return row._id ? { ...row, id: row._id } : row;",
    to: '    return row; /* MUT: no id mapping */',
    cmd: 'node .tools/verify-calendar-edit.js'
  }
];
