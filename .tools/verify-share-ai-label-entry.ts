// 入口：被 esbuild 编译成 iife 后在 vm 里求值（verify-share-ai-label.mjs 的配套文件）。
// 变量名别叫 t（会与历史用例注册函数撞），别用 export（vm 无 ESM 解析器）。
import { dict } from '@/store/language';

// 与 useT（src/store/language.ts）的插值实现逐字一致的求值：
// str.split(`{${k}}`).join(String(v))
const interp = (str: string, params: Record<string, string>): string =>
  Object.entries(params).reduce((acc, [k, v]) => acc.split(`{${k}}`).join(String(v)), str);

const zhShare = interp(dict.zh['share.titleAI'], { title: dict.zh['share.title'] });
const enShare = interp(dict.en['share.titleAI'], { title: dict.en['share.title'] });
// 免费档 / 降级档走的**中性分支**：文案里不得出现任何 AI 署名。
const zhNeutral = interp(dict.zh['share.title'], { title: dict.zh['share.title'] });
const enNeutral = interp(dict.en['share.title'], { title: dict.en['share.title'] });

const out = {
  zhShare,
  enShare,
  zhNeutral,
  enNeutral,
  zhCopyLabel: dict.zh['ai.labelText'],
  enCopyLabel: dict.en['ai.labelText']
};
console.log(JSON.stringify(out));
