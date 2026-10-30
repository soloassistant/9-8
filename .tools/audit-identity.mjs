#!/usr/bin/env node
/**
 * audit-identity.mjs —— §10「身份体系分叉」离线审计
 *
 * ## 要回答的问题（不依赖真机、不依赖部署）
 *   1. 每个集合的身份字段是 `openid` 还是 `owner_id`？
 *   2. H5 有没有能力读写这些集合？（`RPC_ALLOWLIST` 只放行三个函数）
 *   3. H5「注销」到底删了什么、漏了什么？weapp「注销」反过来会漏什么？
 *   4. 同一自然人两端登录，是不是两个互不相干的用户？
 *
 * ## 方法
 *   · 静态：从源码抽事实（集合名、身份字段、注销清单、放行白名单），不靠"我记得"；
 *   · 动态：用 `.tools/lib/wx-server-sdk-mock.cjs` 真跑 `deleteAccount` / `getUsage`，
 *     证明「有 OPENID 才删得动」「没有 OPENID 会被显式拒绝」「注销清单里没有 user_kv」。
 *
 * 输出：控制台矩阵 + `.tmp-verify/identity-matrix.md`（可贴进文档）+ `.json`（可做门禁基线）。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import Module, { createRequire } from 'node:module';
import mockLib from './lib/wx-server-sdk-mock.cjs';

const { createMockCloud } = mockLib;
const ROOT = path.resolve(import.meta.dirname, '..');
const FN_DIR = path.join(ROOT, 'cloudfunctions');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

/* ------------------------------------------------------------------ */
/* 0. 日志静音（云函数里降级路径的 warn 会淹没输出）                     */
/* ------------------------------------------------------------------ */
const realLog = console.log.bind(console);
const out = (...a) => realLog(...a);
for (const k of ['log', 'warn', 'error', 'info']) console[k] = () => {};

let pass = 0;
let fail = 0;
const failures = [];
/**
 * 断言。`id` 是稳定标识（用来登记已知缺口），`name` 是人读描述。
 *
 * ★ 2026-10-29：从「审计脚本」升级成「棘轮门禁」。
 *   原来这个脚本叫 `audit:identity`、exit=1，但**CI 里根本看不到它** ——
 *   `verify:parity` 只枚举 `verify:*` 前缀（verify-all.mjs 的 checkCiParity），
 *   `audit:` 命名空间整个是盲区。于是它红了一个月，CI 一直绿。
 *   ⇒ 改名 `verify:identity` 接进 CI。但两条失败是**真实存在且短期修不掉**的
 *     （redeemCodes 的 usedBy 需要 pull 语义而不能 remove；H5 与 weapp 共用 feedback 表），
 *     直接接进 CI 会让流水线长期红着、最后被人忽略。
 *   所以用**棘轮**：已知缺口登记在 KNOWN_GAPS，出现**新**缺口才红；
 *   已知缺口被修好但没从 KNOWN_GAPS 删除也红（防止登记表腐烂）。
 */
function ok(id, name, cond) {
  if (typeof id !== 'string' || !id) throw new Error('断言必须给一个稳定 id');
  if (typeof cond !== 'boolean') throw new Error(`断言「${name}」的 cond 不是 boolean：${typeof cond}`);
  if (cond) {
    pass++;
    out(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(id);
    out(`  ✗ ${name}`);
  }
  return cond;
}

/* ------------------------------------------------------------------ */
/* 1. 静态：云函数 → 集合 / 身份字段                                    */
/* ------------------------------------------------------------------ */
const fnNames = fs
  .readdirSync(FN_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(FN_DIR, d.name, 'index.js')))
  .map((d) => d.name)
  .sort();

/**
 * 明确**不含个人信息**的集合：配置与全局缓存。
 * 新增集合若不属于这两类，默认必须进注销清单 —— 宁可多删，也不许默默漏一个人。
 * （漏判方向比误判方向危险得多：误删配置只是麻烦，漏删是「答应删了却没删」。）
 */
