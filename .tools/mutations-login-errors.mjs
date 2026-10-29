/**
 * mutations-login-errors.mjs —— 登录错误分流门禁的变异用例（2026-10-29）
 *
 * 每条都对应一种「用户被不实告知」的真实退化：
 *   限流被当成网络抖动（用户照着连续点，连续点必然继续被拒）、
 *   分流了但所有 kind 都指向同一句（等于没分流）、
 *   文案被清空（点登录弹出一片空白）、
 *   把后端原文透给用户（破坏「不区分账号不存在/密码错」的反枚举口径）。
 *
 * 目标文件是**源码**（登录页 + i18n + cloudAuth），不是产物 —— 变异只能改源。
 *
 * 2026-10-29 追加 3 条（配合「手机号忘记密码」那条追问查出的缺陷）：
 *   · 非 H5 分支把 error 改回 null ⇒ 界面又敢谎报「验证码已发送」；
 *   · 去掉 tabs 的按端过滤 ⇒ 小程序端又冒出「忘记密码」页签；
 *   · 去掉手机号引导行的 && IS_H5 ⇒ 小程序端又冒出点不动的「忘记密码」入口。
 */
export default [
  {
    label: '限流分支被改掉（rate-limited 落回兜底文案 → 用户被告知「网络抖了一下」并连续重试）',
    file: 'src/pages/login/index.tsx',
    from: "    case 'rate-limited':",
    to: "    case 'rate-limited-x':",
    cmd: 'node .tools/verify-login-errors.mjs'
  },
  {
    label: '所有 kind 映射到同一句文案（分流了等于没分流）',
    file: 'src/pages/login/index.tsx',
    from: "      return t('auth.errNetwork');",
    to: "      return t('auth.errSdkUnavailable');",
    cmd: 'node .tools/verify-login-errors.mjs'
  },
  {
    label: '限流文案被清空（点登录弹出一片空白）',
    file: 'src/store/language.ts',
    from: "'auth.errRateLimited': '操作太频繁，被服务端暂时限流了。等一两分钟再试，别连续点。',",
    to: "'auth.errRateLimited': '',",
    cmd: 'node .tools/verify-login-errors.mjs'
  },
  {
    label: '把后端原文透给用户（破坏「不区分账号不存在/密码错」的反枚举口径）',
    file: 'src/pages/login/index.tsx',
    from: "setError(sdkDownText(res.error, t) || t('auth.errWrongCredentials'));",
    to: "setError(res.error && res.error.message ? res.error.message : t('auth.errWrongCredentials'));",
    cmd: 'node .tools/verify-login-errors.mjs'
  },
  {
    label: '非 H5 分支把 error 改回 null（小程序端又敢谎报「验证码已发送」，实际一条短信都没发）',
    file: 'src/services/cloudAuth.ts',
    from:
      "      error: {\n" +
      "        kind: 'backend-unavailable',\n" +
      "        message: '短信找回密码仅在 H5 通道可用（小程序端由微信身份直接登录）'\n" +
      "      }",
    to: '      error: null',
    cmd: 'node .tools/verify-login-errors.mjs'
  },
  {
    label: '去掉 tabs 的按端过滤（小程序端又冒出「忘记密码」页签，而那里没有短信通道）',
    file: 'src/pages/login/index.tsx',
    from: "  const tabs: Tab[] = baseTabs.filter((k) => IS_H5 || k !== 'forgot');",
    to: '  const tabs: Tab[] = baseTabs;',
    cmd: 'node .tools/verify-login-errors.mjs'
  },
  {
    label: '去掉手机号「忘记密码」引导行的 && IS_H5（小程序端又冒出点不动的入口）',
    file: 'src/pages/login/index.tsx',
    from: "{channel === 'phone' && IS_H5 ? (",
    to: "{channel === 'phone' ? (",
    cmd: 'node .tools/verify-login-errors.mjs'
  }
];
