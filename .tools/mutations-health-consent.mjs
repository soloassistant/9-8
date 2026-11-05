// 变异用例：撤回健康同意后停止上传运动轨迹（2026-11-04，P0）
// harness: .tools/verify-health-consent.mjs
// 每个 from 都必须在目标文件里**正好出现一次**（工具会断言）。
export default [
  {
    label: '撤回时不再把 sportRuns 摘出同步范围（轨迹继续上云）',
    file: 'src/services/healthConsent.ts',
    from: '  setSyncKeyExcluded(SPORT_SYNC_KEY, true);',
    to: '  /* MUT: exclusion removed */',
    cmd: 'node .tools/verify-health-consent.mjs'
  },
  {
    label: 'collectLocal 打包时不再跳过被排除键',
    file: 'src/services/cloudSync.ts',
    from: '    if (runtimeExcludedKeys.has(k)) continue;',
    to: '    /* MUT: no exclusion in collect */',
    cmd: 'node .tools/verify-health-consent.mjs'
  },
  {
    label: '删除云端副本时不再真删（只查一次，假装删掉）',
    file: 'src/services/cloudDb.ts',
    from: "  const res = await db.from('user_kv').delete().in('key', keys);",
    to: "  const res = await db.from('user_kv').select('key'); /* MUT: no delete */",
    cmd: 'node .tools/verify-health-consent.mjs'
  },
  {
    label: '删除失败不再排队重试（失败被静默丢掉）',
    file: 'src/services/cloudSync.ts',
    from: '  await flushPendingPurges();',
    to: '  /* MUT: no retry */',
    cmd: 'node .tools/verify-health-consent.mjs'
  },
  {
    label: '同意弹窗不再按端选文案（小程序端沿用「同步到云端备份」）',
    file: 'src/services/healthConsent.ts',
    from: "  const body = process.env.TARO_ENV === 'weapp' ? t('health.consentBodyWeapp') : t('health.consentBody');",
    to: "  const body = t('health.consentBody'); /* MUT: no per-end copy */",
    cmd: 'node .tools/verify-health-consent.mjs'
  },
  {
    label: '小程序端同意文案改回「同步到云端备份」',
    file: 'src/store/language.ts',
    from: '当前小程序端不会上传云端',
    to: '并同步到云端备份',
    cmd: 'node .tools/verify-health-consent.mjs'
  },
  {
    label: '撤回弹窗不再按端选文案（小程序端沿用「云端副本将被删除」）',
    file: 'src/services/healthConsent.ts',
    from: "      content: process.env.TARO_ENV === 'weapp' ? t('health.withdrawBodyWeapp') : t('health.withdrawBody'),",
    to: "      content: t('health.withdrawBody'), /* MUT: no per-end copy */",
    cmd: 'node .tools/verify-health-consent.mjs'
  },
  {
    label: '小程序端撤回文案改回「云端副本将被删除」',
    file: 'src/store/language.ts',
    from: '没有云端副本需要删除',
    to: '云端副本将被删除',
    cmd: 'node .tools/verify-health-consent.mjs'
  }
];
