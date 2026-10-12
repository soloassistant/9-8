// 独立复核：不复用生成逻辑，直接按 UTF-8 读盘断言。
const fs = require('fs');
const p = 'D:/Agent/src/services/api.ts';
const s = fs.readFileSync(p, 'utf8');

const checks = [
  ['注释块不重复', (s.match(/\/\*\* 更新习惯设置/g) || []).length === 1],
  ['apiLogin 保留 weapp 云函数', /if \(isWeapp\) return callFunction<UserProfile>\('login'\);/.test(s)],
  ['apiLogin H5 走真会话', /return buildProfileFromSession\(await getSession\(\)\);/.test(s)],
  ['updateSettings 本地落盘', /writeProfileSettings\(payload\)/.test(s)],
  ['无 U+FFFD 替换字符', !s.includes('\uFFFD')],
  ['无 GBK 乱码残留', !/绉|鏃|鐧|鍔|锛|鈥/.test(s)],
];

let bad = 0;
for (const [name, ok] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}

// localProfile.ts 同样检查
const q = 'D:/Agent/src/services/localProfile.ts';
const t = fs.readFileSync(q, 'utf8');
for (const [name, ok] of [
  ['localProfile 无 U+FFFD', !t.includes('\uFFFD')],
  ['localProfile 无 GBK 乱码', !/绉|鏃|鐧|鍔|锛|鈥/.test(t)],
  ['复用 user-settings 同步键', t.includes("const SETTINGS_KEY = 'user-settings'")],
  ['无会话时抛错不造假', /throw new Error\('no-cloud-session'\)/.test(t)],
  ['phone/email 均已脱敏', /maskIdentifier/.test(t) && /phone_number|\.phone/.test(t)],
  // 2026-10-12 登录态实测新增：H5 会话只有数字 user.id，旧实现 maskIdentifier 返回空串，
  // nickname 落到 `id.slice(0,8)` 兜底 → 页面把真实账号「21094813」当昵称渲染。
  ['数字 id 也走脱敏（不再整串展示）', /id\.slice\(0, 2\)\}\*\*\*/.test(t)],
  ['nickname 兜底不再是原始 id 片段', !/maskIdentifier\(user\)\s*\|\|\s*id\.slice/.test(t)],
  ['nickname 兜底为中性称呼', /maskIdentifier\(user\)\s*\|\|\s*'晨友'/.test(t)]
]) {
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}

console.log(`\n${bad === 0 ? 'ALL PASS' : bad + ' FAILED'}`);
process.exit(bad === 0 ? 0 : 1);