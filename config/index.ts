import { defineConfig, type UserConfigExport } from '@tarojs/cli';
import TsconfigPathsPlugin from 'tsconfig-paths-webpack-plugin';
import devConfig from './dev';
import prodConfig from './prod';
import vitePluginImp from 'vite-plugin-imp';
// https://taro-docs.jd.com/docs/next/config#defineconfig-辅助函数
export default defineConfig<'webpack5'>(async (merge, { command, mode }) => {
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
    outputRoot: process.env.TARO_OUTPUT_DIR || 'dist',
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
