#!/usr/bin/env node
/** test-question-bank-import.mjs —— PR-A：JSON 解析 + 结构/语义校验；PR-B：CSV、判重、分批写入。 */
import fs from 'node:fs';
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
const { parseQuestionBank, importQuestionBank } = await load('src/data/questionBankImport.ts');
const { createQuestionBankRepo } = await load('src/data/questionBankRepo.ts');
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
  const bad = parseQuestionBank('not json', { format: 'json' });
  assert('整文件：JSON 语法错误报 structure.jsonParse', bad.rejected[0]?.code === 'structure.jsonParse');
  const row = parseQuestionBank(JSON.stringify([1]));
  assert('行：不是对象报 structure.rowNotObject', row.rejected[0]?.code === 'structure.rowNotObject' && row.rejected[0]?.row === 1);
}

// ===== PR-B：判重 + 分批写入 + CSV =====
const repoOf = () => createQuestionBankRepo(
  (() => {
    const map = new Map();
    return {
      getStorageSync: (k) => (map.has(k) ? map.get(k) : ''),
      setStorageSync: (k, v) => map.set(k, JSON.parse(JSON.stringify(v)))
    };
  })(),
  { now: () => FIXED }
);
const seed = (repo, patches) => {
  const res = parse(patches.map((p) => mk(p)));
  repo.importQuestions(res.candidates.map((c) => c.question));
  return res.candidates.map((c) => c.question);
};
const distinct = (n) => Array.from({ length: n }, (_, i) => mk({ id: `qb_batch${String(i).padStart(5, '0')}`, stem: `题干示例第 ${i + 1} 题：计算 1+1 的值。` }));

// 成功 + 进度
{
  const repo = repoOf();
  const progress = [];
  const res = importQuestionBank(repo, JSON.stringify([mk(), mk({ stem: '求根号十六的值。', type: 'fill', options: [], answerKey: ['4'], knowledgeTags: ['函数与导数'] })]), { now: () => FIXED, onProgress: (p) => progress.push(p) });
  assert('导入：2 行全部落盘', res.imported === 2 && res.importedIds.length === 2 && repo.list().length === 2);
  assert('导入：默认 1 批，进度节点 processed/total 正确', res.batches === 1 && progress.length === 1 && progress[0].processed === 2 && progress[0].total === 2);
}

// 分批
{
  const repo = repoOf();
  const progress = [];
  const res = importQuestionBank(repo, JSON.stringify(distinct(5)), { batchSize: 2, onProgress: (p) => progress.push(p) });
  assert('批次：5 行按 2/批写成 3 批', res.batches === 3 && res.imported === 5);
  assert('批次：进度逐批推进到 total', progress.length === 3 && progress.map((p) => p.processed).join(',') === '2,4,5' && progress[2].batch === 3);
}

// 既有重复
{
  const repo = repoOf();
  seed(repo, [{ id: 'qb_seed000001', stem: '已有题目：计算 2+2 的值。' }]);
  const res = importQuestionBank(repo, JSON.stringify([mk({ stem: '已有题目：计算 2+2 的值。' })]));
  assert('既有重复：不落盘、报 matchedId 与行号', res.imported === 0 && res.duplicates.length === 1 && res.duplicates[0].reason === 'existing' && res.duplicates[0].matchedId === 'qb_seed000001' && res.duplicates[0].row === 1);
  assert('既有重复：库内条数不变', repo.list().length === 1);
}

// 批内重复
{
  const repo = repoOf();
  const res = importQuestionBank(repo, JSON.stringify([mk({ id: 'qb_dup0000001' }), mk({ id: 'qb_dup0000002' })]));
  assert('批内重复：先来的保留、后来的报 within-batch', res.imported === 1 && res.duplicates.length === 1 && res.duplicates[0].reason === 'within-batch' && res.duplicates[0].matchedId === 'qb_dup0000001' && res.duplicates[0].row === 2);
}

// id 撞车不覆盖
{
  const repo = repoOf();
  seed(repo, [{ id: 'qb_keep000001', stem: '原有题干：计算 3+3 的值。' }]);
  const res = importQuestionBank(repo, JSON.stringify([mk({ id: 'qb_keep000001', stem: '另一道完全不同的题干：计算 4+4 的值。' })]));
  assert('id 撞车：报 reason id 且不落盘', res.imported === 0 && res.duplicates[0].reason === 'id' && res.duplicates[0].matchedId === 'qb_keep000001');
  assert('id 撞车：库内原题内容未被覆盖', repo.list()[0].stem === '原有题干：计算 3+3 的值。');
}

