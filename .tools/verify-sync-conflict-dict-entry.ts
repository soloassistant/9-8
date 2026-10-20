// 入口：编译真实 language.ts（Taro 用最小桩顶掉），取中英文案。
// 配套文件：verify-sync-conflict.mjs。
// 变量名别叫 t；别用 export（vm 无 ESM 解析器）。
import { dict } from '@/store/language';

console.log(JSON.stringify({ zh: dict.zh, en: dict.en }));
