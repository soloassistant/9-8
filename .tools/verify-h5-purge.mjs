#!/usr/bin/env node
/**
 * verify-h5-purge.mjs —— H5 注销清偿客户端契约回归（2026-11-01）。
 *
 * 背景（I3b 双半件的客户端半件，112bc02）：H5 注销 = kvClear（清 user_kv）+
 * purgeMyH5Data()（清 llm_events/feedback/client_errors 三表残留）。
 * purge_my_h5_data 是 SECURITY DEFINER 的 PG 函数（.tools/sql/v3-h5-purge.sql，
 * 由主理人在平台控制台执行后才存在）——客户端契约必须**先于 SQL 上线**就锁死：
 *   · 函数未部署（PGRST202）→ 返回 'not-deployed'，**静默跳过**（灰度零破坏：
 *     线上行为与未接线时逐字节一致，不能因为新代码让注销报错）
 *   · 真失败 → 'failed' 且 console.error 留痕（生产构建只留 error）
 *   · 无数据库 → 'no-db'（未登录态）
 *   · 成功 → 'ok'
 * 返回值是**状态不是布尔**——什么时候都不能把「没删成」说成「已清除」。
 *
 * 加载方式同 verify-vault-report：cloudDb.ts 传递依赖拉 Taro，
 * 切片抽 purgeMyH5Data 源码 + stub getCloudDatabase / unwrap 依赖。
 * 用法: node .tools/verify-h5-purge.mjs    # 0 全绿 / 1 有失败 / 2 自身出错
 */
import fs from 'node:fs';
import path from 'node:path';
import { transform } from 'esbuild';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'src', 'services', 'cloudDb.ts'), 'utf8');

function sliceFn(s, name) {
  const m = new RegExp(`(?:export\\s+)?(?:async\\s+)?function ${name}(?:<[^>]*>)?\\s*\\(`).exec(s);
  if (!m) throw new Error(`sliceFn: ${name} not found`);
  const start = m.index;
  let depth = 0, started = false, inStr = null;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (ch === '\\') { i++; continue; } if (ch === inStr) inStr = null; continue; }
    if (ch === '"' || ch === "'") { inStr = ch; continue; }
    if (ch === '{') { depth++; started = true; }
    if (ch === '}') { depth--; if (started && depth === 0) return s.slice(start, i + 1); }
  }
  throw new Error(`sliceFn: ${name} unbalanced`);
}
const slice = sliceFn(src, 'purgeMyH5Data')
  .replace(/^export /, '') + '\nglobalThis.__p = { purgeMyH5Data };\n';

let passes = 0, failures = 0;
const out = (s) => console.log(s);
const check = (name, desc, cond) => {
  if (cond === true) { passes += 1; out(`  PASS  ${name}  ${desc}`); }
  else { failures += 1; out(`  FAIL  ${name}  ${desc}`); }
};

/** 造一个带 purgeMyH5Data 的沙箱：stub getCloudDatabase / unwrap 依赖 / console */
async function makeSandbox({ db, errors }) {
  const sandbox = {
    console: { warn: () => {}, error: (...a) => errors.push(a.join(' ')), info: () => {}, log: () => {} },
    JSON, Math, Date, Number, String, Array, Object, Promise, Error,
  };
  sandbox.globalThis = sandbox;
  // purgeMyH5Data 源码里引用 getCloudDatabase / PGRST202 判据走 res.error.code
  sandbox.getCloudDatabase = async () => db;
  // 切片是 TS 源码（含类型标注）——过 esbuild 再进 vm（否则 SyntaxError）
  const js = (await transform(slice, { loader: 'ts', format: 'cjs', logLevel: 'silent' })).code;
  vm.createContext(sandbox);
  vm.runInContext(js, sandbox, { filename: 'purge-slice.cjs' });
  return sandbox;
}

const PGRST202 = { code: 'PGRST202', message: 'Could not find the function public.purge_my_h5_data in the schema cache' };

