/**
 * mutations-util.mjs —— 证明 verify-util-logic.mjs 的断言有判别力。
 *
 * 每条把「已修的写法」改回「有缺陷的写法」，`node .tools/verify-util-logic.mjs`
 * 必须由 PASS 变 FAIL。改不红 = 门禁是假绿的。
 *
 * 两条缺陷都是「不报错、不崩溃、功能静默失效」类型 —— 没有变异用例兜着，
 * 下次有人"顺手重构"就会无声退回去。
 */
export default [
  {
    label: 'computeBufferMinutes 退回「初值 0 + Math.min 收缩」（留白分恒 0，buffer 规则失效）',
    file: 'src/utils/schedule.ts',
    from: '  let prevGap: number | null = null;',
    // 关键：初值改成 DEFAULT_EDGE_BUFFER_MINUTES(=0)，后续 Math.min 会把间隔压成 0
    to: '  let prevGap: number | null = DEFAULT_EDGE_BUFFER_MINUTES as unknown as null;',
    cmd: 'node .tools/verify-util-logic.mjs'
  },
  {
    label: 'authorizeWeapp 重新在内部记一次拒绝（一次拒绝计 2 次，降级门槛提前触发）',
    file: 'src/utils/permission.ts',
    // 2026-11-06：锚点随 #84 同步 —— authorizeWeapp 的 catch 里多了
    // 「if (name === 'location') markLocateFailure('blocked');」这一行，
    // 变异意图不变：在同一个 catch 里再记一次拒绝（一次拒绝计 2 次）。
    from: "    console.error('[permission] authorize denied:', name, err);\n    // weapp 一旦拒绝，authorize 不会再弹框 —— 不等 3 次，直接引导 openSetting\n    if (name === 'location') markLocateFailure('blocked');\n    return false;",
    to: "    console.error('[permission] authorize denied:', name, err);\n    // weapp 一旦拒绝，authorize 不会再弹框 —— 不等 3 次，直接引导 openSetting\n    if (name === 'location') markLocateFailure('blocked');\n    recordPermissionResult(name, false);\n    return false;",
    cmd: 'node .tools/verify-util-logic.mjs'
  },
  {
    label: '系统侧撤销退回 unknown（诱导再次拉起系统授权弹窗）',
    file: 'src/utils/permission.ts',
    from: 'return granted ? \'granted\' : record.deniedCount > 0 || record.agreed ? \'denied\' : \'unknown\';',
    to: 'return granted ? \'granted\' : record.deniedCount > 0 ? \'denied\' : \'unknown\';',
    cmd: 'node .tools/verify-util-logic.mjs'
  },
  {
    // 2026-10-26：SDK 的 userPath() 在**发请求前**校验路径并抛 CloudStoragePathError。
    // 原实现把它写在 try 外 → 异常冒到调用方那个没有 catch 的 async 回调 → 点上传毫无反应。
    label: 'uploadAvatar 的 catch 改成重新抛出（userPath 的路径校验异常冒到调用方 → 点上传毫无反应）',
    file: 'src/services/cloudStorage.ts',
    from: "    console.error('[cloudStorage] upload avatar threw:', String((err && (err as Error).message) || err));\n    return { ok: false, reason: 'failed' };",
    to: '    throw err;',
    cmd: 'node .tools/verify-util-logic.mjs'
  },
  {
    label: 'upload 返回 error 时谎称成功（提示「头像已更新」但文件根本没传上去）',
    file: 'src/services/cloudStorage.ts',
    from: "      console.error('[cloudStorage] upload avatar failed:', res.error.code || '', res.error.message || '');\n      return { ok: false, reason: 'failed' };",
    to: '      return { ok: true, path };',
    cmd: 'node .tools/verify-util-logic.mjs'
  },
  {
    label: '小程序端记忆声明改回「同步到你的账号」（虚假告知）',
    file: 'src/store/language.ts',
    from: '记忆仅保存在本机，不会同步到账号',
    to: '记忆保存在本设备，并同步到你的账号以便跨设备延续',
    cmd: 'node .tools/verify-util-logic.mjs'
  },
  {
    label: '数据保存说明改回云端口径（说会自动云端备份）',
    file: 'src/store/language.ts',
    from: '当前微信小程序版本未开放跨设备同步。',
    to: '数据会自动云端备份。',
    cmd: 'node .tools/verify-util-logic.mjs'
  },
  {
    label: '我的页记忆声明不再按端取键（小程序端仍显示「同步到账号」）',
    file: 'src/pages/mine/index.tsx',
    from: "            {process.env.TARO_ENV === 'weapp' ? t('settings.memoryPrivacyWeapp') : t('settings.memoryPrivacy')}",
    to: "            {t('settings.memoryPrivacy')} /* MUT: no per-end copy */",
    cmd: 'node .tools/verify-util-logic.mjs'
  },
  {
    // 行为后果：第 51 笔订单进来时最老一笔掉出窗口 → 回放少一个月，到期日倒退。
    // 哪条变红：J1（只拿到 50 笔）、J2（到期日比全量少 30 天）。
    label: '订阅回放改回 created_at desc 前 50 条（51 笔起少算一个月）',
    file: 'src/services/cloudOrders.ts',
    from: "  return listOwn({ orderBy: 'paid_at', ascending: true });",
    to: "  return listOwn({ orderBy: 'created_at', ascending: false, limit: 50 });",
    cmd: 'node .tools/verify-util-logic.mjs'
  }
];
