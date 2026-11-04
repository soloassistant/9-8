#!/usr/bin/env node
/**
 * verify-calendar-edit.js —— 缺陷「日历事件没有办法修改」回归闸门。
 *
 * 现象（改前）：`src/pages/calendar/index.tsx` 的日程行只有展示（时间/标题/地点），
 * 没有任何编辑入口；数据层也只有新增（confirmItem）与改期（applyPlan 只改 startTime/endTime），
 * 标题/地点/备注无法修改 —— 属于「根本没有编辑入口」。
 *
 * 改后：
 *   · H5：`dailyPlan.updateEvent` 本地落库 + **回读校验**（writePlan 吞异常，不回读就是假保存）；
 *   · 小程序：`chat.applyPlan` 更新分支支持 title/location/note（按 _id + openid 收敛）；
 *   · 日历页每条日程有稳定 `event-edit-btn` 入口，保存成功后刷新视图。
 *
 * 本脚本**执行** dailyPlan.updateEvent 的真实实现（TS 转译 + Taro storage 桩），
 * 其余行为（路由/云函数字段/页面接线）用源码断言 —— 不读源码猜本地行为。
 *
 * 用法: node .tools/verify-calendar-edit.js
 * 退出码: 0 全绿 / 1 断言失败 / 2 harness 异常
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
    pass += 1;
    console.log('  PASS  ' + name);
  } else {
    fail += 1;
    console.log('  FAIL  ' + name);
  }
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ================= 1. 执行 dailyPlan.updateEvent ================= */
const mem = { raw: '{"events":[],"todos":[]}' };
let failWrites = false;
global.__TARO_STUB__ = {
  getStorageSync: () => JSON.parse(mem.raw),
  setStorageSync: (_key, value) => {
    if (failWrites) return; // 静默失败：不抛错也不写盘
    mem.raw = JSON.stringify(value);
  }
};
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caledit-stub-'));
const stubFile = path.join(stubDir, 'taro-stub.js');
fs.writeFileSync(stubFile, 'module.exports = { __esModule: true, default: global.__TARO_STUB__ };\n', 'utf8');

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@tarojs/taro') return stubFile;
  return origResolve.call(this, request, ...rest);
};

const ts = require('typescript');
const out = ts.transpileModule(read('src/data/dailyPlan.ts'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, esModuleInterop: true }
}).outputText;
const modFile = path.join(stubDir, 'dailyPlan.js');
fs.writeFileSync(modFile, out, 'utf8');
const { updateEvent, readPlan } = require(modFile);

const EVT = {
  id: 'evt-1',
  title: '产品评审会',
  startTime: '2026-11-04 09:00',
  endTime: '2026-11-04 10:00',
  location: '3F 会议室',
  note: '带上原型',
  status: 'confirmed'
};
mem.raw = JSON.stringify({ events: [EVT], todos: [] });

console.log('\n── 1. 编辑落库并回读 ──');
const res = updateEvent('evt-1', {
  title: '产品评审会（改）',
  startTime: '2026-11-05 14:30',
  endTime: '2026-11-05 15:30',
  location: '线上会议',
  note: '改到周五'
});
ok('updateEvent 返回 ok', res.ok === true);
const after = readPlan().events[0];
ok('标题已改', after.title === '产品评审会（改）');
ok('日期+时间已改', after.startTime === '2026-11-05 14:30');
ok('结束时间已改', after.endTime === '2026-11-05 15:30');
ok('地点已改', after.location === '线上会议');
ok('备注已改', after.note === '改到周五');
// 模拟「刷新页面 / 重载」：从 storage 重新读（不是内存同一引用）
const reload = readPlan().events[0];
ok('重载后仍是新值（真落库，不是内存态）', reload.title === '产品评审会（改）' && reload.startTime === '2026-11-05 14:30');

console.log('\n── 2. 可选字段可清空 ──');
const clear = updateEvent('evt-1', { endTime: null, location: null, note: null });
ok('清空可选字段返回 ok', clear.ok === true);
const cleared = readPlan().events[0];
ok('endTime 字段被删除', Object.prototype.hasOwnProperty.call(cleared, 'endTime') === false);
ok('location 字段被删除', Object.prototype.hasOwnProperty.call(cleared, 'location') === false);
ok('note 字段被删除', Object.prototype.hasOwnProperty.call(cleared, 'note') === false);

console.log('\n── 3. 失败路径不得假成功 ──');
const ghost = updateEvent('evt-missing', { title: 'x' });
ok('不存在的 id 返回 ok:false + not_found', ghost.ok === false && ghost.reason === 'not_found');
failWrites = true;
const bad = updateEvent('evt-1', { title: '写不进去' });
ok('storage 写失败时返回 ok:false（不静默）', bad.ok === false && bad.reason === 'not_persisted');
failWrites = false;

/* ================= 4. 路由与页面接线（源码断言） ================= */
console.log('\n── 4. 路由/页面/云函数接线 ──');
const api = read('src/services/api.ts');
ok('H5 编辑走 dailyPlan.updateEvent', /if\s*\(!isWeapp\)\s*\{\s*return updateEvent\(/.test(api));
ok('小程序编辑走 chat.applyPlan（不新开旁路存储）', /action:\s*'applyPlan'/.test(api) && /eventId:\s*payload\.id/.test(api));
ok('briefing._id 归一成 id（小程序编辑才能命中条目）', /normalizeBriefingIds/.test(api) && /row\._id/.test(api));

const page = read('src/pages/calendar/index.tsx');
ok('日程行有稳定编辑入口 event-edit-btn', /event-edit-btn/.test(page));
ok('编辑表单含标题/日期/开始/结束/地点/备注', ['editTitle', 'editDate', 'editStart', 'editEnd', 'editLocation', 'editNote'].every((k) => page.includes(k)));
ok('保存调用 apiUpdateEvent 且失败不刷新成已保存', /apiUpdateEvent\(/.test(page) && /if\s*\(!res\.ok\)/.test(page));

const chat = read('cloudfunctions/chat/index.js');
ok('云函数更新支持标题', /if \(item\.hasTitle\) update\.title/.test(chat));
ok('云函数更新支持地点/备注且可清空', /item\.hasLocation/.test(chat) && /item\.hasNote/.test(chat) && /_.remove\(\)/.test(chat));
ok('旧改期调用不误删原地点/备注（has* 守卫）', /hasEndTime:/.test(chat) && /hasLocation:/.test(chat) && /hasNote:/.test(chat));

console.log(`\n=== calendar-edit: ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
