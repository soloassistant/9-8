/**
 * verify-modal-text 的变异用例（2026-11-05）
 * 判据：showModal 按钮文案超过 Taro h5 上限（中文 ≤4 汉字 / 非中文 ≤8 字符）时必须变红。
 */
export default [
  {
    label: '把出境同意按钮改回超长文案「同意并继续」',
    file: 'src/store/language.ts',
    from: "  'perm.locCrossAgree': '同意',",
    to: "  'perm.locCrossAgree': '同意并继续',",
    cmd: 'node .tools/verify-modal-text.mjs'
  },
  {
    label: '新增一个假的长文案 showModal 调用点',
    file: 'src/pages/mine/index.tsx',
    from: 'const handleResetParentPin = () => {',
    to: "const handleResetParentPin = () => {\n    Taro.showModal({ title: '变异', content: 'x', confirmText: '这段文案太长了' });",
    cmd: 'node .tools/verify-modal-text.mjs'
  }
];
