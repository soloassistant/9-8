#!/usr/bin/env node
/**
 * verify-todo-status.js —— 「待办状态确定性写入」回归闸门。
 *
 * 改前：两处勾选都先 setDoneIds 再落库；H5 的 writePlan 吞异常（静默失败），
 * weapp 走 apiChat 让 LLM 解析「完成了『xxx』」决定改哪一条 → 假完成 / 标错条目。
 * 改后：setTodoStatus（本地回读校验）+ todoStatus 云函数（_id + openid 收敛）+ 页面先写后改 UI。
 *
 * 这里真正**执行**两个实现（TS 模块用 transpileModule 加载，云函数用内存桩），
 * 不是读源码猜行为；页面顺序与 apiChat 残留才用源码断言。
 *
 * 判据一律 cond === true —— 失败分支返回非空字符串会被 truthy 判成 PASS。
 * 用法: node .tools/verify-todo-status.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');
let pass = 0;
let fail = 0;

function ok(name, cond) {
  if (cond === true) {
    pass++;
    console.log('PASS  ' + name);
  } else {
    fail++;
    console.log('FAIL  ' + name);
  }
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ================= 1. setTodoStatus：执行 TS 模块 ================= */

const mem = { raw: null };
let writeCount = 0;
let failWrites = false;

global.__TARO_STUB__ = {
  getStorageSync: () => {
    if (mem.raw == null) return '';
    return JSON.parse(mem.raw); // 模拟 H5 localStorage 的序列化语义（返回副本，不是同一引用）
  },
  setStorageSync: (_key, value) => {
    writeCount += 1;
    if (failWrites) return; // 静默失败：不抛错也不写盘，模拟 writePlan 吞掉异常后的真实效果
    mem.raw = JSON.stringify(value);
  }
};

const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todostatus-stub-'));
const stubFile = path.join(stubDir, 'taro-stub.js');
fs.writeFileSync(stubFile, 'module.exports = { __esModule: true, default: global.__TARO_STUB__ };\n', 'utf8');

const SRC = path.join(ROOT, 'src', 'data', 'dailyPlan.ts');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@tarojs/taro') return stubFile;
  return origResolve.call(this, request, ...rest);
};

let setTodoStatus;
try {
  const ts = require('typescript');
  const out = ts.transpileModule(read('src/data/dailyPlan.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, esModuleInterop: true }
  }).outputText;
  const mod = new Module(SRC, null);
  mod.filename = SRC;
  mod.paths = Module._nodeModulePaths(path.join(ROOT, 'src', 'data'));
  mod._compile(out, SRC);
  setTodoStatus = mod.exports.setTodoStatus;
} finally {
  Module._resolveFilename = origResolve;
  try {
    fs.rmSync(stubDir, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
}

const seed = (todos) => {
  mem.raw = JSON.stringify({ events: [], todos });
  writeCount = 0;
  failWrites = false;
};
const stored = (id) => JSON.parse(mem.raw).todos.find((t) => t.id === id);

ok('A1 setTodoStatus 已导出', typeof setTodoStatus === 'function');

seed([
  { id: 't1', title: '写周报', status: 'pending' },
  { id: 't2', title: '交报销', status: 'pending' },
  { id: 't3', title: '已完成的', status: 'done' }
]);
const r1 = setTodoStatus('t1', 'done');
ok('A2 pending → done 成功且已落盘', r1.ok === true && stored('t1').status === 'done');

const r2 = setTodoStatus('t2', 'confirmed');
ok('A3 pending → confirmed 成功且已落盘', r2.ok === true && stored('t2').status === 'confirmed');

const r3 = setTodoStatus('missing-id', 'done');
ok("A4 id 不存在返回 not_found", r3.ok === false && r3.reason === 'not_found');

writeCount = 0;
const r4 = setTodoStatus('t3', 'done');
ok('A5 已是目标状态幂等：ok 且不写库', r4.ok === true && writeCount === 0);

// ★ 最关键：writePlan 吞异常 → setStorageSync 静默不写盘。没有回读就会误报成功。
seed([{ id: 't9', title: '回读校验', status: 'pending' }]);
failWrites = true;
const r5 = setTodoStatus('t9', 'done');
ok("A6 写盘静默失败时回读校验生效（not_persisted）", r5.ok === false && r5.reason === 'not_persisted');
failWrites = false;

/* ================= 2. todoStatus 云函数：内存桩执行 ================= */

const store = new Map();
const calls = { where: [], update: [] };
let currentOpenid = 'user-A';

const dbStub = {
  collection: (name) => ({
    where: (cond) => {
      calls.where.push({ name, cond: JSON.parse(JSON.stringify(cond)) });
      // 模拟真实 DB 语义：只按条件里出现的字段过滤（去掉 openid 就会匹配到别人的记录）
      const match = () =>
        [...store.values()].filter((d) => Object.keys(cond).every((k) => d[k] === cond[k]));
      return {
        limit: () => ({ get: async () => ({ data: match() }) }),
        update: async ({ data }) => {
          calls.update.push({ name, cond: JSON.parse(JSON.stringify(cond)), data });
          let updated = 0;
          for (const d of match()) {
            Object.assign(d, data);
            updated += 1;
          }
          return { stats: { updated } };
        }
      };
    }
  })
};

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'wx-server-sdk') {
    return {
      DYNAMIC_CURRENT_ENV: 'test',
      init: () => {},
      database: () => dbStub,
      getWXContext: () => ({ OPENID: currentOpenid })
    };
  }
  return origLoad.call(this, request, ...rest);
};

