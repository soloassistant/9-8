/**
 * i18n 纯搬移等价证明（一次性校验脚本，不进 npm 门禁）。
 *
 * 用途：把 `src/store/language.ts` 的 `en` 字面量搬到 `src/store/language.en.ts` 时，
 * 证明「key → value」逐项完全相同，且 `language.ts` 的导出面没有变化。
 *
 * 用法：
 *   node .tools/i18n-equivalence.mjs            # 以 origin/main 为基线
 *   node .tools/i18n-equivalence.mjs --old=<ref>  # 指定基线 ref/commit
 *
 * 失败示例（变异验证）：把拆后文件里任意一个 value 改一个字符 →
 *   退出码 1，并打印 `MISMATCH key=...`（指名到 key）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const CWD = process.cwd();
const GIT = 'C:\\Users\\geral\\.local\\bin\\mingit\\cmd\\git.exe';
const refArg = process.argv.find((a) => a.startsWith('--old='));
const OLD_REF = refArg ? refArg.slice('--old='.length) : 'origin/main';

const OLD_FILE = 'src/store/language.ts';
const NEW_FILE = 'src/store/language.ts';
const NEW_EN_FILE = 'src/store/language.en.ts';

function readOld(rel) {
  return execFileSync(GIT, ['show', `${OLD_REF}:${rel}`], { cwd: CWD, encoding: 'utf8' });
}
function readNew(rel) {
  return fs.readFileSync(path.join(CWD, rel), 'utf8');
}

function parse(text, file) {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** 收集 `const|let|var <name>[: T] = {...}` 的顶层声明（含 export） */
function findVarInit(sf, name) {
  let found = null;
  sf.forEachChild((node) => {
    if (found) return;
    if (!ts.isVariableStatement(node)) return;
    for (const d of node.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.name.text === name) {
        found = { decl: d, init: d.initializer, typeText: d.type ? d.type.getText(sf) : '' };
      }
    }
  });
  return found;
}

/** 把对象字面量求值成 [key, value] 数组；只允许字符串字面量（含无插值模板） */
function evaluateObject(init, file, name) {
  if (!init || !ts.isObjectLiteralExpression(init)) {
    throw new Error(`${file}: ${name} 不是对象字面量，无法做等价证明`);
  }
  const out = [];
  for (const p of init.properties) {
    if (!ts.isPropertyAssignment(p)) {
      throw new Error(`${file}: ${name} 含非 PropertyAssignment（${ts.SyntaxKind[p.kind]}），不在纯搬移范围`);
    }
    let key;
    if (ts.isStringLiteral(p.name) || ts.isIdentifier(p.name)) key = p.name.text;
    else if (ts.isNoSubstitutionTemplateLiteral(p.name)) key = p.name.text;
    else throw new Error(`${file}: ${name} 的键不是静态字符串（${p.name.getText()}）`);
    const v = p.initializer;
    let value;
    if (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)) value = v.text;
    else throw new Error(`${file}: ${name}['${key}'] 的值不是静态字符串（${v.getText()}）`);
    out.push([key, value]);
  }
  return out;
}

/** 导出面：导出名 + 类型注解源码（归一化空白） */
function exportSurface(sf) {
  const names = [];
  sf.forEachChild((node) => {
    const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    const isExport = mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!isExport) return;
    if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        names.push(`${d.name.getText(sf)}:${(d.type ? d.type.getText(sf) : '').replace(/\s+/g, '')}`);
      }
    } else if (ts.isTypeAliasDeclaration(node)) {
      names.push(`${node.name.text}:${node.type.getText(sf).replace(/\s+/g, '')}`);
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      names.push(`${node.name.text}:${node.getText(sf).replace(/\s+/g, '').length}#fn`);
    } else if (ts.isExportDeclaration(node)) {
      names.push(`re-export:${(node.moduleSpecifier ? node.moduleSpecifier.getText(sf) : '*').replace(/\s+/g, '')}`);
    }
  });
  return names;
}