(async () => {
  // ── ① 函数未部署（灰度常态）：静默跳过，not-deployed ──
  {
    const errors = [];
    const sb = await makeSandbox({
      db: { rpc: async () => ({ data: null, error: PGRST202 }) },
      errors,
    });
    const r = await sb.__p.purgeMyH5Data();
    check('PG1', '函数未部署（PGRST202）→ not-deployed 且零 error 留痕（灰度零破坏）',
      r === 'not-deployed' && errors.length === 0);
  }

  // ── ② 无数据库（未登录态）：no-db ──
  {
    const errors = [];
    const sb = await makeSandbox({ db: null, errors });
    const r = await sb.__p.purgeMyH5Data();
    check('PG2', '无数据库 → no-db', r === 'no-db');
  }

  // ── ③ 真失败：failed + console.error 留痕（生产构建只留 error，铁律） ──
  {
    const errors = [];
    const sb = await makeSandbox({
      db: { rpc: async () => ({ data: null, error: { code: 'XX000', message: 'boom' } }) },
      errors,
    });
    const r = await sb.__p.purgeMyH5Data();
    check('PG3', '真失败 → failed 且 console.error 留痕（生产构建只留 error）',
      r === 'failed' && errors.some((e) => /purge_my_h5_data failed/.test(e)));
  }

  // ── ④ 成功：ok ──
  {
    const errors = [];
    const sb = await makeSandbox({
      db: { rpc: async () => ({ data: { purged: true, llm_events: 3, feedback: 1, client_errors: 0 }, error: null }) },
      errors,
    });
    const r = await sb.__p.purgeMyH5Data();
    check('PG4', '成功 → ok', r === 'ok' && errors.length === 0);
  }

  // ── ⑤ 源码级：切片里必须含 PGRST202 判据（有人删灰度分支时这里红） ──
  check('PG5', '切片含 PGRST202 灰度分支（防回归：删了它会让 SQL 未上线时注销报错）',
    /PGRST202/.test(slice));

  // ── ⑥ 窄不变式：注销完成文案不得宣称云端记录已删除 ──
  // 为什么锚文案而不是流程：注销流程正在改成页内工单（「提交工单后 15 个工作日」），
  // 流程断言会被下一次改造打红；但「不能说谎」是跨改造的不变式。
  const langSrc = fs.readFileSync(path.join(ROOT, 'src', 'store', 'language.ts'), 'utf8');
  const doneCopies = [...langSrc.matchAll(/['"]mine\.deleteDoneH5['"]\s*:\s*'([^']*)'/g)].map((m) => m[1]);
  const FORBID_CLAIM = /已删除全部数据|数据已删除|云端.*(已删|已清除)|all data (has been )?deleted|data has been deleted/i;
  check(
    'PG6',
    '注销完成文案 mine.deleteDoneH5 不宣称云端记录已删除（中英各一份，违规时指名键名）',
    doneCopies.length === 2 && doneCopies.every((s) => !FORBID_CLAIM.test(s))
  );
  if (doneCopies.some((s) => FORBID_CLAIM.test(s))) {
    out('  ↳ 违规键: mine.deleteDoneH5（文案谎报「已删除」，而 purge 可能 not-deployed/failed）');
  }

  // ── ⑦ 注销工单（support_tickets）：表/RLS/客户端/文案一处都不许松 ──
  {
    const sql = fs.readFileSync(path.join(ROOT, '.tools/sql/v7-support-tickets.sql'), 'utf8').replace(/--.*$/gm, '');
    const page = fs.readFileSync(path.join(ROOT, 'src/pages/mine/index.tsx'), 'utf8');
    const legal = fs.readFileSync(path.join(ROOT, 'src/data/legal.ts'), 'utf8');
    const doc = fs.readFileSync(path.join(ROOT, 'docs/legal/07-账号注销与数据删除指引.md'), 'utf8');
    check('ST1', '建表 + RLS + authenticated 只能插/读自己的行', /CREATE TABLE IF NOT EXISTS public\.support_tickets/.test(sql) && /ENABLE ROW LEVEL SECURITY/.test(sql) && /WITH CHECK \(owner_id = auth\.uid\(\)\)/.test(sql) && /USING \(owner_id = auth\.uid\(\)\)/.test(sql));
    check('ST2', 'authenticated 无 TRUNCATE/REFERENCES/TRIGGER 授权', !/GRANT[^;]*?(TRUNCATE|REFERENCES|TRIGGER)/.test(sql) && /GRANT INSERT, SELECT ON TABLE public\.support_tickets TO authenticated/.test(sql));
    check('ST3', '客户端插入 + 页面调用 + 失败可重试（不静默成功）', /supportTicketInsert/.test(src) && /supportTicketInsert\(/.test(page) && /ticketRetry/.test(page));
    check('ST4', '无邮件残留 + 三处同一口径 + 待签字占位 + 中英同步', !/mailto:|SUPPORT_EMAIL/.test(page + legal) && /mine\.ticketEta[^\n]*15 个工作日/.test(langSrc) && /mine\.ticketEta[^\n]*15 business days/.test(langSrc) && /提交注销工单/.test(legal) && /15 个工作日/.test(legal) && /提交注销工单/.test(doc) && /PENDING-SIGNATURE/.test(doc));
  }

  console.log(`\nPASS ${passes} / FAIL ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
})();
