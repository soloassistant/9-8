import type { UserConfigExport } from '@tarojs/cli';

/**
 * 生产构建配置。
 *
 * 【为什么 terser 配在**顶层**，而不是 `h5: { terser }`】
 *   Taro CLI 组装最终配置时只搬**顶层**字段（node_modules/@tarojs/service/dist/Config.js
 *   `getConfigWithNamed()`：先把 `terser: initialConfig.terser` 拼进去，再让 `...initialConfig[h5]`
 *   覆盖）。而 h5 / mini 各自的配置类型（IH5Config / IMiniAppConfig）里**没有** terser 字段，
 *   写成 `h5: { terser: {...} }` 会被 `satisfies UserConfigExport<'webpack5'>` 的额外属性检查
 *   直接判错。顶层 `terser` 的类型是现成的 TogglableOptions（IProjectConfig.terser），
 *   既有类型支持、又确实生效（下面用 dist/js 实测过）。
 *   实际效果覆盖 h5 与小程序两端 —— 两端生产包都不该带 log/warn 噪音，这是想要的行为。
 *
 * 【为什么不用 `drop_console: true`】
 *   它按**类别**整删：console.error 会一起消失，而线上排障恰恰只剩 error 可用
 *   （本仓 app.tsx 的 `[App] Taro.cloud is unavailable`、mine 的 `deleteAccount failed`
 *   等都是刻意保留的排障日志）。所以这里 drop_console 显式关掉，改用 `pure_funcs`
 *   精确点名「这几个调用无副作用、返回值无人使用」→ terser 删除整句调用，
 *   等价于「drop_console 但放过 console.error」。
 */
export default {
  terser: {
    enable: true,
    config: {
      compress: {
        // 不按类别整删（否则保留 console.error 无从谈起）
        drop_console: false,
        // 只删这四个；console.error 不在列，故生产包保留
        pure_funcs: ['console.log', 'console.info', 'console.warn', 'console.debug']
      }
    }
  },
  mini: {},
  h5: {},
} satisfies UserConfigExport<'webpack5'>;
