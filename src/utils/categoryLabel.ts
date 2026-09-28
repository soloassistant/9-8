/**
 * 资讯类目的**唯一**解析与展示口径。
 *
 * 为什么需要它（两个必然会发散的地方，集中到一处）：
 * 1) 「哪一条标签才算类目」：垂类热榜的 tags 是 `['热榜', 类目]`，RSS 源的是 `[类目]`，
 *    知乎日报是 `[]`。若每个调用点各自 filter 一遍，早晚会出现两处口径不一致。
 * 2) 「类目怎么显示」：类目 tag 是**数据层写入的中文串**（源清单的 tag），
 *    直接渲染会让 en 语言下混进中文。这里统一映射到 i18n 键。
 *
 * 未映射的类目**原样返回**而不是显示成空 —— 源清单新增类目时，界面会直接显示原始串，
 * 不会静默变成空白卡片（静默失败比显示一个没翻译的词更糟）。
 */

import type { LangKey } from '@/store/language';

/** 综合热榜：5 个平台算法榜归并为一类（时政占比不可控，归并后便于统一配额） */
export const CATEGORY_MIXED = '综合热榜';
/** 无任何标签的来源（如知乎日报 API） */
export const CATEGORY_UNKNOWN = '未分类';

/** 中文类目 → i18n 键。键定义见 src/store/language.ts 的 'cat.*' 段。
 *  值类型刻意写成 LangKey 而不是 string：**漏键会在编译期报错**，而不是跑到运行时才发现。
 *  （这也是 2026-09-28 那轮把签名从 `(key: string) => string` 改成 `(key: LangKey) => string` 的原因 ——
 *   原先靠函数参数双变才勉强兼容 `useT()`，一旦开启 strictFunctionTypes 就会报错。） */
export const CATEGORY_LABEL_KEYS: Record<string, LangKey> = {
  数字生活: 'cat.life',
  科技: 'cat.tech',
  AI: 'cat.ai',
  商业: 'cat.business',
  财经: 'cat.finance',
  社会: 'cat.society',
  时事: 'cat.current',
  游戏: 'cat.game',
  汽车: 'cat.auto',
  消费: 'cat.consumer',
  教育: 'cat.education',
  开发者: 'cat.dev',
  开源: 'cat.opensource',
  科学: 'cat.science',
  数码: 'cat.digital',
  影视: 'cat.film',
  [CATEGORY_MIXED]: 'cat.hotlist',
  [CATEGORY_UNKNOWN]: 'cat.unknown'
};

/** 从条目 tags 里解析出类目。防御：tags 可能缺失、不是数组、含非字符串。 */
export function categoryOf(tags?: string[]): string {
  if (!Array.isArray(tags)) return CATEGORY_UNKNOWN;
  const clean = tags.filter((x) => typeof x === 'string' && x && x !== '热榜');
  if (clean.length) return clean[0];
  return tags.indexOf('热榜') >= 0 ? CATEGORY_MIXED : CATEGORY_UNKNOWN;
}

/** 类目 → i18n 键；未收录返回空串（由 categoryLabel 决定降级行为） */
export function categoryKey(category: string): LangKey | '' {
  return CATEGORY_LABEL_KEYS[category] || '';
}

/** 类目 → 展示文案。传入 t 时走 i18n；未收录的类目原样返回（不静默变空）。
 *  参数类型用 `(key: LangKey) => string`：`useT()` 返回的是 `(key: LangKey, params?) => string`，
 *  参数更少的目标类型可以接受它（多余形参允许），因此在开启 strictFunctionTypes 后依然成立。 */
export function categoryLabel(category: string, t?: (key: LangKey) => string): string {
  const key = categoryKey(category);
  if (!key || !t) return category;
  try {
    const out = t(key);
    // t 未命中时部分实现会回传键名本身，此时回退原始类目名，避免界面出现 'cat.xxx'
    return out && out !== key ? out : category;
  } catch {
    return category;
  }
}
