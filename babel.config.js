// babel-preset-taro 更多选项和默认值：
// https://github.com/NervJS/taro/blob/next/packages/babel-preset-taro/README.md

/**
 * 【console 剔除的唯一机制（生产构建）】
 * 删掉 console.log/info/warn/debug 的调用点，console.error 必须保留
 * （本仓铁律：错误留痕靠它，verify-* 与线上排查依赖）。
 *
 * 【为什么放 babel 层而不是 terser pure_funcs】
 * pure_funcs 只删「返回值未被使用」的调用 —— 它的语义是"这个函数无副作用，
 * 结果没人用就整句删"。但业务代码大量写成 `.catch(u => console.warn(...))`，
 * 调用结果被 return 使用，terser 就不能删：2026-10-27 实测 dist 残留 16 处
 * console.warn（[BriefingPage]/[AiAssistant] 等业务 tag 全部幸存）。
 * babel 在调用点原地改写为 `void 0`（console.* 本来就返回 undefined，语义等价），
 * 任何位置（return / 三元 / 逻辑短路 / 语句）都能删，由后续 terser 收敛掉死代码。
 *
 * 【为什么只在 NODE_ENV=production 启用】
 * 开发构建和本地排障需要看到日志；本配置同时被 h5 与小程序生产构建读取，
 * 两端生产行为保持一致。
 */
function stripConsoleExceptError({ types: t }) {
  const removable = (name) => name === 'log' || name === 'info' || name === 'warn' || name === 'debug';
  const propName = (prop, computed) => {
    if (!computed && prop.isIdentifier()) return prop.node.name;
    if (prop.isStringLiteral()) return prop.node.value; // console['warn']() 同样命中
    return null;
  };
  return {
    visitor: {
      CallExpression(path) {
        const callee = path.get('callee');
        if (!callee.isMemberExpression()) return;
        if (!callee.get('object').isIdentifier({ name: 'console' })) return;
        if (!removable(propName(callee.get('property'), callee.node.computed))) return;
        // console.* 返回 undefined，任何位置替换为 void 0 都语义等价
        path.replaceWith(t.unaryExpression('void', t.numericLiteral(0)));
      },
    },
  };
}

const isProd = process.env.NODE_ENV === 'production';

module.exports = {
  presets: [
    [
      'taro',
      {
        framework: 'react',
        ts: 'true',
        compiler: 'webpack5',
      },
    ],
  ],
  plugins: isProd ? [stripConsoleExceptError] : [],
};
