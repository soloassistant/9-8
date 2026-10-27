/**
 * mutations-hotkeys.mjs —— 证明 verify-hotkeys.mjs 的断言有判别力（2026-10-27）。
 *
 * 每条把「已经想清楚的做法」改回「看起来也能跑、但实际按不对的写法」，
 * `node .tools/verify-hotkeys.mjs` 必须由 PASS 变 FAIL。改不红 = 门禁是假绿的。
 *
 * 快捷键的缺陷有个共同特征：**不报错、不崩溃，只是按了没反应或按了干别的事**。
 * 所以「跑起来看看」永远发现不了，必须靠真值表 + 变异两向对证。
 */
export default [
  {
    label: 'matchChord 不再区分平台修饰键（Mac 上按 Ctrl+Enter 也会触发 ⌘Enter）',
    file: 'src/utils/hotkeys.ts',
    from: '  if (secondary) return false; // 另一个平台的修饰键按着 → 不是给我们的',
    to: '  // mutation：修饰键不再互斥',
    cmd: 'node .tools/verify-hotkeys.mjs'
  },
  {
    label: '字符键也校验 shift（`?` 永远触发不了，因为它本身就是 shift+/ 打出来的）',
    file: 'src/utils/hotkeys.ts',
    from: '  const isChar = want.key.length === 1 && !/[a-z0-9]/.test(want.key);',
    to: '  const isChar = true;',
    cmd: 'node .tools/verify-hotkeys.mjs'
  },
  {
    label: '序列前缀不再消费按键（按 g 会把 g 当普通字符打进页面）',
    file: 'src/utils/hotkeys.ts',
    from: '  if (isPrefix) return { hit: null, pending: key, consumed: true };',
    to: '  if (isPrefix) return { hit: null, pending: key, consumed: false };',
    cmd: 'node .tools/verify-hotkeys.mjs'
  },
  {
    label: '序列没命中后不清空前缀（g 按完没跟对键，下一次按 b 仍会跳页）',
    file: 'src/utils/hotkeys.ts',
    from: "    return { hit: target?.id ?? null, pending: '', consumed: true };",
    to: '    return { hit: target?.id ?? null, pending: pending, consumed: true };',
    cmd: 'node .tools/verify-hotkeys.mjs'
  },
  {
    label: '把「去我的」改成 ⌘W（劫持浏览器关标签页，用户会丢正在做的事）',
    file: 'src/utils/hotkeys.ts',
    from: "chord: 'g m', labelKey: 'hotkeys.goMine', route: '/pages/mine/index'",
    to: "chord: 'mod+w', labelKey: 'hotkeys.goMine', route: '/pages/mine/index'",
    cmd: 'node .tools/verify-hotkeys.mjs'
  },
  {
    label: '跳转指向不存在的页面（按 g m 时 Taro 才 reject，静态看不出来）',
    file: 'src/utils/hotkeys.ts',
    from: "chord: 'g m', labelKey: 'hotkeys.goMine', route: '/pages/mine/index'",
    to: "chord: 'g m', labelKey: 'hotkeys.goMine', route: '/pages/history/index'",
    cmd: 'node .tools/verify-hotkeys.mjs'
  },
  {
    label: '引用不存在的文案 key（面板上显示原始 key 名或空白）',
    file: 'src/utils/hotkeys.ts',
    from: "labelKey: 'hotkeys.goInbox'",
    to: "labelKey: 'hotkeys.goInboxMissing'",
    cmd: 'node .tools/verify-hotkeys.mjs'
  },
  {
    label: '⌘Enter 取消 whenTyping（在输入框里按 ⌘Enter 毫无反应——正是最需要它的地方）',
    file: 'src/utils/hotkeys.ts',
    from: "labelKey: 'hotkeys.submit', whenTyping: true }",
    to: 'labelKey: \'hotkeys.submit\' }',
    cmd: 'node .tools/verify-hotkeys.mjs'
  },
  {
    label: '输入态也响应全局跳转（打字打到一半，页面跳走了）',
    file: 'src/hooks/useHotkeys.ts',
    from: '        if (typing && !def.whenTyping) return;',
    to: '        // mutation：输入态不再让路',
    cmd: 'node .tools/verify-hotkeys.mjs'
  },
  {
    label: '输入态里也进入序列待命（在输入框里打 g 会丢一个字符）',
    file: 'src/hooks/useHotkeys.ts',
    from: '        if (typing) return;',
    to: '        // mutation：输入态也进入待命',
    cmd: 'node .tools/verify-hotkeys.mjs'
  },
  {
    label: '去掉「H5 + 精细指针」门禁（手机浏览器与小程序也挂全局键盘监听）',
    file: 'src/hooks/useHotkeys.ts',
    from: '  if (!isH5 || typeof window === \'undefined\' || !window.matchMedia) return false;',
    to: '  return true;',
    cmd: 'node .tools/verify-hotkeys.mjs'
  },
  {
    label: 'Esc 改到冒泡阶段（弹层与全局层抢同一击，最上层不一定先拿到）',
    file: 'src/hooks/useHotkeys.ts',
    from: "    document.addEventListener('keydown', onKeyDown, true);",
    to: "    document.addEventListener('keydown', onKeyDown, false);",
    cmd: 'node .tools/verify-hotkeys.mjs'
  },
  {
    label: 'Esc 层栈不再判「谁在最上层」（叠了两层弹窗时，Esc 把下面的先关掉）',
    file: 'src/hooks/useHotkeys.ts',
    from: '      if (layers[layers.length - 1] !== id) return; // 不是最上层：让下面的层去处理',
    to: '      // mutation：谁都能响应 Esc',
    cmd: 'node .tools/verify-hotkeys.mjs'
  },
  {
    label: '聚焦搜索框时不再跳过隐藏的旧页残留（Taro H5 保留上一页 DOM → focus 到看不见的框）',
    file: 'src/hooks/useHotkeys.ts',
    from: '    if (rect.width === 0 || rect.height === 0) continue; // 隐藏的旧页残留',
    to: '    // mutation：不再过滤隐藏元素',
    cmd: 'node .tools/verify-hotkeys.mjs'
  },
  {
    label: '全局层去掉「开屏已消失」这道门禁（开屏还盖着，按 ? 看起来毫无反应）',
    file: 'src/app.tsx',
    from: 'enabled: !isLoginPage && consentAgreed && shellReady',
    to: 'enabled: !isLoginPage && consentAgreed',
    cmd: 'node .tools/verify-hotkeys.mjs'
  },
  {
    label: 'AI 助手不接 ⌘Enter（电脑上聊天时按 ⌘Enter 没反应，只能摸鼠标）',
    file: 'src/components/AiAssistant/index.tsx',
    from: '  useSubmitHotkey(handleSend, open);',
    to: '  // mutation：不接 ⌘Enter',
    cmd: 'node .tools/verify-hotkeys.mjs'
  },
  {
    label: '「我的 → 键盘快捷键」入口去掉 hasKeyboard 门禁（手机上列一串按不了的键）',
    file: 'src/pages/mine/index.tsx',
    from: '      {hasKeyboard() ? (',
    to: '      {true ? (',
    cmd: 'node .tools/verify-hotkeys.mjs'
  }
];
