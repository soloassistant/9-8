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
 * ⚠️ 三份 SQL（v2 / v3 / v7）**均未在平台执行**：本脚本只校验脚本内容与客户端接线，
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
// 执行权收口：PostgreSQL 新建函数默认把 EXECUTE 授给 PUBLIC，anon 又从 PUBLIC 继承 ——
// 不显式收回，未登录访客也能调用这条 SECURITY DEFINER 的注销通道。
// ⚠️ 判据一律先剥离 `--` 行注释再匹配：本文件正文里有大段说明，注释里出现
//    「REVOKE」「GRANT」字样会让顺序断言假绿（变异「GRANT 提前」专门验这一点）。
const v3Code = v3.replace(/--[^\n]*/g, '');
const revoke = v3Code.match(/REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.purge_my_h5_data\(\)\s+FROM\s+([^;]+);/i);
const revokedFor = revoke ? revoke[1].split(',').map((s) => s.trim().toLowerCase()) : [];
ok('v3 对函数执行权显式 REVOKE', Boolean(revoke));
for (const who of ['public', 'anon', 'authenticated']) {
  ok(`v3 REVOKE 主体含 ${who}（缺一不可）`, revokedFor.includes(who));
}
const grant = v3Code.match(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.purge_my_h5_data\(\)\s+TO\s+authenticated\s*;/i);
ok('v3 GRANT EXECUTE 只授回 authenticated', Boolean(grant));
ok('v3 REVOKE 在 GRANT 之前（先收回再授回）', Boolean(revoke && grant) && revoke.index < grant.index);
ok('v3 不再宣称「REVOKE EXECUTE 不需要」（错误设计说明已删）', !/REVOKE EXECUTE 不需要/.test(v3));

console.log('\n── 2b. v7 PUBLIC + authenticated 的 TRUNCATE/REFERENCES/TRIGGER 收回资产 ──');
const v7 = read('.tools/sql/v7-privilege-tighten.sql');
// 判据在**剥离 `--` 注释后的正文**上做：说明文字里也写着 REVOKE / FROM，
// 不剥注释会让「收的是哪个主体」这条断言假绿（变异用例专门验这一点）。
const v7Code = v7.replace(/--[^\n]*/g, '');
for (const table of ['user_kv', 'feedback', 'llm_events']) {
  const m = v7Code.match(new RegExp(
    `REVOKE\\s+TRUNCATE,\\s+REFERENCES,\\s+TRIGGER\\s+ON\\s+TABLE\\s+public\\.${table}\\s+FROM\\s+([^;]+);`, 'i'
  ));
  const who = m ? m[1].split(',').map((s) => s.trim().toLowerCase()) : [];
  ok(`v7 收回 ${table} 的 TRUNCATE/REFERENCES/TRIGGER（PUBLIC + authenticated）`,
    Boolean(m) && who.includes('public') && who.includes('authenticated'));
  ok(`v7 ${table} 的 REVOKE 主体 PUBLIC 在 authenticated 之前（继承通道先断）`,
    Boolean(m) && who.indexOf('public') >= 0 && who.indexOf('public') < who.indexOf('authenticated'));
  // 期望值必须留白：只给只读观测语句（has_table_privilege），不写「收回后应只剩哪些权」。
  ok(`v7 给出 ${table} 的逐项只读核查（has_table_privilege）`, new RegExp(
    `has_table_privilege\\('authenticated',\\s*'public\\.${table}',\\s*'(SELECT|UPDATE)'`, 'i'
  ).test(v7Code));
}
ok('v7 把「权项期望值」标成待线上实测（不写成断言）', /待线上实测/.test(v7));
ok('v7 明确列出 feedback 可能继承 UPDATE/DELETE 这个待实测点', /feedback 可能还持有 UPDATE \/ DELETE/.test(v7));
ok('v7 文件头标注「待执行」（本会话无 DB 执行通道）', /待执行/.test(v7));

console.log('\n── 3. 客户端接线 ──');
const db = read('src/services/cloudDb.ts');
ok('cloudDb 未部署（PGRST202）如实返回 not-deployed', /PGRST202/.test(db) && /'not-deployed'/.test(db));
ok('cloudDb 真失败返回 failed（不假装 ok）', /return 'failed'/.test(db));
const mine = read('src/pages/mine/index.tsx');
ok('注销前发起 purgeMyH5Data', /purgeMyH5Data\(\)/.test(mine));
ok('注销前清云端 user_kv（kvClear）', /kvClear\(\)/.test(mine));
const purgeAt = mine.indexOf('purgeMyH5Data()');
const kvAt = mine.indexOf('kvClear()');
const signOutAt = mine.indexOf('.then(() => signOut())');
ok('purge 调用位置在 signOut 之前', purgeAt > 0 && signOutAt > purgeAt);
ok('kvClear 调用位置在 signOut 之前', kvAt > 0 && signOutAt > kvAt);
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
console.log('⚠️  v2/v3/v7 SQL 未在平台执行，线上收紧状态仍为「待平台执行」。');
process.exit(fail === 0 ? 0 : 1);
