/**
 * mutations-legal.mjs —— verify:legal 的判别力自检
 *
 * 每条变异的 `label` 都对应**上一轮真实发生过的一种错**（不是编出来的假想缺陷）。
 * 判据：把错改回去 ⇒ 门禁必须红（退出码 1）。一条抓不住，就说明那条断言没有判别力。
 *
 * ⚠️ 这些变异只改**文本与调用顺序**，不改业务逻辑 —— 为的是证明门禁盯着的是
 * 「这条链路上这个调用到底有没有发生」，而不是「仓库里有没有这个字符串」。
 */
export default [
  /* ---------------- 取证方法类错误 ---------------- */
  {
    // 这就是上一轮的原错：只在小程序端成立的过滤，被当成全端成立。
    // 哪条变红：B4 内容安全过滤句必须按端限定。
    label: '内容安全改回无条件「我们对 AI 输出进行安全过滤」（H5 端不成立）',
    file: 'src/data/legal.ts',
    from: '5. 内容安全：小程序端的 AI 输入与输出会经微信内容安全接口（msgSecCheck）过滤，网页端当前仅依赖大模型服务自身的合规策略、尚未接入独立的内容安全过滤。',
    to: '5. 内容安全：我们对 AI 输出进行安全过滤；',
    cmd: 'node .tools/verify-legal.mjs'
  },
  {
    // 同一类错的供应商版本：llm.js 里写着一个模型，就当「供应商只有它」。
    // 哪条变红：D1/D2（两份文本的供应商/模型集合不一致）。
    label: '只在《隐私政策》里删掉通义千问披露（改一处忘另一处）',
    file: 'src/data/legal.ts',
    from: '小程序端的购物比价与联网资讯类查询另使用通义千问（qwen-plus，阿里云百炼 DashScope）进行联网检索；',
    to: '',
    cmd: 'node .tools/verify-legal.mjs'
  },
  {
    // 把「平台下发」写成前端硬编码 ⇒ 条文里「平台目录」那句变成假话。
    // 哪条变红：A3 pickModel 不得硬编码模型 id。
    label: 'H5 把模型 id 硬编码（「平台目录下发」这句立刻变假）',
    file: 'src/services/cloudLlm.ts',
    from: '    cachedModel = model.id;',
    to: "    cachedModel = 'hy4-preview';",
    cmd: 'node .tools/verify-legal.mjs'
  },

  /* ---------------- 绝对句类错误 ---------------- */
  {
    // 上一轮 8 处不实里 5 处藏在「唯一/仅/全部」里，这句是最典型的一个。
    // 哪条变红：B2 不得出现「邮箱为唯一登录方式」。
    label: '加一句「邮箱为唯一登录方式」（代码里有两种通道）',
    file: 'src/data/legal.ts',
    from: '二、账号与实名\n1. 本服务的账号标识按端区分：',
    to: '二、账号与实名\n1. 邮箱为唯一登录方式；本服务的账号标识按端区分：',
    cmd: 'node .tools/verify-legal.mjs'
  },
  {
    // 去掉限定语后，这句和《隐私政策》三条的共享披露直接打架 —— 只在代码侧核对永远看不出来。
    // 哪条变红：B3「不会提供给第三方」必须带《隐私政策》第三条限定。
    label: '删掉「不会提供第三方」的共享条款限定（与隐私政策三条自相矛盾）',
    file: 'src/data/legal.ts',
    from: '除《隐私政策》第三条列明的委托处理与共享情形外，我们不会将你的个人数据提供给第三方或用于其他用途。',
    to: '我们不会将你的个人数据提供给第三方或用于其他用途。',
    cmd: 'node .tools/verify-legal.mjs'
  },
  {
    // 「一键注销」被写成连账号一起删 —— H5 根本没有删号接口，用户按这句话会以为号没了。
    // 哪条变红：B5「一键注销」句不得声称删除账号。
    label: '「一键注销」改成「删除账号与全部数据」（H5 无删号接口）',
    file: 'src/data/legal.ts',
    from: '4. 注销：你可在「我的-注销账号」一键注销，清除本地数据与云端同步数据（账号本身的删除见第四条第 5 项）。',
    to: '4. 注销：你可在「我的-注销账号」一键注销，删除账号与全部数据。',
    cmd: 'node .tools/verify-legal.mjs'
  },

  /* ---------------- 数据流 / 顺序类错误 ---------------- */
  {
    // 顺序反了 = 先采集坐标，再问要不要出境。文案照旧写着「只有你主动授权后」。
    // 哪条变红：C1 顺序必须是 同意闸门 → Taro.getLocation。
    label: '定位链路把出境同意挪到 getLocation 之后（先采集后同意）',
    file: 'src/services/location.ts',
    from:
      "    if (!(await ensureCrossBorderConsent())) {\n      console.warn('[Location] 未取得坐标出境单独同意，已跳过定位（不发起 getLocation）')\n      return null\n    }\n    const pos = await Taro.getLocation({ type: 'wgs84' })",
    to:
      "    const pos = await Taro.getLocation({ type: 'wgs84' })\n    if (!(await ensureCrossBorderConsent())) {\n      console.warn('[Location] 未取得坐标出境单独同意，已跳过定位（不发起 getLocation）')\n      return null\n    }",
    cmd: 'node .tools/verify-legal.mjs'
  },
  {
    // 登出与注销混用：用户只想换个账号，数据被一起清掉（这条在 2026-10 真发生过）。
    // 哪条变红：B6 登出流程不使用 clearStorageSync。
    label: '登出流程里加 clearStorageSync（登出变成注销）',
    file: 'src/pages/mine/index.tsx',
    from: '        await signOut();\n        // 清「下次自动登录」偏好',
    to: '        await signOut();\n        Taro.clearStorageSync();\n        // 清「下次自动登录」偏好',
    cmd: 'node .tools/verify-legal.mjs'
  }
];
