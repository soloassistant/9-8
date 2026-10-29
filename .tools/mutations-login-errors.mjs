/**
 * mutations-login-errors.mjs —— 登录错误分流门禁的变异用例（2026-10-29）
 *
 * 每条都对应一种「用户被不实告知」的真实退化：
 *   限流被当成网络抖动（用户照着连续点，连续点必然继续被拒）、
 *   分流了但所有 kind 都指向同一句（等于没分流）、
 *   文案被清空（点登录弹出一片空白）、
 *   把后端原文透给用户（破坏「不区分账号不存在/密码错」的反枚举口径）。
 *
 * 目标文件是**源码**（登录页 + i18n），不是产物 —— 变异只能改源。
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
  }
];