function sha(entries) {
  const canon = JSON.stringify([...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
  return { hash: crypto.createHash('sha256').update(canon).digest('hex'), bytes: Buffer.byteLength(canon) };
}

function compare(name, oldEntries, newEntries) {
  const o = new Map(oldEntries);
  const n = new Map(newEntries);
  const keys = new Set([...o.keys(), ...n.keys()]);
  const diffs = [];
  for (const k of keys) {
    if (!o.has(k)) diffs.push(`MISSING_IN_OLD key=${k}`);
    else if (!n.has(k)) diffs.push(`MISSING_IN_NEW key=${k}`);
    else if (o.get(k) !== n.get(k)) {
      diffs.push(
        `MISMATCH key=${k}\n  old=${JSON.stringify(o.get(k))}\n  new=${JSON.stringify(n.get(k))}`
      );
    }
  }
  const oh = sha(oldEntries);
  const nh = sha(newEntries);
  console.log(`${name}: old_keys=${o.size} new_keys=${n.size}`);
  console.log(`  sha256(old)=${oh.hash}  canonical_bytes=${oh.bytes}`);
  console.log(`  sha256(new)=${nh.hash}`);
  if (oh.hash !== nh.hash) diffs.push(`HASH_DIFF ${name}: ${oh.hash} != ${nh.hash}`);
  return diffs;
}

const fail = (msg) => {
  console.error(`\nFAIL ${msg}`);
  process.exit(1);
};

// ---- 旧版 ----
const oldSrc = readOld(OLD_FILE);
const oldSf = parse(oldSrc, OLD_FILE);
const oldZh = findVarInit(oldSf, 'zh');
const oldEn = findVarInit(oldSf, 'en');
if (!oldZh || !oldEn) fail(`基线 ${OLD_REF} 中找不到 zh/en 字面量`);

// ---- 新版 ----
const newSrc = readNew(NEW_FILE);
const newSf = parse(newSrc, NEW_FILE);
const newZh = findVarInit(newSf, 'zh');
const newEnInLang = findVarInit(newSf, 'en');
if (!newZh) fail(`${NEW_FILE} 中找不到 zh`);
if (newEnInLang && newEnInLang.init && ts.isObjectLiteralExpression(newEnInLang.init)) {
  fail(`${NEW_FILE} 里仍有 en 对象字面量 → 不是搬移，等价证明无意义`);
}
const enFileSrc = fs.readFileSync(path.join(CWD, NEW_EN_FILE), 'utf8');
const newEnSf = parse(enFileSrc, NEW_EN_FILE);
const newEn = findVarInit(newEnSf, 'en');
if (!newEn) fail(`${NEW_EN_FILE} 中找不到 en 字面量`);
if (newEn.typeText.replace(/\s+/g, '') !== 'Record<LangKey,string>') {
  fail(`${NEW_EN_FILE} 的 en 类型注解应为 Record<LangKey,string>，实际 ${newEn.typeText}`);
}

const allDiffs = [];
allDiffs.push(...compare('zh', evaluateObject(oldZh.init, OLD_FILE, 'zh'), evaluateObject(newZh.init, NEW_FILE, 'zh')));
allDiffs.push(
  ...compare('en', evaluateObject(oldEn.init, OLD_FILE, 'en'), evaluateObject(newEn.init, NEW_EN_FILE, 'en'))
);

// 导出面（language.ts 前后必须一致；en/zh 本来就不是导出名）
const oldSurface = exportSurface(oldSf);
const newSurface = exportSurface(newSf);
console.log(`export_surface: old=${oldSurface.length} new=${newSurface.length}`);
console.log(`  ${oldSurface.join(' | ')}`);
if (oldSurface.join('\n') !== newSurface.join('\n')) {
  allDiffs.push(`EXPORT_SURFACE_DIFF\n  old=${oldSurface.join(' | ')}\n  new=${newSurface.join(' | ')}`);
}

// 新文件里的 en 必须是 language.en.ts 的唯一来源：language.ts 只允许 import en
if (!/import\s*\{\s*en\s*\}\s*from\s*['"]\.\/language\.en['"]/.test(newSrc)) {
  allDiffs.push('IMPORT_MISSING: language.ts 未从 ./language.en 导入 en');
}

const zhCount = evaluateObject(newZh.init, NEW_FILE, 'zh').length;
const enCount = evaluateObject(newEn.init, NEW_EN_FILE, 'en').length;
const zhHash = sha(evaluateObject(newZh.init, NEW_FILE, 'zh')).hash;
const enHash = sha(evaluateObject(newEn.init, NEW_EN_FILE, 'en')).hash;

if (allDiffs.length) {
  console.error(`\nFAIL 等价证明不通过（${allDiffs.length} 处）：`);
  allDiffs.forEach((d) => console.error('  ' + d));
  process.exit(1);
}

console.log('\nPASS 等价证明：');
console.log(`  zh: ${zhCount} keys  sha256=${zhHash}`);
console.log(`  en: ${enCount} keys  sha256=${enHash}`);
console.log(`  export surface: ${newSurface.length} 项完全一致`);
console.log(`  baseline ref: ${OLD_REF}`);
