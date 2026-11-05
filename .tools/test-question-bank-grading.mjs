#!/usr/bin/env node
/** test-question-bank-grading.mjs —— 判分断言。退出码: 0 全绿；1 有失败；2 harness 出错。 */
import path from 'node:path';
import vm from 'node:vm';
import esbuild from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..');
let pass = 0, fail = 0;
function assert(name, cond) {
  if (typeof cond !== 'boolean') throw new Error(`断言「${name}」的 cond 不是 boolean：${String(cond)}`);
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`);
}
async function loadModule() {
  const built = await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/utils/questionBankGrading.ts')],
    bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node18', logLevel: 'silent'
  });
  const sandbox = { module: { exports: {} }, exports: {}, console };
  vm.runInNewContext(built.outputFiles[0].text, sandbox);
  return sandbox.module.exports;
}
const { gradeAnswer, formatAnswerKey, isResponseComplete } = await loadModule();

const mk = (patch) => ({
  id: 'qb_g', stem: '题干', stemHash: 'h', options: [{ key: 'A', text: '1' }, { key: 'B', text: '2' }],
  type: 'single', answerKey: 'B', explanation: '', examSystem: 'gaokao', board: 'china_moe',
  subject: '数学', level: 'na', knowledgeTags: ['函数与导数'], difficulty: 3, source: 'manual',
  langCode: 'zh', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...patch
});

// ── 单选：错就是错 ─────────────────────────────────────────────────────────
assert('单选答对', gradeAnswer(mk({ answerKey: 'B' }), 'B') === true);
assert('单选答错判错（不许把错判成对）', gradeAnswer(mk({ answerKey: 'B' }), 'A') === false);
assert('单选空答案判错', gradeAnswer(mk({ answerKey: 'B' }), '') === false);
assert('单选大小写/空白归一后判对', gradeAnswer(mk({ answerKey: 'B' }), '  b ') === true);

// ── 多选：顺序无关，但集合必须一致 ────────────────────────────────────────
const multi = mk({ type: 'multi', answerKey: ['A', 'C'], options: [{ key: 'A', text: '1' }, { key: 'B', text: '2' }, { key: 'C', text: '3' }] });
assert('多选顺序不同仍判对', gradeAnswer(multi, ['C', 'A']) === true);
assert('多选漏选判错', gradeAnswer(multi, ['A']) === false);
assert('多选多选判错', gradeAnswer(multi, ['A', 'B', 'C']) === false);
assert('多选空数组判错', gradeAnswer(multi, []) === false);

// ── 填空：格式宽容、内容严格、按空位对齐 ──────────────────────────────────
const fill = mk({ type: 'fill', answerKey: ['x=2', 'y=3'], options: [] });
assert('填空答对', gradeAnswer(fill, ['x=2', 'y=3']) === true);
assert('填空空白与大小写归一后判对', gradeAnswer(fill, [' X = 2 ', 'Y=3']) === true);
assert('填空全角等号归一后判对', gradeAnswer(fill, ['x＝2', 'y＝3']) === true);
assert('填空第二空错判错', gradeAnswer(fill, ['x=2', 'y=4']) === false);
assert('填空错位判错', gradeAnswer(fill, ['y=3', 'x=2']) === false);
assert('填空少答一空判错', gradeAnswer(fill, ['x=2']) === false);

// ── 判断 ──────────────────────────────────────────────────────────────────
assert('判断题答对', gradeAnswer(mk({ type: 'judge', answerKey: false, options: [] }), false) === true);
assert('判断题反选判错', gradeAnswer(mk({ type: 'judge', answerKey: true, options: [] }), false) === false);
assert('判断题未答判错', gradeAnswer(mk({ type: 'judge', answerKey: true }), null) === false);

// ── 展示与完整性 ──────────────────────────────────────────────────────────
assert('formatAnswerKey 多选用顿号拼接', formatAnswerKey(multi) === 'A、C');
assert('formatAnswerKey 判断题输出 true/false（中文由页面 i18n）', formatAnswerKey(mk({ type: 'judge', answerKey: true })) === 'true');
assert('isResponseComplete 单选空不算答完', isResponseComplete(mk({}), '') === false);
assert('isResponseComplete 填空有空不算答完', isResponseComplete(fill, ['x=2', ' ']) === false);
assert('isResponseComplete 判断 false 也算答完', isResponseComplete(mk({ type: 'judge', answerKey: true }), false) === true);

console.log(`\n── 题库判分 ──\nPASS ${pass} / FAIL ${fail}`);
process.exit(fail > 0 ? 1 : 0);
