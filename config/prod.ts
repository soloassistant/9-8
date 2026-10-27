import type { UserConfigExport } from '@tarojs/cli';

/**
 * 生产构建配置。
 *
 * 【console 剔除为什么不在这里配（2026-10-27 起）】
 *   曾在此用 terser `pure_funcs: ['console.log','console.info','console.warn','console.debug']`
 *   （顶层 terser 字段，注释档案见 git 历史），但它只删「返回值未被使用」的调用；
 *   业务代码大量 `.catch(u => console.warn(...))` 的结果被 return 使用，terser 删不掉
 *   （实测 dist 残留 16 处业务 warn）。
 *   现已统一收敛到 babel.config.js 的 stripConsoleExceptError 插件（生产启用，保留
 *   console.error），本文件不再参与 console 处理 —— 全仓只有这一套机制，不要另开第二套。
 */
export default {
  mini: {},
  h5: {},
} satisfies UserConfigExport<'webpack5'>;
