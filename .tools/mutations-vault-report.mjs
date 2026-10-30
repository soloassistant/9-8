/**
 * mutations-vault-report.mjs —— 证明 verify-vault-report.mjs 的断言有判别力。
 *
 * 契约同其它 mutations-*.mjs：from 在目标文件中**正好出现一次** / 目标文件必须**先提交**
 * （变异框架拒绝变异有未提交改动的文件）/ 基线必须绿 / 变异后必须被抓（FAIL≥1）/ 恢复后字节级一致。
 * 四个目标文件都是零运行时依赖的纯逻辑模块 —— 任何一条变异逃逸 = 对应断言从没红过 = 没写。
 */
export default [
  {
    // VR4：结余公式改成相加 = 用户看到「本周结余 +1300」其实花了 1300（财务口径事故）
    label: '价值周报结余公式 income-expense 改成相加',
    file: 'src/utils/valueReport.ts',
    from: 'ledgerBalance: ledger ? Number((ledger.income - ledger.expense).toFixed(2)) : null,',
    to: 'ledgerBalance: ledger ? Number((ledger.income + ledger.expense).toFixed(2)) : null,',
    cmd: 'node .tools/verify-vault-report.mjs'
  },
  {
    // VR7：0 天被当成有效数据显示（「连续阅读 0 天」这种行出现在报告里 = 编造存在感）
    label: 'positiveOr 的 >0 判据被删（0 也显示）',
    file: 'src/utils/valueReport.ts',
    from: 'return typeof v === \'number\' && Number.isFinite(v) && v > 0 ? v : null;',
    to: 'return typeof v === \'number\' && Number.isFinite(v) ? v : null;',
    cmd: 'node .tools/verify-vault-report.mjs'
  },
  {
    // IC1：分号转义被删 = Outlook/日历.app 把一条日程拆成两条（TEXT 转义是 RFC 硬要求）
    label: 'ics 分号转义被删',
    file: 'src/utils/icsExport.ts',
    from: "    .replace(/;/g, '\\\\;')",
    to: '    .replace(/;/g, \';\')',
    cmd: 'node .tools/verify-vault-report.mjs'
  },
  {
    // IC3：脏时间戳放行 = 导出整个日历文件被一个非法 VEVENT 拖垮（宁少一条不错一条被违反）
    label: 'ics 月/日/时合法性校验被删',
    file: 'src/utils/icsExport.ts',
    from: 'if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 23 || +mi > 59 || +(s || 0) > 59) return null;',
    to: '',
    cmd: 'node .tools/verify-vault-report.mjs'
  },
  {
    // IW4：匹配顺序破坏（记录最后一个命中词而不是第一个）—— 展示上「为什么命中」会撒谎
    label: '关键词匹配记最后一个命中词',
    file: 'src/utils/intelWatch.ts',
    from: '    for (let i = 0; i < lower.length; i += 1) {\n      if (haystack.includes(lower[i])) {\n        out.push({ item, hit: words[i] });\n        break;\n      }\n    }',
    to: '    for (let i = lower.length - 1; i >= 0; i -= 1) {\n      if (haystack.includes(lower[i])) {\n        out.push({ item, hit: words[i] });\n        break;\n      }\n    }',
    cmd: 'node .tools/verify-vault-report.mjs'
  },
  {
    // DV3：版本校验被删 = 老应用吃进未来格式，「尽量恢复」把半成品数据写进用户存储
    label: 'dataVault 版本拒绝被删',
    file: 'src/utils/dataVault.ts',
    from: "  if (obj.version !== VAULT_VERSION) return { ok: false, error: 'version-unsupported' };",
    to: '',
    cmd: 'node .tools/verify-vault-report.mjs'
  },
];
