#!/usr/bin/env node
/** test-question-bank-progress.mjs —— 答题记录/错题本断言。退出码: 0 全绿；1 有失败；2 harness 出错。 */
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
    entryPoints: [path.join(ROOT, 'src/data/questionBankProgress.ts')],
    bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node18', logLevel: 'silent'
  });
  const sandbox = { module: { exports: {} }, exports: {}, console };
  vm.runInNewContext(built.outputFiles[0].text, sandbox);
  return sandbox.module.exports;
}
const { createQuestionBankProgress, QuestionBankProgressError, QUESTION_BANK_PROGRESS_KEY } = await loadModule();

const fakeStorage = (initial) => {
  const m = new Map(Object.entries(initial || {}));
  return { getStorageSync: (k) => (m.has(k) ? m.get(k) : ''), setStorageSync: (k, v) => m.set(k, v), raw: (k) => m.get(k) };
};
let tick = 0;
const clock = () => `2026-02-01T00:00:${String(tick++).padStart(2, '0')}.000Z`;
const on = (s) => createQuestionBankProgress(s, { now: clock });
const throwsCode = (fn, code) => {
  try { fn(); return false; } catch (e) { return e instanceof QuestionBankProgressError && e.code === code; }
};

const s = fakeStorage();
const p = on(s);
assert('空记录 list 为空', p.list().length === 0);
assert('空记录 mistakes 为空', p.mistakes().length === 0);
assert('空记录 stats 为零', p.stats().attempts === 0 && p.stats().correctRate === 0 && p.stats().wrongQuestions === 0);
assert('未答过的题 get 返回 null', p.get('qb_none') === null);

const ok = p.record('qb_a', true);
assert('首次答对：1 次作答 / 1 次正确 / 0 次答错', ok.attempts === 1 && ok.correctCount === 1 && ok.wrongCount === 0 && ok.lastCorrect === true);
assert('答对不进错题本', p.mistakes().length === 0);
assert('record 写入 version', s.raw(QUESTION_BANK_PROGRESS_KEY).version === 1);

p.record('qb_b', false);
assert('答错：wrongCount=1 且 lastCorrect=false', p.get('qb_b').wrongCount === 1 && p.get('qb_b').lastCorrect === false);
assert('答错进错题本', p.mistakes().map((e) => e.questionId).join() === 'qb_b');

const again = p.record('qb_b', true);
assert('错题再答对仍保留错题记录（累计不抹除）', again.attempts === 2 && again.wrongCount === 1 && again.correctCount === 1 && again.lastCorrect === true);
assert('错过的题仍在错题本', p.mistakes().map((e) => e.questionId).join() === 'qb_b');

p.record('qb_c', false);
assert('错题本按最近作答倒序', p.mistakes().map((e) => e.questionId).join() === 'qb_c,qb_b');
assert('stats：3 题 / 4 次 / 正确率 0.5 / 错题 2', (() => {
  const st = p.stats();
  return st.answeredQuestions === 3 && st.attempts === 4 && st.correctRate === 0.5 && st.wrongQuestions === 2;
})());
assert('空 questionId 拒绝记录', throwsCode(() => p.record('', true), 'questionBankProgress.invalidId'));

assert('version 不支持报错且不清空存储', (() => {
  const bad = fakeStorage({ [QUESTION_BANK_PROGRESS_KEY]: { version: 99, entries: [] } });
  const threw = throwsCode(() => on(bad).list(), 'questionBankProgress.versionUnsupported');
  return threw && bad.raw(QUESTION_BANK_PROGRESS_KEY).version === 99;
})());
assert('entries 非数组报错', throwsCode(() => on(fakeStorage({ [QUESTION_BANK_PROGRESS_KEY]: { version: 1, entries: {} } })).list(), 'questionBankProgress.corrupt'));
assert('记录不是对象报错', throwsCode(() => on(fakeStorage({ [QUESTION_BANK_PROGRESS_KEY]: 'oops' })).list(), 'questionBankProgress.corrupt'));

console.log(`\n── 题库答题记录 ──\nPASS ${pass} / FAIL ${fail}`);
process.exit(fail > 0 ? 1 : 0);
