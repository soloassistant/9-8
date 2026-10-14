/**
 * register-ts.mjs —— 用同步 registerHooks 注册解析钩子（Node 22.15+）。
 * 用法：node --import ./.tools/register-ts.mjs <script>
 *
 * 为什么必须用**同步** registerHooks 而不是异步 register()：
 * 实测异步 register() 的 resolve 钩子拦不住 .ts 模块链里的 import
 * （.ts 先被 CJS loader 试载，其内部的 import 走了不同解析路径），
 * 导致 @tarojs/taro 重定向静默失效、真 Taro 被加载进 Node。
 *
 * 做两件事：
 *  ① 相对 import 省略扩展名时补 `.ts`（仓库源码按打包器习惯写 `from './cloudAuth'`）；
 *  ② 把 `@tarojs/taro` 重定向到 TARO_STUB 指向的桩文件（惰性读环境变量：
 *     本文件经 --import 注册，早于被测脚本执行）。
 */
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    const taroStub = process.env.TARO_STUB || '';
    if (taroStub && specifier === '@tarojs/taro') {
      return { url: new URL(taroStub, `file://${process.cwd()}/`).href, shortCircuit: true };
    }
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (
        err &&
        err.code === 'ERR_MODULE_NOT_FOUND' &&
        specifier.startsWith('.') &&
        !/\.[cm]?[jt]s$/.test(specifier)
      ) {
        return nextResolve(specifier + '.ts', context);
      }
      throw err;
    }
  }
});
