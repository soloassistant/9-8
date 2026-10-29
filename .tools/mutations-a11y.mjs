/**
 * mutations-a11y.mjs —— 键盘可达性门禁的变异用例（2026-10-29）
 * 每条对应一种「键盘用户又被挡在门外」的真实退化。
 */
export default [
  {
    label: '去掉 role=button（读屏不再认这是按钮）',
    file: 'src/utils/a11y.ts',
    from: "{ role: 'button', 'data-pressable': '1' }",
    to: "{ role: 'group', 'data-pressable': '1' }",
    cmd: 'node .tools/verify-a11y-keyboard.mjs --no-browser'
  },
  {
    label: '去掉 data-pressable 标记（运行时补 tabindex 与 Enter 激活都找不到它）',
    file: 'src/utils/a11y.ts',
    from: "{ role: 'button', 'data-pressable': '1' }",
    to: "{ role: 'button' }",
    cmd: 'node .tools/verify-a11y-keyboard.mjs --no-browser'
  },
  {
    label: '让路规则丢了输入框判断（在输入框里按回车会被代理抢走）',
    file: 'src/utils/a11y.ts',
    from: 'if (!active || isTextEntry(active)) return false;',
    to: 'if (!active) return false;',
    cmd: 'node .tools/verify-a11y-keyboard.mjs --no-browser'
  },
  {
    label: 'IME 组字判断被删（中文输入法选词按空格会误触发点击）',
    file: 'src/utils/a11y.ts',
    from: 'if (e.isComposing || e.keyCode === 229) return false;',
    to: 'if (false) return false;',
    cmd: 'node .tools/verify-a11y-keyboard.mjs --no-browser'
  },
  {
    label: '全局代理被摘掉（属性还在，但按 Enter 没人响应）',
    file: 'src/app.tsx',
    from: '      if (activatePressable(e)) e.preventDefault();',
    to: '      if (false) e.preventDefault();',
    cmd: 'node .tools/verify-a11y-keyboard.mjs --no-browser'
  },
  {
    label: '桌面导航不再展开键盘属性（导航又只剩鼠标可用）',
    file: 'src/components/DesktopNav/index.tsx',
    from: '        {...pressableProps(`${t(it.labelKey as never)}（${active ? \'当前页\' : \'前往\'}）`)}',
    to: '        data-no-keyboard="1"',
    cmd: 'node .tools/verify-a11y-keyboard.mjs --no-browser'
  }
];