// 某批写入失败：不回滚已成功批次
{
  const repo = repoOf();
  let calls = 0;
  const flaky = {
    ...repo,
    importQuestions: (qs) => {
      calls += 1;
      if (calls === 2) throw new Error('storage full');
      return repo.importQuestions(qs);
    }
  };
  const progress = [];
  const res = importQuestionBank(flaky, JSON.stringify(distinct(5)), { batchSize: 2, onProgress: (p) => progress.push(p) });
  assert('批失败：failedBatches=1，后续批次照常写入', res.failedBatches === 1 && res.batches === 3 && res.imported === 3 && repo.list().length === 3);
  assert('批失败：该批两行各报 batch.writeFailed，行号 3/4', res.rejected.filter((r) => r.code === 'batch.writeFailed' && r.layer === 'batch').map((r) => r.row).join(',') === '3,4');
}

// CSV：自动识别 + 成功
{
  const repo = repoOf();
  const head = 'id,stem,options,type,answerKey,examSystem,board,subject,level,knowledgeTags,difficulty,langCode';
  const text = [
    head,
    ',计算 $1+1$ 的值。,A|1;B|2,single,A,gaokao,china_moe,数学,na,集合与常用逻辑,1,zh',
    ',求根号九的值。,,fill,3,gaokao,china_moe,数学,na,函数与导数,1,zh'
  ].join('\n');
  const res = importQuestionBank(repo, text);
  assert('CSV：自动识别为 csv 并导入 2 行', res.format === 'csv' && res.imported === 2 && res.rejected.length === 0);
  assert('CSV：fill 空 options 不误报 notApplicable', repo.list().filter((q) => q.type === 'fill').length === 1);
}

// CSV：表头/语法/单元格反例
{
  const head = 'id,stem,options,type,answerKey,examSystem,board,subject,level,knowledgeTags,difficulty,langCode';
  const missing = parseQuestionBank('stem,options,type,answerKey,examSystem,board,subject,level,knowledgeTags,difficulty', {});
  assert('CSV：缺 langCode 列表头报 csv.headerMissing', missing.rejected[0]?.code === 'csv.headerMissing' && missing.rejected[0]?.field === 'langCode' && missing.rejected[0]?.row === 1);
  const hashed = parseQuestionBank([head + ',stemHash', ',a,b,single,A,gaokao,china_moe,数学,na,集合与常用逻辑,1,zh,x'].join('\n'), {});
  assert('CSV：携带 stemHash 列整表拒绝', hashed.rejected[0]?.code === 'structure.stemHashNotAllowed' && hashed.rejected[0]?.field === 'stemHash');
  const dupHead = parseQuestionBank([head + ',stem', ',a,b,single,A,gaokao,china_moe,数学,na,集合与常用逻辑,1,zh,x'].join('\n'), {});
  assert('CSV：表头重复列报 csv.headerDuplicate', dupHead.rejected[0]?.code === 'csv.headerDuplicate' && dupHead.rejected[0]?.field === 'stem');
  const empty = parseQuestionBank('', {});
  assert('CSV：空文件报 csv.empty', empty.rejected[0]?.code === 'csv.empty' && empty.rejected[0]?.row === 1);
  const quote = parseQuestionBank('stem,type\n"未闭合', {});
  assert('CSV：引号未闭合报 csv.csvParse 并带行号', quote.rejected[0]?.code === 'structure.csvParse' && quote.rejected[0]?.row === 2);
  const cell = parseQuestionBank([head, ',题干示例：计算 5+5 的值。,A|1;B|2,single,A,gaokao,china_moe,数学,na,集合与常用逻辑,1,zh'].join('\n').replace('A|1;B|2', '[broken'), {});
  assert('CSV：options 单元格 JSON 坏了报 structure.invalidCell', cell.rejected.some((r) => r.code === 'structure.invalidCell' && r.field === 'options' && r.row === 2));
}

// 样例文件整份导入
{
  const repo = repoOf();
  const text = fs.readFileSync(path.join(ROOT, 'docs/question-bank-import-sample.csv'), 'utf8');
  const res = importQuestionBank(repo, text);
  assert('样例：12 题全部导入、0 拒绝、0 重复', res.imported === 12 && res.rejected.length === 0 && res.duplicates.length === 0);
  assert('样例：六体系各 2 题、含多选与填空', repo.list().length === 12 && repo.list().every((q) => ['gaokao', 'zhongkao', 'igcse', 'alevel', 'ap', 'ib'].includes(q.examSystem)) && repo.list().some((q) => q.type === 'multi') && repo.list().some((q) => q.type === 'fill'));
}

console.log(`\n结果: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
