import { defineConfig, type UserConfigExport } from '@tarojs/cli';
import TsconfigPathsPlugin from 'tsconfig-paths-webpack-plugin';
import devConfig from './dev';
import prodConfig from './prod';
import vitePluginImp from 'vite-plugin-imp';
// https://taro-docs.jd.com/docs/next/config#defineconfig-辅助函数
export default defineConfig<'webpack5'>(async (merge, { command, mode }) => {
  // 产物目录按平台分开：H5 → dist，其它端 → dist-<platform>（如 dist-weapp）。
  // 【为什么必须分开】此前只有 `process.env.TARO_OUTPUT_DIR || 'dist'`，而 `build:weapp`
  // 的 npm script 并没有设这个环境变量 —— 于是**跑一次小程序构建就会把 H5 的 dist 整个覆盖掉**
  // 成小程序产物。危害不止是本地乱：一旦有人在这之后把 dist 发到 gh-pages，
  // **小程序产物就被当成网页发布上线了**。project.config.json 的 miniprogramRoot
  // 与 docs/质量验证报告.md 记的都是 `dist-weapp`，说明"按平台分目录"本就是既定约定，
  // 只是没人把它写进配置 → 在这里一次性收口，不依赖调用方记得传环境变量。
  // 保留 TARO_OUTPUT_DIR 覆盖能力（CI 需要自定义目录时仍可用）。
  // ⚠️ 兜底必须容忍 TARO_ENV 为空：否则会得到 `dist-undefined`。
  const platform = process.env.TARO_ENV || '';
  const outputRoot =
    process.env.TARO_OUTPUT_DIR || (platform && platform !== 'h5' ? `dist-${platform}` : 'dist');

  const baseConfig: UserConfigExport<'webpack5'> = {
    projectName: 'taro_template',
    date: '2025-12-10',
    designWidth: 375,
    deviceRatio: {
      640: 2.34 / 2,
      750: 1,
      375: 2,
      828: 1.81 / 2,
    },
    sourceRoot: 'src',
    outputRoot,
    plugins: ['@tarojs/plugin-html'],
    // 云环境 ID 编译期注入：设系统环境变量 TARO_APP_CLOUD_ENV 后构建，或直接在此填
    // （不用 config.env 字段——Taro 4.1.9 webpack5-runner 对其处理有坑，会破坏 taro-loader entry 分析）
    defineConstants: {
      TARO_APP_CLOUD_ENV: JSON.stringify(process.env.TARO_APP_CLOUD_ENV || ''),
    },
    copy: {
      patterns: [
        // TabBar PNG（微信 tabBar 仅支持 PNG，F30）+ 品牌 Logo/分享封面：H5 端 config 引用不会被自动打包，需显式拷贝
        { from: 'src/assets/tabbar-png/', to: 'assets/tabbar-png/', ignore: ['*.svg'] },
        { from: 'src/assets/logo.png', to: 'assets/logo.png' },
        { from: 'src/assets/share-cover.png', to: 'assets/share-cover.png' },
      ],
      options: {},
    },
    framework: 'react',
    compiler: {
      type: 'webpack5',
      prebundle: {
        enable: false,
      },
    },
    cache: {
      enable: false, // Webpack 持久化缓存配置，建议开启。默认配置请参考：https://docs.taro.zone/docs/config-detail#cache
    },
    mini: {
      postcss: {
        pxtransform: {
          enable: true,
          config: {
            selectorBlackList: ['nut-', 'splash'],
          },
        },
        cssModules: {
          enable: true, // 开启 CSS Modules
          config: {
            namingPattern: 'module', // 仅 *.module.scss 生效
            generateScopedName: '[name]__[local]___[hash:base64:5]',
          },
        },
      },
      webpackChain(chain) {
        chain.resolve.plugin('tsconfig-paths').use(TsconfigPathsPlugin);
      },
    },
    h5: {
      publicPath: './',
      staticDirectory: 'static',
      router: {
        mode: 'hash',
        // 关闭页面切换动画：动画样式会把 .taro_page 平移到屏幕外，依赖 onLoad 回调注入
        // taro_page_show 类才滑入，快速导航/弱环境存在竞态（Taro page.js FIXME 自认）导致整页白屏。
        // 关闭后无屏外隐藏机制，页面始终可见；仅 H5 失去过渡动画，小程序端不受影响。
        animation: false
      },
      output: {
        filename: 'js/[name].[hash:8].js',
        chunkFilename: 'js/[name].[chunkhash:8].js',
      },
      miniCssExtractPluginOption: {
        ignoreOrder: true,
        filename: 'css/[name].[hash].css',
        chunkFilename: 'css/[name].[chunkhash].css',
      },
      postcss: {
        autoprefixer: {
          enable: true,
          config: {},
        },
        cssModules: {
          enable: true, // 开启 CSS Modules
          config: {
            namingPattern: 'module', // 仅 *.module.scss 生效
            generateScopedName: '[name]__[local]___[hash:base64:5]',
          },
        },
        pxtransform: {
          enable: true,
          config: {
            selectorBlackList: ['body', 'splash'],
            baseFontSize: 37.5,
            unitPrecision: 5,
          },
        },
      },
      webpackChain(chain) {
        chain.resolve.plugin('tsconfig-paths').use(TsconfigPathsPlugin);
        // 所有 JS chunk 合并为单文件：消除「旧 html 引用已删除的懒加载 chunk → 白屏」问题
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        chain.plugin('limit-chunk-count').use(require('webpack').optimize.LimitChunkCountPlugin, [{ maxChunks: 1 }]);
      },
    },
    rn: {
      appName: 'taroDemo',
      postcss: {
        cssModules: {
          enable: true,
        },
      },
    },
  };
  if (process.env.NODE_ENV === 'development') {
    // 本地开发构建配置（不混淆压缩）
    return merge({}, baseConfig, devConfig);
  }
  // 生产构建配置（默认开启压缩混淆等）
  return merge({}, baseConfig, prodConfig);
});
