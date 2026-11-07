#!/usr/bin/env node
/** test-question-bank-query.mjs —— 题库筛选/搜索/读取语义断言。退出码: 0 全绿；1 有失败；2 harness 出错。 */
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
    entryPoints: [path.join(ROOT, 'src/data/questionBankQuery.ts')],
    bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node18', logLevel: 'silent'
  });
  const sandbox = { module: { exports: {} }, exports: {}, console };
  vm.runInNewContext(built.outputFiles[0].text, sandbox);
  return sandbox.module.exports;
}
const { filterQuestions, searchQuestions, examSystemsOf, subjectsOf, loadQuestionBank } = await loadModule();

/** 只构造查询层关心的字段；查询不依赖 validateQuestion 的完整校验。 */
const mk = (patch) => ({
  id: 'qb_q', stem: '题干', stemHash: 'h', options: [{ key: 'A', text: '1' }, { key: 'B', text: '2' }],
  type: 'single', answerKey: 'A', explanation: '', examSystem: 'gaokao', board: 'china_moe',
  subject: '数学', level: 'na', knowledgeTags: ['函数与导数'], difficulty: 3, source: 'manual',
  langCode: 'zh', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...patch
});
const QUESTIONS = [
  mk({ id: 'qb_g1', examSystem: 'gaokao', subject: '数学', stem: '已知函数 $f(x)=x^{2}$，求导。', knowledgeTags: ['函数与导数'] }),
  mk({ id: 'qb_z1', examSystem: 'zhongkao', subject: '数学', stem: '解一元二次方程。', knowledgeTags: ['二次函数'] }),
  mk({ id: 'qb_i1', examSystem: 'igcse', subject: 'mathematics', stem: 'Find the gradient of the line.', knowledgeTags: ['algebra'] }),
  mk({ id: 'qb_a1', examSystem: 'alevel', subject: 'mathematics', stem: 'Differentiate $x^{3}$.', knowledgeTags: ['differentiation'], explanation: 'Power rule applies.' }),
  mk({ id: 'qb_ib1', examSystem: 'ib', subject: 'mathematics-aa', stem: 'Prove by induction.', knowledgeTags: ['proof'], explanation: 'Use the induction hypothesis.' })
];
const fakeStorage = (initial) => {
  const m = new Map(Object.entries(initial || {}));
  return { getStorageSync: (k) => (m.has(k) ? m.get(k) : ''), setStorageSync: (k, v) => m.set(k, v) };
};

// ── 筛选：体系 / 学科（闭集 key 不扁平化）──────────────────────────────────
assert('按体系筛选只返回该体系', filterQuestions(QUESTIONS, { examSystem: 'ib' }).every((q) => q.examSystem === 'ib') && filterQuestions(QUESTIONS, { examSystem: 'ib' }).length === 1);
assert('按体系+学科筛选返回精确一条', filterQuestions(QUESTIONS, { examSystem: 'gaokao', subject: '数学' }).map((q) => q.id).join() === 'qb_g1');
assert(
  '同名学科在不同体系不混：igcse:mathematics 只回 igcse，不带上 alevel',
  filterQuestions(QUESTIONS, { examSystem: 'igcse', subject: 'mathematics' }).every((q) => q.examSystem === 'igcse') &&
    filterQuestions(QUESTIONS, { examSystem: 'igcse', subject: 'mathematics' }).length === 1
);
assert('学科筛选不改变原数组', QUESTIONS.length === 5 && filterQuestions(QUESTIONS, { examSystem: 'gaokao' }).length === 1);
assert('无条件筛选返回全量', filterQuestions(QUESTIONS, {}).length === 5);
assert('不存在的体系返回空数组（不是全量）', filterQuestions(QUESTIONS, { examSystem: 'ap' }).length === 0);

// ── 搜索：题干 / 解析 / 知识点 / 归一化 ────────────────────────────────────
assert('关键词命中题干', searchQuestions(QUESTIONS, 'differentiate').map((q) => q.id).join() === 'qb_a1');
assert('关键词大小写与空白归一后命中题干', searchQuestions(QUESTIONS, '  FIND   the gradient ').map((q) => q.id).join() === 'qb_i1');
assert('关键词命中解析', searchQuestions(QUESTIONS, 'power rule').map((q) => q.id).join() === 'qb_a1');
assert('关键词命中知识点', searchQuestions(QUESTIONS, '函数与导数').map((q) => q.id).join() === 'qb_g1');
assert('空关键词等于不搜索', searchQuestions(QUESTIONS, '   ').length === 5);
assert('无命中返回空数组（不是全量）', searchQuestions(QUESTIONS, 'zzz-no-such').length === 0);
assert('筛选+搜索叠加', filterQuestions(QUESTIONS, { examSystem: 'alevel', keyword: 'differentiate' }).map((q) => q.id).join() === 'qb_a1');

// ── 派生清单 ──────────────────────────────────────────────────────────────
assert('examSystemsOf 只列出现的体系且按枚举序', examSystemsOf(QUESTIONS).join() === 'gaokao,zhongkao,igcse,alevel,ib');
assert('subjectsOf 按体系隔离', subjectsOf(QUESTIONS, 'igcse').join() === 'mathematics' && subjectsOf(QUESTIONS, 'ib').join() === 'mathematics-aa');
assert('subjectsOf 空体系返回空', subjectsOf(QUESTIONS, 'ap').length === 0);

// ── 读取语义：失败 ≠ 0 题 ──────────────────────────────────────────────────
const emptyLoad = loadQuestionBank(fakeStorage());
assert('空存储 = ok + 空数组（用户真的还没录题）', emptyLoad.status === 'ok' && emptyLoad.questions.length === 0);
const okLoad = loadQuestionBank(fakeStorage({ questionBank: { version: 1, questions: QUESTIONS } }));
assert('正常存储读回全部题目', okLoad.status === 'ok' && okLoad.questions.length === 5);
const corrupt = loadQuestionBank(fakeStorage({ questionBank: { version: 1, questions: {} } }));
assert('questions 非数组 → error，不降级成空题库', corrupt.status === 'error' && corrupt.code === 'questionBank.corrupt');
assert('损坏时结果里没有 questions 字段（不可能被当成 0 题）', !('questions' in corrupt));
const unsupported = loadQuestionBank(fakeStorage({ questionBank: { version: 99, questions: [] } }));
assert('未知版本 → error 且保留 versionUnsupported', unsupported.status === 'error' && unsupported.code === 'questionBank.versionUnsupported');
assert('非对象存储 → error', loadQuestionBank(fakeStorage({ questionBank: 'oops' })).status === 'error');

console.log(`\n── 题库查询层 ──\nPASS ${pass} / FAIL ${fail}`);
process.exit(fail > 0 ? 1 : 0);