const CF = path.join(ROOT, 'cloudfunctions', 'todoStatus', 'index.js');
let todoStatusMain;
try {
  delete require.cache[require.resolve(CF)];
  todoStatusMain = require(CF).main;
} finally {
  Module._load = origLoad;
}

const resetCf = () => {
  store.clear();
  calls.where.length = 0;
  calls.update.length = 0;
  currentOpenid = 'user-A';
  store.set('todo-1', { _id: 'todo-1', openid: 'user-A', title: 'A 的待办', status: 'pending' });
  store.set('todo-2', { _id: 'todo-2', openid: 'user-B', title: 'B 的待办', status: 'pending' });
};

(async () => {
  ok('B1 云函数 main 已导出', typeof todoStatusMain === 'function');

  resetCf();
  const c1 = await todoStatusMain({ id: 'todo-1', status: 'done' });
  ok('B2 正常更新返回 ok 且落库', c1.ok === true && store.get('todo-1').status === 'done');

  const before = calls.update.length;
  const c2 = await todoStatusMain({ id: 'todo-1', status: 'done' });
  ok('B3 已是目标状态幂等 unchanged 且不再写库', c2.ok === true && c2.unchanged === true && calls.update.length === before);

  resetCf();
  currentOpenid = '';
  let noOpenidThrew = false;
  try {
    await todoStatusMain({ id: 'todo-1', status: 'done' });
  } catch {
    noOpenidThrew = true;
  }
  ok('B4 无 openid 抛错', noOpenidThrew === true);

  resetCf();
  let badStatusThrew = false;
  try {
    await todoStatusMain({ id: 'todo-1', status: 'deleted' });
  } catch {
    badStatusThrew = true;
  }
  ok('B5 非法 status 抛错', badStatusThrew === true);

  resetCf();
  await todoStatusMain({ id: 'todo-1', status: 'done' });
  const whereCond = calls.where.find((c) => c.name === 'todos' && c.cond._id === 'todo-1');
  ok(
    'B6 更新条件同时带 _id 与 openid',
    !!whereCond && whereCond.cond.openid === 'user-A'
  );

  resetCf();
  const c3 = await todoStatusMain({ id: 'todo-2', status: 'done' });
  ok(
    "B7 不能改他人待办（同 id 不同 openid → not_found）",
    c3.ok === false && c3.reason === 'not_found' && store.get('todo-2').status === 'pending'
  );

  /* ================= 3. 页面：先落库、成功才改 UI ================= */

  const bodyOf = (src, start, end) => {
    const s = src.indexOf(start);
    const e = src.indexOf(end, s + start.length);
    return s >= 0 && e > s ? src.slice(s, e) : '';
  };

  const cal = read('src/pages/calendar/index.tsx');
  const calFn = bodyOf(cal, 'const handleToggleTodo', 'const handleQuickAdd');
  const calAwait = calFn.indexOf('await apiTodoSetStatus');
  const calSet = calFn.indexOf('setDoneIds(next)');
  ok('C1 calendar：await apiTodoSetStatus 早于 setDoneIds', calAwait >= 0 && calSet >= 0 && calAwait < calSet);
  ok('C2 calendar：待办勾选路径无 apiChat', calFn.length > 0 && !calFn.includes('apiChat'));

  const brief = read('src/pages/briefing/index.tsx');
  const briefFn = bodyOf(brief, 'const handleToggleTodo', 'const handleSendText');
  const briefAwait = briefFn.indexOf('await apiTodoSetStatus');
  const briefSet = briefFn.indexOf('setDoneIds(next)');
  ok('C3 briefing：await apiTodoSetStatus 早于 setDoneIds', briefAwait >= 0 && briefSet >= 0 && briefAwait < briefSet);
  ok('C4 briefing：待办勾选路径无 apiChat', briefFn.length > 0 && !briefFn.includes('apiChat'));

  ok('C5 失败分支 toast common.saveFailed（两页各一处）',
    (cal.match(/common\.saveFailed/g) || []).length === 1 &&
    (brief.match(/common\.saveFailed/g) || []).length === 1);

  console.log('\n通过 ' + pass + ' / 失败 ' + fail);
  if (fail > 0) process.exit(1);
})();
