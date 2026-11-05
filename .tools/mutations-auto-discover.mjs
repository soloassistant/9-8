// 自动发现 runner 的变异用例（2026-11-05）：
// 验证「.tools/verify-mutation-all.mjs 用 glob 发现用例」这件事本身不是死代码 ——
// 把发现规则改坏后，A3 的「实测集合相等」必须转红。
export default [
  {
    label: '自动发现规则被改坏（mutations-*.mjs 一个都发现不到）时 --list 必须退出非 0',
    file: '.tools/verify-mutation-all.mjs',
    from: 'const CASE_RE = /^mutations-.*\\.mjs$/;',
    to: 'const CASE_RE = /^mutations-none-existing\\.mjs$/;',
    cmd: 'node .tools/verify-mutation-all.mjs --list'
  }
];
