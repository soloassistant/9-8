// 变异用例：客户端崩溃上报（harness: .tools/verify-crash-report.js）
//
// 每个 case 针对一个「线上会静默失效、且没人会发现」的缺陷，把它们改回去，断言必须变红。
// from 必须在目标文件里**正好出现一次**（工具会断言）。
export default [
  {
    label: 'app.tsx 去掉 H5 原生监听（退回"只有 Taro.cloud 一条上报路"的旧缺陷）',
    file: 'src/app.tsx',
    from: '    installH5CrashHandlers(h5CrashTransport);',
    to: '    void 0;',
    cmd: 'node .tools/verify-crash-report.js'
  },
  {
    label: 'sanitizeText 直通（崩溃日志带出邮箱/手机号/token）',
    file: 'src/services/crashReport.ts',
    from: "  let out = String(input == null ? '' : input);",
    to: "  let out = String(input == null ? '' : input);\n  return out; // 变异：跳过打码",
    cmd: 'node .tools/verify-crash-report.js'
  },
  {
    // 这条守的是线上安全性：client_errors 对客户端 REVOKE 了表权限、RLS 无任何策略，
    // 直接 insert 会 42501，崩溃日志**一条也写不进去**，而 H5 上是静默失败。
    label: 'cloudDb 改回直接写 client_errors 表（线上会 42501，日志全丢）',
    file: 'src/services/cloudDb.ts',
    from: "  const res = await db.rpc<void>('log_client_error', {",
    to: "  await db.from('client_errors').insert({ message: input.message }); // 变异\n  const res = await db.rpc<void>('log_client_error', {",
    cmd: 'node .tools/verify-crash-report.js'
  },
  {
    label: '单会话预算 8 → 20（崩溃风暴时放开，可能刷爆云端）',
    file: 'src/services/crashReport.ts',
    from: 'const MAX_REPORTS_PER_SESSION = 8;',
    to: 'const MAX_REPORTS_PER_SESSION = 20;',
    cmd: 'node .tools/verify-crash-report.js'
  },
  {
    label: '事件形态回退成"有 message 才返回"（空白噪声被当成真实崩溃上报）',
    file: 'src/services/crashReport.ts',
    from: "    if ('message' in obj) {",
    to: '    if (message) {',
    cmd: 'node .tools/verify-crash-report.js'
  }
];
