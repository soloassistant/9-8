// 变异用例：换账号隔离（缺陷 B1，harness: .tools/verify-account-isolation.mjs）
// 每个 from 都必须在目标文件里**正好出现一次**（工具会断言）。
export default [
  {
    label: '关掉 owner 一致性判断（回到「不看归属直接推」）',
    file: 'src/services/cloudSync.ts',
    from: '  return !!sessionOwner && !!localOwner && localOwner !== sessionOwner;',
    to: '  return false; /* MUT: owner mismatch ignored */',
    cmd: 'node .tools/verify-account-isolation.mjs'
  },
  {
    label: '换账号时不再隔离旧数据（A 的数据留在本机被推给 B）',
    file: 'src/services/cloudSync.ts',
    from: '    const q = quarantineLocalPii(prevOwner);',
    to: '    const q = { quarantineKey: "", keys: 0 }; /* MUT: no quarantine */',
    cmd: 'node .tools/verify-account-isolation.mjs'
  },
  {
    label: '推送后不再校验 owner（飞行期间切号仍写确认记录）',
    file: 'src/services/cloudSync.ts',
    from: `        '[cloudSync] push aborted: 会话账号在上传过程中变化（',
        sessionOwner,
        '→',
        afterOwner,
        '），本次不写本地确认记录'
      );
      return;`,
    to: `        '[cloudSync] push aborted: 会话账号在上传过程中变化（',
        sessionOwner,
        '→',
        afterOwner,
        '），本次不写本地确认记录'
      );
      /* MUT: no return */`,
    cmd: 'node .tools/verify-account-isolation.mjs'
  },
  {
    // 缺陷 X5：取消 512KB 预筛后，超限键会再次被服务端静默丢弃。
    label: '取消单键 512KB 预筛',
    file: 'src/services/cloudSync.ts',
    from: '    if (bytes > KV_VALUE_LIMIT) oversized.push({ key: it.key, bytes });',
    to: '    if (false) oversized.push({ key: it.key, bytes }); /* MUT: no size filter */',
    cmd: 'node .tools/verify-account-isolation.mjs'
  },
  {
    // 缺陷 X5：跳过上传但不提示 = 又是一次静默。
    label: '超限时不落提示（用户无从知晓）',
    file: 'src/services/cloudSync.ts',
    from: '  if (oversized.length > 0) recordOversize(oversized);',
    to: '  /* MUT: no oversize notice */',
    cmd: 'node .tools/verify-account-isolation.mjs'
  }
];
