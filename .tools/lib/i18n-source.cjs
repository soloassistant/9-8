/**
 * i18n 源码读取（门禁专用）。
 *
 * 2026-11-05：`en` 词典从 `src/store/language.ts` 逐行搬到了 `src/store/language.en.ts`
 * （纯搬移，key → value 一字未改）。但仓里有十几组门禁用「读 language.ts 文本 + 按
 * `const en:` 位置切分」的方式检查中英键是否齐全 —— 搬移后那些文本断言会假红。
 *
 * 这里返回**旧形状的合并源**：language.ts + 把 en 文件的对象体接回
 * `const en: Record<keyof typeof zh, string> = {` 之后，使既有门禁的判断口径不变。
 * 注意：这只是给门禁读文本用，**运行时代码仍然从 ./language.en 导入**。
 */
const fs = require('node:fs');
const path = require('node:path');

function readI18nSource(root) {
  const base = root || process.cwd();
  const langPath = path.join(base, 'src', 'store', 'language.ts');
  const enPath = path.join(base, 'src', 'store', 'language.en.ts');
  let lang = fs.readFileSync(langPath, 'utf8');
  let en = '';
  try {
    en = fs.readFileSync(enPath, 'utf8');
  } catch {
    // 还没拆出 en 文件时（老分支/回滚），合并源就是原文件
    return lang;
  }
  lang = lang.replace(/\r\n/g, '\n');
  en = en.replace(/\r\n/g, '\n');
  const brace = en.indexOf('{');
  if (brace < 0) return lang;
  const body = en.slice(brace + 1);
  const withoutImport = lang.replace(/import\s*\{\s*en\s*\}\s*from\s*['"]\.\/language\.en['"];\n?/, '');
  // 旧形状里 en 在 `export type LangKey` 之前，门禁按这个顺序切中/英区域，所以插回同一位置
  const markerIdx = withoutImport.indexOf('export type LangKey');
  const synthetic = `\nconst en: Record<keyof typeof zh, string> = {${body}`;
  if (markerIdx < 0) return `${withoutImport}${synthetic}`;
  return `${withoutImport.slice(0, markerIdx).replace(/\n+$/, '\n')}${synthetic}\n\n${withoutImport.slice(markerIdx)}`;
}

module.exports = { readI18nSource };
