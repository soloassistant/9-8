#!/usr/bin/env node
/**
 * verify-ai-actions.mjs —— AI 动作执行器（src/services/aiActionExec.ts）的行为门禁
 *
 * 守的是一件事：**模型说「已经做了」不等于「真的写进去了」**。
 * 所以断言的重点不是"能返回 true"，而是：
 *   · 载荷不合法时必须 ok:false（不许拿空写库冒充成功）
 *   · schedule / shopping / chat 不许写库（提示词要求先建议后确认）
 *   · 改期失败时原日程必须**原样不动**（半截写入比不写更难查）
 *
 * 依赖用 esbuild 插件替换掉（dailyPlan 走 Taro storage、api 走云端），
 * 这样测的是执行器本身的分支，不是存储实现。
 */
import path from 'node:path';
import vm from 'node:vm';
import esbuild from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..');
const results = [];
const t = (name, fn) => {
  let r;
  try { r = fn(); } catch (e) { r = 'threw: ' + String(e && e.message || e); }
  results.push({ name, pass: r === true, why: r === true ? '' : String(r) });
};

const stubPlugin = (state) => ({
  name: 'stub-deps',
  setup(build) {
    build.onResolve({ filter: /^\.\.\/data\/dailyPlan$/ }, () => ({ path: 'dailyPlan', namespace: 'stub' }));
    build.onResolve({ filter: /^\.\/api$/ }, () => ({ path: 'api', namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
      if (args.path === 'dailyPlan') {
        return {
          contents: `module.exports = {
            readPlan: () => globalThis.__plan,
            writePlan: (p) => { globalThis.__plan = p; },
          };`,
          loader: 'js'
        };
      }
      return {
        contents: `module.exports = {
          apiConfirmItem: async (payload) => { globalThis.__confirmed = payload; return { saved: (payload.events||[]).length }; },
          apiTodoSetStatus: async (input) => { globalThis.__todo = input; return { ok: input.id !== 'missing', reason: input.id === 'missing' ? 'not_found' : undefined }; },
        };`,
        loader: 'js'
      };
    });
  }
});

const built = await esbuild.build({
  entryPoints: [path.join(ROOT, 'src/services/aiActionExec.ts')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  plugins: [stubPlugin()]
});
const code = built.outputFiles[0].text;
const mod = { exports: {} };
const ctx = {
  module: mod,
  exports: mod.exports,
  require: () => ({}),
  console,
  globalThis: undefined,
  Promise,
  Error
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(code, ctx);
const { normalizeNewEvents, runAiAction } = mod.exports;

const resetState = () => {
  ctx.__plan = { events: [{ id: 'evt-1', title: '评审会', startTime: '2026-11-01 10:00', status: 'confirmed' }], todos: [] };
  ctx.__confirmed = null;
  ctx.__todo = null;
};

await (async () => {
  /* ---- 归一化：不合格条目丢弃，不伪造 ---- */
  resetState();
  const n1 = normalizeNewEvents([
    { title: '周会', startTime: '2026-11-03 09:00' },
    { title: '缺时间' },
    { title: '时间乱写', startTime: '明天下午' },
    { startTime: '2026-11-03 10:00' },
    { title: '  带空格  ', startTime: '2026-11-03T11:00' }
  ]);
  t('N1 只留下 title + 合法时间的条目（5 条进 → 2 条留）', () => (n1.length === 2 ? true : `实得 ${n1.length} 条: ` + JSON.stringify(n1)));
  t('N2 标题做 trim 且带来源标记', () => (n1[1] && n1[1].title === '带空格' && n1[1].source === 'AI 排入' ? true : JSON.stringify(n1[1])));
  t('N3 T 分隔的时间也接受（YYYY-MM-DDTHH:mm）', () => (n1[1] && n1[1].startTime === '2026-11-03T11:00' ? true : String(n1[1] && n1[1].startTime)));

  /* ---- batch ---- */
  resetState();
  const b1 = await runAiAction({ action: 'batch', newEvents: [{ title: '站会', startTime: '2026-11-04 09:30' }, { title: '复盘', startTime: '2026-11-06 15:00' }] });
  t('B1 batch 走既有 confirmItem 通道（不另造写库实现）', () => (ctx.__confirmed && ctx.__confirmed.events.length === 2 ? true : JSON.stringify(ctx.__confirmed)));
  t('B2 batch 成功时 ok:true 且 saved=2', () => (b1 && b1.ok === true && b1.saved === 2 ? true : JSON.stringify(b1)));

  resetState();
  const b2 = await runAiAction({ action: 'batch', newEvents: [{ title: '没有时间' }] });
  t('B3 载荷全不合法 → ok:false（不许拿空写库冒充成功）', () => (b2 && b2.ok === false && b2.reason === 'no_valid_events' ? true : JSON.stringify(b2)));
  t('B4 不合法的载荷压根不调 confirmItem', () => (ctx.__confirmed === null ? true : '仍写入了: ' + JSON.stringify(ctx.__confirmed)));

  /* ---- done ---- */
  resetState();
  const d1 = await runAiAction({ action: 'done', targetId: 'todo-9' });
  t('D1 done 走 apiTodoSetStatus(ok 判定取返回值)', () => (d1 && d1.ok === true && ctx.__todo && ctx.__todo.status === 'done' ? true : JSON.stringify({ d1, todo: ctx.__todo })));

  resetState();
  const d2 = await runAiAction({ action: 'done', targetId: 'missing' });
  t('D2 目标不存在时必须 ok:false（UI 不得据此显示已完成）', () => (d2 && d2.ok === false ? true : JSON.stringify(d2)));

  resetState();
  const d3 = await runAiAction({ action: 'done' });
  t('D3 没有 targetId → ok:false 且不落任何状态', () => (d3 && d3.ok === false && d3.reason === 'no_target' && ctx.__todo === null ? true : JSON.stringify({ d3, todo: ctx.__todo })));

  /* ---- reschedule ---- */
  resetState();
  const r1 = await runAiAction({ action: 'reschedule', targetId: 'evt-1', newTime: '2026-11-02 14:00' });
  t('R1 改期成功：目标事件时间真的变了', () => (r1 && r1.ok === true && ctx.__plan.events[0].startTime === '2026-11-02 14:00' ? true : JSON.stringify({ r1, plan: ctx.__plan })));

  resetState();
  const r2 = await runAiAction({ action: 'reschedule', targetId: 'evt-1', newTime: '下午三点' });
  t('R2 时间不合法 → ok:false 且原日程**原样不动**', () => (r2 && r2.ok === false && ctx.__plan.events[0].startTime === '2026-11-01 10:00' ? true : JSON.stringify({ r2, plan: ctx.__plan })));

  resetState();
  const r3 = await runAiAction({ action: 'reschedule', targetId: 'nope', newTime: '2026-11-02 14:00' });
  t('R3 id 找不到 → ok:false，且不新增任何条目', () => (r3 && r3.ok === false && ctx.__plan.events.length === 1 ? true : JSON.stringify({ r3, plan: ctx.__plan })));

  /* ---- 不该写库的动作 ---- */
  resetState();
  const s1 = await runAiAction({ action: 'schedule', newTime: '2026-11-05 10:00' });
  const s2 = await runAiAction({ action: 'shopping' });
  const s3 = await runAiAction({ action: 'chat' });
  t('S1 schedule/shopping/chat 一律不写库（返回 null）',
    () => (s1 === null && s2 === null && s3 === null && ctx.__confirmed === null && ctx.__plan.events.length === 1 ? true : JSON.stringify({ s1, s2, s3, confirmed: ctx.__confirmed })));

  /* ---- 接线：组件里必须真的调用执行器 ---- */
  const fsMod = await import('node:fs');
  const aiSrc = fsMod.readFileSync(path.join(ROOT, 'src/components/AiAssistant/index.tsx'), 'utf8');
  t('W1 AiAssistant 真的调用了 runAiAction（不是只导入不用）',
    () => (/await runAiAction\(/.test(aiSrc) && /await applyAiAction\(res\)/.test(aiSrc) ? true : '找不到调用点'));
  t('W2 动作载荷已从云端透传（targetId/newTime/newEvents）',
    () => {
      const llm = fsMod.readFileSync(path.join(ROOT, 'src/services/cloudLlm.ts'), 'utf8');
      return /out\.targetId/.test(llm) && /out\.newTime/.test(llm) && /out\.newEvents/.test(llm) ? true : 'cloudLlm 没透传载荷';
    });

  const failed = results.filter((r) => !r.pass);
  console.log(`\nAI 动作执行器门禁 —— ${failed.length ? 'FAIL' : 'PASS'}  ${results.length - failed.length}/${results.length}`);
  for (const r of results) console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.why ? '  ← ' + r.why : ''}`);
  process.exit(failed.length ? 1 : 0);
})();