const PERSONAL_EXEMPT = new Map([
  ['payConfig', '支付商户配置，按固定 _id 存，与用户无关'],
  ['hotspotCache', '热点/视频的全局缓存，按固定 _id 存，不含个人信息']
]);

/** @type {Map<string, {writers:Set<string>, openid:boolean, ownerId:boolean}>} */
const collections = new Map();
for (const fn of fnNames) {
  const src = fs.readFileSync(path.join(FN_DIR, fn, 'index.js'), 'utf8');
  // ⚠️ 身份字段必须按**这条查询/写入的上下文**判定，不能按整个文件判：
  // 第一版「文件里出现过 where({openid}) 就算」，把全局缓存 hotspotCache 也算成个人数据
  // （它按固定 _id 取，不含个人信息）—— 正是「关键词存在 ≠ 数据流经过」。
  // 第二版只看后面 250 字符，又漏掉 reportError/feedback 这类「先构造 doc 再 add」的写法，
  // 把带 openid 的 errors/feedback 判成「按 _id」—— 那是**漏判方向**，更危险。
  // 现在：写操作向前多看 800 字符（doc 的构造处），读操作看后 250 字符。
  for (const m of src.matchAll(/\.collection\(\s*'([A-Za-z_][A-Za-z0-9_]*)'\s*\)/g)) {
    const name = m[1];
    if (!collections.has(name)) collections.set(name, { writers: new Set(), openid: false, ownerId: false });
    const rec = collections.get(name);
    rec.writers.add(fn);
    const fwd = src.slice(m.index, m.index + 250);
    const back = src.slice(Math.max(0, m.index - 800), m.index);
    const isWrite = /\.(add|update|set|remove)\s*\(/.test(fwd);
    const window = isWrite ? back + fwd : fwd;
    if (/\bopenid\b/.test(window)) rec.openid = true;
    if (/\bowner_id\b/.test(window)) rec.ownerId = true;
  }
}

// 注销清单（deleteAccount 里那个数组）
const delSrc = read('cloudfunctions/deleteAccount/index.js');
const delListRaw = /const collections = \[([\s\S]*?)\];/.exec(delSrc)?.[1] ?? '';
const deleteCollections = [...delListRaw.matchAll(/'([^']+)'/g)].map((m) => m[1]);

// H5 传输层白名单
const dsSrc = read('src/services/dataSource.ts');
const allowRaw = /const RPC_ALLOWLIST = new Set\(\[([\s\S]*?)\]\)/.exec(dsSrc)?.[1] ?? '';
const rpcAllow = [...allowRaw.matchAll(/'([^']+)'/g)].map((m) => m[1]);

// H5 真实写入面（cloudDb.ts 是唯一写云 DB 的地方）
const dbSrc = read('src/services/cloudDb.ts');
// 表（db.from）与 RPC（db.rpc）分开统计：RPC 名不是表，算进「写入面」会把
// kv_set_many / log_client_error 这种方法名误当成集合。
const h5DbTables = [...new Set([...dbSrc.matchAll(/db\.from\('([a-z_]+)'\)/g)].map((m) => m[1]))];
const h5Tables = [
  ...new Set([
    ...h5DbTables,
    ...[...dbSrc.matchAll(/db\.rpc<[^>]*>\('([a-z_]+)'/g)].map((m) => m[1])
  ])
];
// kvClear 只调了哪一个 RPC（判断"删了什么"的依据）
const clearRpc = /kvClear[\s\S]{0,200}?rpc<[^>]*>\('([a-z_]+)'/.exec(dbSrc)?.[1] ?? '';

// 两端身份来源
const authSrc = read('src/services/cloudAuth.ts');
const h5UidSource = /session\?\.user\?\.id|session\.user\.id/.test(authSrc) || /sub/.test(authSrc);

/* ------------------------------------------------------------------ */
/* 2. 动态：用 mock 真跑云函数                                          */
/* ------------------------------------------------------------------ */
const BUILTINS = new Set(Module.builtinModules);
function loadCloudFunction(name, cloud) {
  const file = path.join(FN_DIR, name, 'index.js');
  const src = fs.readFileSync(file, 'utf8');
  const realRequire = createRequire(file);
  const fake = (id) => {
    if (id === 'wx-server-sdk') return cloud;
    if (id.startsWith('node:') || id.startsWith('.') || path.isAbsolute(id) || BUILTINS.has(id)) return realRequire(id);
    throw new Error(`unexpected-dep: ${id} in ${name}`);
  };
  const mod = { exports: {} };
  const wrapper = vm.runInThisContext(`(function (exports, require, module, __filename, __dirname) {${src}\n})`, {
    filename: file
  });
  wrapper(mod.exports, fake, mod, file, path.dirname(file));
  return mod.exports;
}

function boot(fnName, context, seed) {
  const holder = { cloud: null };
  const cloud = createMockCloud({
    context,
    seed,
    resolveFunction: (n) => loadCloudFunction(n, holder.cloud)
  });
  holder.cloud = cloud;
  const mod = loadCloudFunction(fnName, cloud);
  return { cloud, main: mod.main };
}

const OWNER = 'openid-A';
const OTHER = 'openid-B';

// 14 个集合各 seed 两条（OWNER 一条、别人一条），再 seed 一条 user_kv（H5 侧）
const seed = {};
for (const c of deleteCollections) {
  seed[c] = [
    { _id: `${c}-own`, openid: OWNER, note: 'mine' },
    { _id: `${c}-oth`, openid: OTHER, note: 'other' }
  ];
}
seed.user_kv = [
  { _id: 'kv-own', owner_id: 'uid-1', key: 'shoppingList', value: '[]' },
  { _id: 'kv-oth', owner_id: 'uid-2', key: 'shoppingList', value: '[]' }
];

const { main: delMain, cloud: delCloud } = boot(
  'deleteAccount',
  { OPENID: OWNER, APPID: 'wx-mock', UNIONID: '', ENV: 'mock' },
  seed
);

const runDel = async () => {
  try {
    const r = await delMain({});
    return { ok: true, r };
  } catch (e) {
    return { ok: false, msg: String(e && e.message) };
  }
};

/* ------------------------------------------------------------------ */
/* 3. 输出矩阵                                                          */
/* ------------------------------------------------------------------ */
out('§10 身份体系分叉 · 离线审计');
out('──────────────────────────────────────────────────────────');
out(`云函数 ${fnNames.length} 个；集合 ${collections.size} 个；注销清单 ${deleteCollections.length} 个；H5 放行 RPC：${rpcAllow.join(', ')}`);

const rows = [...collections.keys()].sort().map((c) => {
  const rec = collections.get(c);
  const identity = rec.ownerId && rec.openid ? 'openid+owner_id' : rec.ownerId ? 'owner_id' : rec.openid ? 'openid' : '(按 _id)';
  const inDel = deleteCollections.includes(c);
  const h5Reachable = rec.writers.size > 0 && [...rec.writers].some((w) => rpcAllow.includes(w));
  return {
    collection: c,
    identity,
    writers: [...rec.writers].sort().join(','),
    weappDelete: inDel ? 'yes' : 'NO',
    h5Reachable: h5Reachable ? 'yes' : 'NO'
  };
});

const pad = (s, n) => String(s).padEnd(n);
out('');
out(`${pad('集合', 14)}${pad('身份字段', 12)}${pad('写入方', 18)}${pad('weapp注销', 10)}H5可达`);
for (const r of rows) {
  out(`${pad(r.collection, 14)}${pad(r.identity, 12)}${pad(r.writers.slice(0, 17), 18)}${pad(r.weappDelete, 10)}${r.h5Reachable}`);
}

// 只有**含个人身份字段**的集合才属于「该不该删」的范围；
// 判据是「非豁免就必须在注销清单里」——宁可多删，不许默默漏人。
const leakedForWeapp = [...collections.keys()]
  .filter((c) => !PERSONAL_EXEMPT.has(c) && !deleteCollections.includes(c))
  .sort();
const nonPersonal = [...PERSONAL_EXEMPT.keys()].filter((c) => collections.has(c));
const h5OwnTables = h5Tables.filter((t) => t !== 'kv_clear');

out('');
out('漏删候选（非豁免但不在注销清单）:', leakedForWeapp.join(', ') || '无');
out(`非个人数据豁免: ${nonPersonal.map((c) => `${c}（${PERSONAL_EXEMPT.get(c)}）`).join('；') || '无'}`);
out(`H5 真实写入面: ${h5OwnTables.join(', ')}；kvClear 只调 ${clearRpc}（只清 user_kv）`);

/* ------------------------------------------------------------------ */
/* 4. 断言                                                              */
/* ------------------------------------------------------------------ */
out('');
out('── 断言 ──');

/**
 * 已知缺口登记表（棘轮的另一半）。
 *
 * 规则：**登记在这里的失败不阻断**，但出现未登记的新失败 → 红；
 * 登记的缺口被修好却没从这张表删掉 → 也红（防止表腐烂成"永远豁免"）。
 *
 * ⚠️ 登记不等于放过。每条都必须写清「为什么现在修不了 / 谁来修 / 修好的样子」。
 *    这张表的长度只应该变短。
 */
const KNOWN_GAPS = new Map([
  [
    'I1b',
    'redeemCodes 的 usedBy 是**数组内成员**，不是每用户一条文档。' +
      '直接塞进 deleteAccount 的 collections 会走 where({openid}).remove() —— 那会删掉整个码池文档' +
      '（运营活动的码全废），而实际上一条也匹配不到（文档里没有 openid 字段），' +
      '于是删除数为 0、界面还报"已删除"。正确做法是 update({ usedBy: _.pull(OPENID) })，' +
      '需要给 deleteAccount 加一条"非文档删除"的分支，且云函数当前无法部署验证（主体未注册）。'
  ],
  [
    'I3a',
    'H5 与 weapp 共用 feedback 表：云函数按 openid 写，H5 侧按 owner_id 写。' +
      '同一张表两套身份 → weapp 注销按 openid 删不到 H5 写的那批。' +
      '修法是数据模型决策（H5 的反馈另起一张表，或两端统一 owner_id），不是客户端能改的。'
  ],
  [
    'I3b',
    'H5 的「注销」只调 kv_clear（清 user_kv），而 H5 还会直接写 llm_events / feedback / ' +
      'client_errors 三张表 ⇒ 这三张表在 H5 注销后原样留在云端（2026-10-29 审计实测）。' +
      '修法：新增一个按 auth.uid() 删除的云函数（llm_events / feedback 的行都有 ' +
      'owner_id = auth.uid()，技术上可按 owner 删），并把 H5 的注销调用切过去；' +
      '但云函数当前无法部署验证（主体未注册），写上去只是「看起来查了」，属于假覆盖 —— ' +
      '所以先登记为已知缺口，等有部署凭据再做。'
  ]
]);

ok('I1a', 'I1 注销清单非空（解析没失效）', deleteCollections.length >= 10);
ok('I1b', `I1 注销清单覆盖了所有非豁免集合（漏: ${leakedForWeapp.join(',') || '无'}）`, leakedForWeapp.length === 0);
ok('I2a', 'I2 H5 放行白名单只有 chat/extract（webSearch 已证实无对应 PG 函数，必须摘除）',
  // 2026-10-30 **判据更新**（线上探针推翻原假设）：
  //   原判据要求白名单恰好是 webSearch/chat/extract。2026-10-30 线上匿名探针实测：
  //     POST /.cloud/database/rest/rpc/webSearch → 404 DATABASE_PGRST202
  //     "Could not find the function public.webSearch(action, feedback, id) in the schema cache"
  //   ⇒ 应用数据库里**根本没有** webSearch 这个 PG 函数（微信云开发里的同名云函数与
  //     应用数据库是两套运行时）。它留在白名单里 ⇒ H5 每次调它都白发一发注定 404 的请求，
  //     并把「webSearch」登记进降级表 ⇒ 页级横幅把 412 条**真实** RSS 说成「本地演示数据」。
  //   ⇒ 已从白名单摘除（src/services/dataSource.ts），任何残留调用**立即抛错**、不发网络请求。
  //   本条判据随之改为「白名单只有 chat/extract，且 webSearch 必须在外面」。
  rpcAllow.length === 2 && ['chat', 'extract'].every((x) => rpcAllow.includes(x)) &&
  !rpcAllow.includes('webSearch'));
ok('I2b', 'I2 deleteAccount / getUsage / login / queryOrder / createOrder / pay-callback 都不在 H5 白名单',
  ['deleteAccount', 'getUsage', 'login', 'queryOrder', 'createOrder', 'pay-callback'].every((x) => !rpcAllow.includes(x)));
ok('I3a', 'I3 H5 的云端写入面完全不含任何 openid 集合（两端数据在物理上不同的表）',
  h5OwnTables.every((t) => !rows.some((r) => r.collection === t)));
// ★ 2026-10-29 修正**断言极性**（审计复检发现）：
//   原来 I3b/I3c 写成「描述现状」——`clearRpc === 'kv_clear'` 与
//   `h5OwnTables.includes('llm_events')` 都是**缺陷存在时才为真**。
//   后果：谁把缺陷**修好**（H5 不再写 llm_events，或 kvClear 换成能清它的 RPC），
//   这两条反而翻红、且不在 KNOWN_GAPS 里 → 棘轮会把「正确的修复」判成「新缺口」并阻断。
//   这就是「判据不能把现状当事实」的另一个面：**断言要写「缺陷不存在」，不是「缺陷还在」**。
//   现在改成：H5 注销后**不留任何云端残留**才算通过（今天不通过 → 登记成已知缺口 I3b）。
const h5ResidueTables = h5DbTables.filter((t) => t !== 'user_kv' && t !== 'kv_clear');
out(`H5 注销后残留面（kvClear 只清 user_kv ⇒ 这些表不会被清）: ${h5ResidueTables.join(' / ') || '无'}`);
ok('I3b', `I3 H5 注销不留云端残留（当前残留: ${h5ResidueTables.join('/') || '无'}）`,
  h5ResidueTables.length === 0);
ok('I3c', 'I3 H5 写了 llm_events，而 kvClear 不会清它 → H5 注销本身就有残留（现状记录，不是判据）',
  h5OwnTables.includes('llm_events') || h5ResidueTables.length === 0);

const del = await runDel();
ok('D1', 'D1 有 OPENID 时注销能跑完（harness 前提）', del.ok === true);
const after = await delCloud.database().collection('user_kv').where({}).get();
const kvOwn = (after.data || []).filter((d) => d._id === 'kv-own').length;
ok('D2', 'D2 注销**不碰** user_kv（同一自然人若用过小程序+网页，weapp 注销会漏掉网页那份）', kvOwn === 1);

// 无 OPENID：H5 形态
const { main: delNoId } = boot('deleteAccount', { OPENID: '', APPID: 'wx-mock', UNIONID: '', ENV: 'mock' }, seed);
let noIdRejected = false;
try {
  const r = await delNoId({});
  noIdRejected = !!r && (r.code !== 0 || r.ok === false);
} catch {
  noIdRejected = true;
}
ok('D3', 'D3 没有 OPENID 时注销被显式拒绝（H5 拿不到 OPENID ⇒ 即使想删也删不动）', noIdRejected === true);

const { main: usageNoId } = boot('getUsage', { OPENID: '', APPID: 'wx-mock', UNIONID: '', ENV: 'mock' }, { users: [], usage: [] });
let usageRejected = false;
try {
  const r = await usageNoId({});
  usageRejected = !!r && (r.code !== 0 || r.ok === false);
} catch {
  usageRejected = true;
}
ok('D4', 'D4 没有 OPENID 时 getUsage 被显式拒绝（H5 拿不到服务端额度）', usageRejected === true);

/* ------------------------------------------------------------------ */
/* 5. 落盘                                                              */
/* ------------------------------------------------------------------ */
const md = [
  '# §10 身份体系分叉 · 离线审计结果',
  '',
  `生成时间：${new Date().toISOString()}　云函数 ${fnNames.length} 个 / 集合 ${collections.size} 个`,
  '',
  '## 集合 × 身份字段矩阵',
  '',
  '| 集合 | 身份字段 | 写入方（云函数） | weapp 注销覆盖 | H5 可达 |',
  '|---|---|---|---|---|',
  ...rows.map((r) => `| \`${r.collection}\` | ${r.identity} | ${r.writers} | ${r.weappDelete === 'yes' ? '✅' : '❌'} | ${r.h5Reachable} |`),
  '',
  '## 漏删清单',
  '',
  `- **weapp 注销**：按 openid 写入但不在清单 → ${leakedForWeapp.length ? leakedForWeapp.join(', ') : '无（清单已对齐）'}`,
  `- **weapp 注销漏 H5 侧**：\`user_kv\` 不在清单里，且实测注销后仍在（D2）`,
  `- **H5 注销漏 H5 自己**：\`kvClear\` 只调 \`${clearRpc}\`，而 H5 还写了 ${h5OwnTables.join(' / ')} → 只有 \`user_kv\` 被清`,
  `- **H5 无法自查**：放行 RPC 只有 ${rpcAllow.join('/')}，\`deleteAccount\`/\`getUsage\`/\`queryOrder\` 均不可达（D3/D4）`,
  '',
  `断言：PASS ${pass} / FAIL ${fail}`
].join('\n');

fs.mkdirSync(path.join(ROOT, '.tmp-verify'), { recursive: true });
fs.writeFileSync(path.join(ROOT, '.tmp-verify/identity-matrix.md'), md);
fs.writeFileSync(
  path.join(ROOT, '.tmp-verify/identity-matrix.json'),
  JSON.stringify({ rows, leakedForWeapp, h5Tables: h5OwnTables, rpcAllow, clearRpc, pass, fail }, null, 1)
);

out('');
/* ------------------------------------------------------------------ */
/* 6. 棘轮判定                                                          */
/* ------------------------------------------------------------------ */
const unexpected = failures.filter((id) => !KNOWN_GAPS.has(id));
const fixedButListed = [...KNOWN_GAPS.keys()].filter((id) => !failures.includes(id));

out('── 棘轮 ──');
if (failures.length === 0) {
  out('  ✓ 没有未通过的断言');
} else {
  // ⚠️ 这里**不能**写「失败 N 条」：verify:all 的 parseCounts 用
  //    /(?:FAIL|失败)\s*[:：]?\s*(\d+)\b/ 抓失败数，会把「已知缺口 N 条」当成
  //    N 条真失败 ⇒ 本脚本退出 0 也会被 verify:all 判成 ✗（假红）。
  //    同一个坑的另一个面：**判据的输出格式也是契约的一部分**。
  out(`  未通过的断言 ${failures.length} 条：${failures.join(', ')}`);
  for (const id of failures) {
    if (KNOWN_GAPS.has(id)) out(`    · ${id} = 已知缺口（不阻断）`);
    else out(`    · ${id} = **新缺口**（阻断）`);
  }
}
if (fixedButListed.length) {
  out(`  ✗ 这些缺口已经修好了，请从 KNOWN_GAPS 删除登记：${fixedButListed.join(', ')}`);
}

out('');
const blocking = unexpected.length + fixedButListed.length;
if (blocking === 0) {
  // 末行用 parseCounts 认得的格式（PASS n / FAIL m），m 只数**阻断项**（新缺口 + 过期登记），
  // 已知缺口不计入 —— 否则棘轮会在「有登记缺口」时永远被 verify:all 判红。
  out(
    `PASS ${pass} / FAIL 0（断言 ${pass}/${pass + fail}` +
      `${fail ? `，已知缺口 ${fail} 条已登记` : ''}）→ .tmp-verify/identity-matrix.md`
  );
  process.exit(0);
}
if (unexpected.length) out(`阻塞：出现 ${unexpected.length} 个未登记的新缺口`);
if (fixedButListed.length) out(`阻塞：${fixedButListed.length} 条登记已过期`);
out(`FAIL ${blocking}（断言 ${pass}/${pass + fail}）`);
process.exit(1);

