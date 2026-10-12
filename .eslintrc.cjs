// ESLint 配置。
//
// 背景：本仓此前**没有任何 .eslintrc**，于是 package.json 里装好的
// eslint / eslint-config-taro / eslint-plugin-react / eslint-plugin-react-hooks /
// eslint-plugin-import / @typescript-eslint 全是白装 —— 一条规则都没生效。
//
// `extends: ['taro/react']` 的写法依据（读安装包本身得出，非凭记忆）：
//   · node_modules/eslint-config-taro/package.json → main: index.js，files 含 react.js
//   · node_modules/eslint-config-taro/index.js     → 传统 eslintrc 结构（root/extends/parser/overrides）：
//       - 默认 parser 为 @babel/eslint-parser（用于 .js）
//       - 对 TS（ts / tsx 两类扩展名） override 为 @typescript-eslint/parser，并已内置
//         react-hooks/rules-of-hooks(error)、react-hooks/exhaustive-deps(warn)、
//         @typescript-eslint/no-unused-vars(warn)、no-restricted-globals(error) 等
//       - 它 extends 的三份 rules（jsx / imports / variables）都在包内，无需额外安装
//   · node_modules/eslint-config-taro/react.js  → Object.assign({}, index, { settings.react.version: 'detect' })
// 即 'taro/react' = 'taro' + React 版本探测，是该包的原生用法。
// 本仓 lint 只覆盖 src 下的 ts / tsx，实际全部走 index.js 里那段 TS override。
module.exports = {
  root: true,
  extends: ['taro/react'],
  rules: {
    // 本仓当前最需要的规则：历史上就存在未使用的导入（如 config/index.ts 里引用了
    // 未安装、且从未使用的 vite-plugin-imp）。taro 自带配置里它是 warn，这里提到 error，
    // 不让「未使用」继续当噪音堆积。
    // args 保持 'none'（与 taro 原配置一致）：Taro 事件回调签名常要求补齐形参，开 args 会大面积误报。
    '@typescript-eslint/no-unused-vars': [
      'error',
      { args: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^Nerv|^React' }
    ],
    // 下面两条 taro 自带配置里已有，这里显式写出：日后谁改了 extends，也不至于静默丢掉 hook 检查。
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',
    // taro 自带配置基于「经典 JSX 运行时」假设（要求 React 在作用域内）。本仓 tsconfig 是
    // "jsx": "react-jsx"（React 17+ 自动运行时），编译期并不需要 React 在作用域内 ——
    // 沿用会产出 773 条 react/react-in-jsx-scope 假报错（实测），把真实问题淹没。
    // 故按项目**真实编译方式**关掉这两条经典运行时专用规则（改的是配置，不是源码）。
    'react/react-in-jsx-scope': 'off',
    'react/jsx-uses-react': 'off'
  }
};
