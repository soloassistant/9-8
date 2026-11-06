/**
 * 变异用例：定位失败文案分类门禁（verify-locate-copy）
 * 每条都必须让门禁变红，否则说明断言没生效。
 */
export default [
  {
    label: '把「超时」文案改成与「拒绝」相同',
    file: 'src/store/language.ts',
    from: "  'briefing.locateFailTimeout': '定位超时，请稍后重试',",
    to: "  'briefing.locateFailTimeout': '未授权定位，天气仍用当前城市',",
    cmd: 'node .tools/verify-locate-copy.mjs'
  },
  {
    label: '在非安全上下文文案里塞入「未授权」',
    file: 'src/store/language.ts',
    from: "  'briefing.locateFailInsecure': '当前是非安全连接，请用 HTTPS 或 localhost 打开',",
    to: "  'briefing.locateFailInsecure': '未授权：请用 HTTPS 或 localhost 打开',",
    cmd: 'node .tools/verify-locate-copy.mjs'
  }
];
