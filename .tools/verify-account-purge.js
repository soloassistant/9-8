#!/usr/bin/env node
/**
 * verify-account-purge.js —— X10「匿名 SELECT / 注销残余」回归闸门。
 *
 * 背景：
 *  · 匿名访问：早期应用数据库的 user_kv / llm_events / feedback 对 anon 可读，
 *    任何人拿到 URL 就能批量拉数据。收紧脚本是 .tools/sql/v2-db-anon-revoke.sql
 *    （含 REVOKE PUBLIC —— 只 revoke anon 不够，PUBLIC 才是默认授权来源）。
 *  · 注销残余：H5「注销」以前只登出 + 清本机，云端 user_kv 与
 *    llm_events / feedback / client_errors 原样保留。v3-h5-purge.sql 提供
 *    SECURITY DEFINER 的 purge_my_h5_data()，客户端在 signOut **之前** 发起清偿。
 *
 * ⚠️ 两份 SQL **未在平台执行**：本脚本只校验脚本内容与客户端接线，
 *    执行状态以「待平台执行」为准，绝不据此宣称线上已收紧。
 *
 * 用法: node .tools/verify-account-purge.js
 */
const fs = require('node:fs');
const path = require('node:path');

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

console.log('\n── 1. v2 匿名 SELECT 收口脚本 ──');
const v2 = read('.tools/sql/v2-db-anon-revoke.sql');
for (const table of ['feedback', 'user_kv', 'llm_events']) {
  ok(`v2 REVOKE ${table} 的 PUBLIC/anon`, new RegExp(`REVOKE ALL ON TABLE public\\.${table}\\s+FROM PUBLIC, anon`, 'i').test(v2));
  ok(`v2 ${table} 开启 RLS`, new RegExp(`ALTER TABLE public\\.${table}\\s+ENABLE ROW LEVEL SECURITY`, 'i').test(v2));
}
ok('v2 匿名策略被替换为 owner_id = auth.uid()', /auth\.uid\(\)/.test(v2) && /TO authenticated/i.test(v2));
ok('v2 llm_events 禁止改删（配额不可抹）', /REVOKE UPDATE, DELETE ON TABLE public\.llm_events/i.test(v2));

console.log('\n── 2. v3 注销残余清偿脚本 ──');
const v3 = read('.tools/sql/v3-h5-purge.sql');
ok('v3 使用 SECURITY DEFINER', /SECURITY DEFINER/i.test(v3));
ok('v3 固定 search_path（防劫持）', /SET search_path = public, pg_temp/i.test(v3));
for (const table of ['llm_events', 'feedback', 'client_errors']) {
  ok(`v3 删除 ${table} 仅限本人`, new RegExp(`DELETE FROM ${table}\\s+WHERE owner_id = auth\\.uid\\(\\)`).test(v3));
}
ok('v3 函数不接受 owner 参数（谁调用只删谁）', /purge_my_h5_data\(\)/.test(v3) && !/purge_my_h5_data\(\s*p_?owner/.test(v3));
ok('v3 幂等（重复调用可安全重试）', /CREATE OR REPLACE FUNCTION/i.test(v3));

console.log('\n── 3. 客户端接线 ──');
const db = read('src/services/cloudDb.ts');
ok('cloudDb 未部署（PGRST202）如实返回 not-deployed', /PGRST202/.test(db) && /'not-deployed'/.test(db));
ok('cloudDb 真失败返回 failed（不假装 ok）', /return 'failed'/.test(db));
const mine = read('src/pages/mine/index.tsx');
ok('注销前发起 purgeMyH5Data', /purgeMyH5Data\(\)/.test(mine));
ok('注销前清云端 user_kv（kvClear）', /kvClear\(\)/.test(mine));
const purgeAt = mine.indexOf('purgeMyH5Data()');
const kvAt = mine.indexOf('kvClear()');
// 2026-11-06（#72）：流程改成「清同步键 → 自动提单 → signOut → 完成页」，
// signOut 不再是 `.then(() => signOut())` 的旧形状。锚点定位改成「提单之后的那次 signOut」，
// 但不变式不变：purge / kvClear / 自动提单都必须在它之前。
// ⚠️ 比较时 indexOf 的返回值放左边：-1 在左才能让「找不到」判假；反过来写会把缺失当成通过。
const ticketAt = mine.indexOf('const ticket = await autoClosureTicket();');
const signOutAt = mine.indexOf('await signOut()', ticketAt);
ok('purge 调用位置在 signOut 之前', purgeAt > 0 && signOutAt > 0 && signOutAt > purgeAt);
ok('kvClear 调用位置在 signOut 之前', kvAt > 0 && signOutAt > 0 && signOutAt > kvAt);
ok('自动提单在 signOut 之前', ticketAt > 0 && signOutAt > 0 && signOutAt > ticketAt);
ok('H5 注销不调用只认 OPENID 的 deleteAccount', /process\.env\.TARO_ENV === 'h5'/.test(mine));

console.log('\n── 3.5 注销完成文案（窄不变式） ──');
const lang = read('src/store/language.ts');
const doneCopies = [...lang.matchAll(/['"]mine\.deleteDone['"]\s*:\s*'([^']*)'/g)].map((m) => m[1]);
const FORBID_CLAIM = /已删除全部数据|云端.{0,8}(已删|已清除)|all data (has been )?deleted/i;
ok('注销完成文案 mine.deleteDone 不宣称已删除全部数据（中英各一份，违规时指名键名）', doneCopies.length === 2 && doneCopies.every((s) => !FORBID_CLAIM.test(s)));
if (doneCopies.some((s) => FORBID_CLAIM.test(s))) console.log('  ↳ 违规键: mine.deleteDone');

console.log('\n── 4. 平台执行状态（如实标注） ──');
ok('v2/v3 文件头标注「需平台执行」', /控制台|平台/.test(v2) && /控制台/.test(v3));

console.log(`\n=== account-purge: ${pass} PASS / ${fail} FAIL ===`);
console.log('⚠️  v2/v3 SQL 未在平台执行，线上收紧状态仍为「待平台执行」。');
process.exit(fail === 0 ? 0 : 1);
