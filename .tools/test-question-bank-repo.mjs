#!/usr/bin/env node
/** test-question-bank-repo.mjs —— PR-2 题库仓储层断言。退出码: 0 全绿；1 有失败；2 harness 出错。 */
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
  const built = await esbuild.build({ entryPoints: [path.join(ROOT, 'src/data/questionBankRepo.ts')], bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node18', logLevel: 'silent' });
  const sandbox = { module: { exports: {} }, exports: {}, console };
  vm.runInNewContext(built.outputFiles[0].text, sandbox);
  return sandbox.module.exports;
}
const { createQuestionBankRepo, QuestionBankError, QUESTION_BANK_SCHEMA_VERSION } = await loadModule();

/** 假存储：深拷贝写入模拟真实序列化；缺失返回 ''（与 Taro.getStorageSync 一致）。 */
const fakeStorage = (initial) => {
  const m = new Map(Object.entries(initial || {}));
  const clone = (v) => JSON.parse(JSON.stringify(v));
  return { getStorageSync: (k) => (m.has(k) ? m.get(k) : ''), setStorageSync: (k, v) => m.set(k, clone(v)), raw: (k) => m.get(k) };
};
let tick = 0;
const clock = () => `2026-02-01T00:00:${String(tick++).padStart(2, '0')}.000Z`;
const repoOn = (storage, opts = {}) => createQuestionBankRepo(storage, { now: clock, ...opts });
const mk = (patch) => ({
  id: 'qb_fixed000001', stem: '已知函数 $f(x)=x^{2}$，求 $f(1)$ 的值。', stemHash: 'stale',
  options: [{ key: 'A', text: '1' }, { key: 'B', text: '3' }], type: 'single', answerKey: 'B',
  examSystem: 'gaokao', board: 'china_moe', subject: '数学', level: 'na', knowledgeTags: ['函数与导数'],
  difficulty: 3, source: 'manual', langCode: 'zh', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...patch
});
const throwsCode = (fn, code) => {
  try { fn(); return false; } catch (e) { return e instanceof QuestionBankError && e.code === code; }
};

// ── 空库与 add ────────────────────────────────────────────────────────────
const s1 = fakeStorage();
const r1 = repoOn(s1);
assert('空存储 list 为空', r1.list().length === 0);
assert('空存储 getById 返回 null', r1.getById('qb_fixed000001') === null);
const added = r1.add(mk());
assert('add 后 getById 命中同一条', r1.getById('qb_fixed000001')?.id === 'qb_fixed000001');
assert('add 后 list 含该题', r1.list().length === 1 && r1.list()[0].id === 'qb_fixed000001');
assert('add 用当前题干重算 stemHash（不信任传入旧值）', added.stemHash !== 'stale');
assert('add 写入 version 字段', s1.raw('questionBank').version === QUESTION_BANK_SCHEMA_VERSION);
assert('add 重复 id 报 duplicateId', throwsCode(() => r1.add(mk()), 'questionBank.duplicateId'));

// ── update：id 不变、stemHash 跟题干走 ─────────────────────────────────────
const before = r1.getById('qb_fixed000001');
const revised = r1.update('qb_fixed000001', { stem: '已知函数 $f(x)=x^{2}+1$，求 $f(1)$ 的值。' });
assert('update 改题干后 id 不变', revised.id === before.id);
assert('update 改题干后 stemHash 变', revised.stemHash !== before.stemHash);
assert('update 改题干后 updatedAt 变', revised.updatedAt !== before.updatedAt);
assert('update 不改 createdAt', revised.createdAt === before.createdAt);
assert('update 后库里仍只有 1 条（不是新题）', r1.list().length === 1);
const sameStem = r1.update('qb_fixed000001', { difficulty: 4 });
assert('update 只改难度时 stemHash 不变', sameStem.stemHash === revised.stemHash && sameStem.difficulty === 4);
assert('update 未知 id 报 notFound', throwsCode(() => r1.update('qb_nope', { difficulty: 2 }), 'questionBank.notFound'));

// ── remove ────────────────────────────────────────────────────────────────
assert('remove 后 list 不含', (() => { r1.remove('qb_fixed000001'); return r1.list().length === 0; })());
assert('remove 后 getById 返回 null', r1.getById('qb_fixed000001') === null);
assert('remove 不存在的 id 返回 false 且库不变', (() => {
  const s = fakeStorage(); const r = repoOn(s); r.add(mk({ id: 'qb_keep0000001' }));
  return r.remove('qb_missing0001') === false && r.list().length === 1;
})());

// ── 版本与迁移骨架 ────────────────────────────────────────────────────────
assert('未知版本报 versionUnsupported 且不清空存储', (() => {
  const s = fakeStorage({ questionBank: { version: 99, questions: [mk()] } });
  const threw = throwsCode(() => repoOn(s).list(), 'questionBank.versionUnsupported');
  const raw = s.raw('questionBank');
  return threw && raw.version === 99 && Array.isArray(raw.questions) && raw.questions.length === 1;
})());
assert('version 非整数报 corrupt', throwsCode(() => repoOn(fakeStorage({ questionBank: { version: '1', questions: [] } })).list(), 'questionBank.corrupt'));
assert('questions 非数组报 corrupt', throwsCode(() => repoOn(fakeStorage({ questionBank: { version: 1, questions: {} } })).list(), 'questionBank.corrupt'));

// ── 导入判重（不覆盖，返回疑似重复清单）───────────────────────────────────
assert('导入重复题干不覆盖，库里保留原 id', (() => {
  const s = fakeStorage(); const r = repoOn(s);
  r.add(mk({ id: 'qb_orig0000001' }));
  const out = r.importQuestions([mk({ id: 'qb_new00000001' })]);
  return out.added.length === 0 && out.duplicates.length === 1
    && out.duplicates[0].matchedId === 'qb_orig0000001' && out.duplicates[0].reason === 'stem'
    && r.list().length === 1 && r.getById('qb_orig0000001') !== null;
})());
assert('同批内重复只留第一条', (() => {
  const s = fakeStorage(); const r = repoOn(s);
  const out = r.importQuestions([mk({ id: 'qb_b1' }), mk({ id: 'qb_b2' })]);
  return out.added.length === 1 && out.added[0].id === 'qb_b1' && out.duplicates[0].matchedId === 'qb_b1';
})());
assert('跨语言同题干不并成重复', (() => {
  const out = repoOn(fakeStorage()).importQuestions([mk({ id: 'qb_zh00000001' }), mk({ id: 'qb_en00000001', langCode: 'en' })]);
  return out.added.length === 2 && out.duplicates.length === 0;
})());
assert('全新题目全部入库', (() => {
  const s = fakeStorage(); const r = repoOn(s);
  const out = r.importQuestions([mk({ id: 'qb_x000000001', stem: '计算 1+1 的值。' }), mk({ id: 'qb_y000000001', stem: '计算 2+2 的值。' })]);
  return out.added.length === 2 && out.duplicates.length === 0 && r.list().length === 2;
})());
assert('导入与既有 id 撞车不覆盖，reason=id', (() => {
  const s = fakeStorage(); const r = repoOn(s);
  r.add(mk({ id: 'qb_dup00000001', stem: '原题干内容。' }));
  const out = r.importQuestions([mk({ id: 'qb_dup00000001', stem: '完全不同的题干。' })]);
  return out.added.length === 0 && out.duplicates[0].reason === 'id' && r.getById('qb_dup00000001').stem === '原题干内容。';
})());
assert('修订后旧题干不再是重复（指纹已更新）', (() => {
  const s = fakeStorage(); const r = repoOn(s);
  r.add(mk({ id: 'qb_rev00000001' }));
  r.update('qb_rev00000001', { stem: '修订后的新题干内容。' });
  const out = r.importQuestions([mk({ id: 'qb_old00000001' })]);
  return out.added.length === 1 && out.duplicates.length === 0;
})());

console.log(`\n结果: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
