#!/usr/bin/env node
/** test-question-bank.mjs —— PR-1 题库模型/校验/去重断言。退出码: 0 全绿；1 有失败；2 harness 出错。 */
import path from 'node:path';
import vm from 'node:vm';
import esbuild from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..');
let pass = 0;
let fail = 0;
function assert(name, cond) {
  if (typeof cond !== 'boolean') throw new Error(`断言「${name}」的 cond 不是 boolean：${String(cond)}`);
  if (cond) pass++;
  else fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`);
}
async function loadModule() {
  const built = await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/utils/questionBank.ts')],
    bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node18', logLevel: 'silent'
  });
  const sandbox = { module: { exports: {} }, exports: {}, console };
  vm.runInNewContext(built.outputFiles[0].text, sandbox);
  return sandbox.module.exports;
}
const { validateQuestion, normalizeStem, stemHash, findDuplicates, questionId } = await loadModule();
const STEM = '已知函数 $f(x)=x^{2}+2x$，求 $f(1)$ 的值。';
const base = {
  id: 'q-base', stem: STEM, stemHash: stemHash(STEM),
  options: [{ key: 'A', text: '1' }, { key: 'B', text: '3' }, { key: 'C', text: '4' }, { key: 'D', text: '5' }],
  type: 'single', answerKey: 'B', explanation: '代入得 3。',
  examSystem: 'gaokao', board: 'china_moe', subject: '数学', level: 'na',
  syllabusCode: '2024-新高考I', year: 2024, paper: '1',
  knowledgeTags: ['函数与导数'], difficulty: 3, source: 'manual', langCode: 'zh',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
};
const q = (patch) => ({ ...base, ...patch });
const hasField = (r, field, code) => r.ok === false && r.errors.some((e) => e.field === field && (!code || e.code === code));

assert('合法题全字段通过、无 warning', validateQuestion(base).ok === true && validateQuestion(base).warnings.length === 0);
assert('合法填空题通过', validateQuestion(q({ type: 'fill', options: [], answerKey: ['1', '2'] })).ok === true);
assert('合法判断题通过', validateQuestion(q({ type: 'judge', options: [], answerKey: true })).ok === true);
assert('explanation 可空', validateQuestion(q({ explanation: undefined })).ok === true);
assert('题干过短 → field=stem', hasField(validateQuestion(q({ stem: '1+1' })), 'stem', 'stem.tooShort'));
assert('stemHash 为空 → field=stemHash', hasField(validateQuestion(q({ stemHash: ' ' })), 'stemHash', 'stemHash.empty'));
assert('选项 key 重复 → field=options[2].key', hasField(validateQuestion(q({ options: [{ key: 'A', text: '1' }, { key: 'B', text: '2' }, { key: 'B', text: '3' }] })), 'options[2].key', 'options.keyDuplicate'));
assert('选项空 text → field=options[0].text', hasField(validateQuestion(q({ options: [{ key: 'A', text: ' ' }, { key: 'B', text: '2' }] })), 'options[0].text', 'options.textEmpty'));
assert('选择题少于 2 个选项 → field=options', hasField(validateQuestion(q({ options: [{ key: 'A', text: '1' }] })), 'options', 'options.tooFew'));
assert('填空题带选项 → field=options', hasField(validateQuestion(q({ type: 'fill', options: [{ key: 'A', text: '1' }], answerKey: ['1'] })), 'options', 'options.notApplicable'));
assert('单选答案不在选项内 → field=answerKey', hasField(validateQuestion(q({ answerKey: 'E' })), 'answerKey', 'answerKey.notInOptions'));
assert('单选取数组 → field=answerKey', hasField(validateQuestion(q({ answerKey: ['A'] })), 'answerKey', 'answerKey.singleType'));
assert('多选空数组 → field=answerKey', hasField(validateQuestion(q({ type: 'multi', answerKey: [] })), 'answerKey', 'answerKey.multiEmpty'));
assert('多选答案越界 → field=answerKey[1]', hasField(validateQuestion(q({ type: 'multi', answerKey: ['A', 'E'] })), 'answerKey[1]', 'answerKey.notInOptions'));
assert('判断题给 A → field=answerKey', hasField(validateQuestion(q({ type: 'judge', options: [], answerKey: 'A' })), 'answerKey', 'answerKey.judgeType'));
assert('填空题给布尔 → field=answerKey', hasField(validateQuestion(q({ type: 'fill', options: [], answerKey: true })), 'answerKey', 'answerKey.fillEmpty'));
assert('非法知识点整体 fail 且消息含 tag 与 syllabus', (() => {
  const r = validateQuestion(q({ knowledgeTags: ['函数与导数', '量子力学'] }));
  return r.ok === false && r.errors.some((e) => e.field === 'knowledgeTags' && e.message.includes('量子力学') && e.message.includes('gaokao:数学'));
})());
assert('未知 syllabus → field=subject', hasField(validateQuestion(q({ subject: '物理' })), 'subject', 'syllabus.unknown'));
assert('非法 examSystem=gre → field=examSystem', hasField(validateQuestion(q({ examSystem: 'gre' })), 'examSystem', 'examSystem.invalid'));
assert('level 与 examSystem 不自洽 → field=level', hasField(validateQuestion(q({ level: 'hl' })), 'level', 'level.mismatch'));
assert('IB 只允许 hl/sl → field=level', hasField(validateQuestion(q({ examSystem: 'ib', board: 'ibo', subject: 'mathematics-aa', level: 'na', langCode: 'en', knowledgeTags: ['algebra'] })), 'level', 'level.mismatch'));
assert('IB + zh 只 warning 不 error', (() => {
  const r = validateQuestion(q({ examSystem: 'ib', board: 'ibo', subject: 'mathematics-aa', level: 'hl', langCode: 'zh', knowledgeTags: ['algebra'] }));
  return r.ok === true && r.warnings.some((w) => w.code === 'langCode.zhInEnglishExam');
})());
assert('难度 3.5 → field=difficulty', hasField(validateQuestion(q({ difficulty: 3.5 })), 'difficulty', 'difficulty.range'));
assert('难度 0 → field=difficulty', hasField(validateQuestion(q({ difficulty: 0 })), 'difficulty', 'difficulty.range'));
assert('难度 6 → field=difficulty', hasField(validateQuestion(q({ difficulty: 6 })), 'difficulty', 'difficulty.range'));
assert('非法 langCode=fr → field=langCode', hasField(validateQuestion(q({ langCode: 'fr' })), 'langCode', 'langCode.invalid'));
assert('非法 year=2024.5 → field=year', hasField(validateQuestion(q({ year: 2024.5 })), 'year', 'year.invalid'));
assert('题号/空白/全半角被归一化吃掉', normalizeStem('1. 计算 1+1') === normalizeStem('计算　1＋1'));
assert('同题干哈希一致', stemHash('1. 计算 1+1') === stemHash('计算　1＋1'));
assert('大小写差异不判不同题', normalizeStem('ABC') === normalizeStem('ａｂｃ'));
const r1 = q({ id: 'q-rev', stem: '计算 1+1', stemHash: stemHash('计算 1+1') });
const r2 = q({ id: 'q-rev', stem: '计算 2+2', stemHash: stemHash('计算 2+2') });
assert('同一 id 改题干：id 不变、stemHash 变', r1.id === r2.id && r1.stemHash !== r2.stemHash);
assert('修订后不判重复', findDuplicates([r1, r2]).length === 0);
assert('findDuplicates 合并同题干', (() => {
  const g = findDuplicates([q({ id: 'q-a', stem: '1. 计算 1+1', stemHash: stemHash('1. 计算 1+1') }), q({ id: 'q-b', stem: '计算　1＋1', stemHash: stemHash('计算　1＋1') })]);
  return g.length === 1 && g[0].questionIds.join(',') === 'q-a,q-b';
})());
assert('zh 与 en 同题干不合并', findDuplicates([q({ id: 'q-zh' }), q({ id: 'q-en', langCode: 'en' })]).length === 0);
const seeded = (seed) => { let x = seed; return () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x80000000; }; };
const idA = questionId(seeded(42));
assert('固定种子复现 id', idA === questionId(seeded(42)));
assert('不同种子产生不同 id', idA !== questionId(seeded(7)));
assert('id 格式为 qb_+12 位 base36', /^qb_[0-9a-z]{12}$/.test(idA));
console.log(`\n结果: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
