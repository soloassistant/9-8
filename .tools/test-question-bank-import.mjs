#!/usr/bin/env node
/** test-question-bank-import.mjs —— PR-A：JSON 解析 + 结构/语义两层校验。 */
import path from 'node:path';
import vm from 'node:vm';
import esbuild from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..');
let pass = 0, fail = 0;
function assert(name, cond) {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`);
}
async function load(entry) {
  const built = await esbuild.build({
    entryPoints: [path.join(ROOT, entry)], bundle: true, write: false, format: 'cjs',
    platform: 'node', target: 'node18', logLevel: 'silent'
  });
  const sandbox = { module: { exports: {} }, exports: {}, console };
  vm.runInNewContext(built.outputFiles[0].text, sandbox);
  return sandbox.module.exports;
}
const utils = await load('src/utils/questionBank.ts');
const { parseQuestionBank } = await load('src/data/questionBankImport.ts');
const FIXED = '2026-11-06T00:00:00.000Z';
const mk = (patch = {}) => ({
  stem: '计算 $2+3$ 的值。', options: [{ key: 'A', text: '4' }, { key: 'B', text: '5' }],
  type: 'single', answerKey: 'B', examSystem: 'gaokao', board: 'china_moe', subject: '数学',
  level: 'na', knowledgeTags: ['集合与常用逻辑'], difficulty: 1, source: 'import', langCode: 'zh', ...patch
});
const parse = (rows) => parseQuestionBank(JSON.stringify(rows), { now: () => FIXED });
const one = (patch) => parse([mk(patch)]);

// 成功：id 规则、stemHash 重算、时间戳
{
  const res = parse([
    mk({ id: 'qb_manual00001' }),
    mk({ stem: '求 $\\sqrt{16}$ 的值。', type: 'fill', options: [], answerKey: ['4'], knowledgeTags: ['函数与导数'] })
  ]);
  assert('JSON：2 行全部成为候选', res.totalRows === 2 && res.candidates.length === 2 && res.rejected.length === 0);
  assert('id：外部 id 保留、留空按 qb_ 规则生成', res.candidates[0].question.id === 'qb_manual00001' && res.candidates[1].question.id.startsWith('qb_'));
  assert('stemHash：按题干重算，等于 utils.stemHash', res.candidates[0].question.stemHash === utils.stemHash(mk().stem));
  assert('时间戳：createdAt/updatedAt 由注入的 now() 填充', res.candidates[0].question.createdAt === FIXED && res.candidates[0].question.updatedAt === FIXED);
  const warn = one({ examSystem: 'igcse', board: 'cie', subject: 'mathematics', level: 'foundation', langCode: 'zh', knowledgeTags: ['number'] });
  assert('warning：英文卷用 zh 只提示、仍成为候选', warn.candidates.length === 1 && warn.warnings.some((w) => w.code === 'langCode.zhInEnglishExam'));
}

// 结构层反例（每条拒绝原因一条）
const cases = [
  ['缺 stem', { stem: '' }, 'structure.required', 'stem', 'structure'],
  ['缺 knowledgeTags', { knowledgeTags: undefined }, 'structure.required', 'knowledgeTags', 'structure'],
  ['difficulty 类型', { difficulty: '3' }, 'structure.type', 'difficulty', 'structure'],
  ['options 类型', { options: 'A|4' }, 'structure.type', 'options', 'structure'],
  ['填空答案类型', { type: 'fill', options: [], answerKey: '4' }, 'structure.type', 'answerKey', 'structure'],
  ['id 类型', { id: 1 }, 'structure.type', 'id', 'structure'],
  ['year 类型', { year: '2020' }, 'structure.type', 'year', 'structure'],
  ['board 枚举', { board: 'cambridge' }, 'structure.enum', 'board', 'structure'],
  ['外部 stemHash', { stemHash: 'deadbeef' }, 'structure.stemHashNotAllowed', 'stemHash', 'structure'],
  ['题干过短', { stem: 'ab' }, 'stem.tooShort', 'stem', 'semantic'],
  ['难度越界', { difficulty: 9 }, 'difficulty.range', 'difficulty', 'semantic'],
  ['少选项', { options: [{ key: 'A', text: '4' }] }, 'options.tooFew', 'options', 'semantic'],
  ['选项 key 重复', { options: [{ key: 'A', text: '4' }, { key: 'A', text: '5' }], answerKey: 'A' }, 'options.keyDuplicate', 'options[1].key', 'semantic'],
  ['答案不在选项', { answerKey: 'C' }, 'answerKey.notInOptions', 'answerKey', 'semantic'],
  ['知识点为空', { knowledgeTags: [] }, 'knowledgeTags.empty', 'knowledgeTags', 'semantic'],
  ['知识点越界', { knowledgeTags: ['牛顿力学'] }, 'knowledgeTags.unknown', 'knowledgeTags', 'semantic'],
  ['学科不在体系', { subject: 'physics' }, 'subject.unknown', 'subject', 'semantic'],
  ['层级不自洽', { examSystem: 'ib', board: 'ibo', subject: 'mathematics-aa', level: 'na', langCode: 'en', knowledgeTags: ['algebra'] }, 'level.mismatch', 'level', 'semantic'],
  ['年份越界', { year: 1800 }, 'year.invalid', 'year', 'semantic'],
  ['填空题带选项', { type: 'fill', options: [{ key: 'A', text: '4' }], answerKey: ['4'] }, 'options.notApplicable', 'options', 'semantic']
];
for (const [name, patch, code, field, layer] of cases) {
  const res = one(patch);
  assert(`${layer} 反例：${name}`, res.candidates.length === 0 && res.rejected.some((r) => r.code === code && r.field === field && r.layer === layer));
}

// 整文件与行结构
{
  const shape = parseQuestionBank(JSON.stringify({ foo: 1 }));
  assert('整文件：顶层形状不对报 structure.jsonShape', shape.rejected[0]?.code === 'structure.jsonShape' && shape.rejected[0]?.row === 0);
  const bad = parseQuestionBank('not json');
  assert('整文件：JSON 语法错误报 structure.jsonParse', bad.rejected[0]?.code === 'structure.jsonParse');
  const row = parseQuestionBank(JSON.stringify([1]));
  assert('行：不是对象报 structure.rowNotObject', row.rejected[0]?.code === 'structure.rowNotObject' && row.rejected[0]?.row === 1);
}

console.log(`\n结果: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
