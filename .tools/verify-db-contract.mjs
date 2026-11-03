#!/usr/bin/env node
/**
 * verify-db-contract.mjs —— 「应用数据库契约」门禁（2026-10-31 新增）
 *
 * 它守三件事，全都是 2026-10-31 线上实测查出来的：
 *
 *   ① **跨运行时白名单不许放行不存在的 PG 函数**
 *      `src/services/dataSource.ts` 的 RPC_ALLOWLIST 管的是「H5 能不能打应用数据库的 rpc」。
 *      微信云函数（cloudfunctions/ 下的目录）与应用数据库的 PG 函数是**两套运行时**：
 *      名字相同 ≠ 函数存在。2026-10-31 匿名探针实测：
 *        chat / extract / webSearch / newsFeedback / feedback / getBriefing / shopping
 *        → 全部 404 DATABASE_PGRST202「Could not find the function public.X ... in the schema cache」
 *      之前白名单里的 `chat` / `extract` 就属于这一类：它们在 H5 上**不可达**（cloud.ts 已特判），
 *      所以「留着不炸」—— 但那是**假的安全感**：谁按注释去写新调用点，就会白发一发 404。
 *      ⚠️ 探针必须**带真实参数名**：PostgREST 按参数名匹配签名，不带参数时返回的是
 *      「Could not find the function public.X **without parameters**」，
 *      那句话**不能**用来断定函数不存在。
 *
 *   ② **匿名访客读不到用户数据**（feedback / user_kv / llm_events）
 *      2026-10-31 实测：anon 对这三张表 **有 SELECT 权限**（GET → 200），
 *      而 orders / client_errors 已被收口（GET → 401 DATABASE_42501）。
 *      这三张表里装着用户数据：feedback.contact（联系方式 PII）、
 *      user_kv.value（AI 记忆/聊天记录/购物清单/日程…）、llm_events（用量）。
 *      表当前是空的 ⇒ 「RLS 挡住」与「真空」在外部**无法区分**（都是 200 + []）。
 *      ⇒ 两件事同时做：① 仓库里备好**幂等收紧迁移**（REVOKE anon + RLS 兜底）；
 *        ② 线上探针断言「anon 读到的行数必须是 0」——
 *        这是**可判定**的：一旦表里有行且 RLS 失守，这条立刻红。
 *
 *   ③ **客户端不读那些要收口的表** ⇒ 收掉 anon/甚至 authenticated 的 SELECT 不会弄坏功能。
 *
 * 用法：
 *   node .tools/verify-db-contract.mjs          # 静态部分（确定性，可进 verify:all / CI）
 *   node .tools/verify-db-contract.mjs --live   # 再加线上探针（需要外网）
 *
 * 退出码：0 全绿；1 有断言失败；2 harness 自身出错。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const LIVE = process.argv.includes('--live');

const rows = [];
let pass = 0;
let fail = 0;
function assert(name, cond, detail = '') {
  if (typeof cond !== 'boolean') throw new Error(`断言「${name}」的 cond 不是 boolean（${typeof cond}）`);
  rows.push({ name, ok: cond, detail });
  if (cond) pass++;
  else fail++;
}

/** 剥掉 JS/TS 行注释与块注释 —— 判据不能把注释当事实 */
const stripComments = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * 白名单解析（容错）。
 *
 * ⚠️ 2026-10-31：白名单清空成 `new Set<string>([])` —— TS 泛型带在字面量里，
 *   原来的 `/new Set\(\[([^\]]*)\]\)/` 匹配不上 ⇒ 解析失败 ⇒ 门禁**假红**。
 *   现在：`[^=]*` 吃掉 `: Set<string>`；`(?:<[^>]*>)?` 吃掉 `new Set<...>` 的泛型。
 *   三个门禁共用这条口径（verify-live-bridge / audit-identity / 本文件）。
 */
export const ALLOWLIST_RE = /const RPC_ALLOWLIST[^=]*=\s*new Set(?:<[^>]*>)?\(\s*\[([\s\S]*?)\]\s*\)/;

/** 这些名字是**微信云函数**（cloudfunctions/ 下有同名目录），应用数据库里没有同名 PG 函数。
 *  2026-10-31 线上匿名探针实测：全部 PGRST202「不存在」。 */
const WECHAT_ONLY_FN = ['webSearch', 'chat', 'extract', 'newsFeedback', 'feedback', 'getBriefing', 'shopping'];

/** 含用户数据、必须挡住匿名读的表 */
const USER_DATA_TABLES = ['feedback', 'user_kv', 'llm_events'];
/** 已收口（对 anon 全表无权限）的表 —— 守住，别被顺手放开 */
const REVOKED_TABLES = ['orders', 'client_errors'];

const SQL_REL = '.tools/sql/v2-db-anon-revoke.sql';

/* ═══════════════════════ 一、白名单（静态） ═══════════════════════ */
const dsRaw = read('src/services/dataSource.ts');
const ds = stripComments(dsRaw);
const allowMatch = ds.match(ALLOWLIST_RE);
const allowBody = allowMatch ? allowMatch[1] : '';
const allowNames = [...allowBody.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);

assert(
  'S1 RPC_ALLOWLIST 能被解析（容错正则命中 TS 泛型形态）',
  !!allowMatch,
  `源码形态：${(dsRaw.match(/const RPC_ALLOWLIST[^\n]*/) || ['(未找到)'])[0]}`
);
assert(
  'S2 白名单里没有任何「只有微信云函数、应用库无同名 PG 函数」的名字',
  !!allowMatch && WECHAT_ONLY_FN.every((n) => !allowNames.includes(n)),
  `命中：${WECHAT_ONLY_FN.filter((n) => allowNames.includes(n)).join(',') || '(无)'}`
);
assert(
  'S3 白名单当前为空 —— 应用数据库侧没有任何面向客户端的 PG 函数（H5 用户数据走 cloudDb.ts 的 db.rpc，不经本闸）',
  !!allowMatch && allowNames.length === 0,
  `allowlist = [${allowNames.join(', ')}]`
);
assert(
  'S4 白名单闸在取 rpc 之前（未放行的名字不发网络请求，只在本地抛错）',
  (() => {
    const iGate = ds.indexOf('if (!RPC_ALLOWLIST.has(name)) {');
    const iRpc = ds.indexOf('getCloudRpc()');
    return iGate >= 0 && iRpc > iGate;
  })(),
  '这是「H5 一旦误放行不存在的函数 ⇒ 立刻止损（不发 404）」能成立的前提'
);

/* ═══════════════════════ 二、通道分离（静态） ═══════════════════════ */
const cloudDb = stripComments(read('src/services/cloudDb.ts'));
assert(
  'S5 H5 的同步键读写走 cloudDb.ts 的 db.rpc（另一条通道，不经 invoke 白名单）',
  /\.rpc(?:<[^>]*>)?\('kv_set_many'/.test(cloudDb) && /\.rpc(?:<[^>]*>)?\('kv_clear'/.test(cloudDb),
  'kv_set_many / kv_clear 都必须是 db.rpc —— 若被改成走 invoke()，会被空白名单直接拒掉'
);
assert(
  'S6 客户端从不 SELECT feedback（⇒ 收掉 anon/表的 SELECT 权限不会弄坏功能）',
  !/from\('feedback'\)\s*\.select\(/.test(cloudDb) && !/from\('feedback'\)\s*\.select\(/.test(stripComments(read('src/services/cloudDb.ts'))),
  'client_errors 历史上就是「匿名能读全表」的真实隐私事故，反馈表不能再走同一条路'
);

/* ═══════════════════════ 三、收紧迁移（静态） ═══════════════════════ */
const sqlExists = fs.existsSync(path.join(ROOT, SQL_REL));
const sql = sqlExists ? read(SQL_REL) : '';
/**
 * ⚠️ **先剥 SQL 注释再判**（2026-10-31 实测踩到）：
 *   变异「把某条语句注释掉」（`-- ALTER TABLE ...`）在**不剥注释**时，判据照样命中 ——
 *   因为那段文字还在文件里。于是 4 条 SQL 变异全部 NOT-CAUGHT，而门禁自己显示「10 项要求齐备」。
 *   这与「注释不能当事实」是同一条：**判据读的是代码，不是代码旁边的说明**。
 *   （本仓库已有同类教训：verify-live-bridge 的 A6、verify-docs 的 B3 都栽在「先剥注释再判」上。）
 */
const stripSqlComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
const sqlCode = stripSqlComments(sql);
/**
 * 逐条判据：[说明, 正则, 期望存在?]
 *
 * ⚠️ 策略类判据**必须逐条**写，不能用一条宽正则概括 ——
 *   「只要有一个 CREATE POLICY ... TO authenticated 就算过」是**假判据**：
 *   把 insert 策略改成 TO anon，select 策略还在 ⇒ 宽正则照样命中 ⇒ 变异打不掉。
 *   否定判据（期望存在 = false）用来守「不许把策略授予 anon」。
 */
const sqlNeed = [
  ['feedback 开 RLS', /ALTER TABLE public\.feedback\s+ENABLE ROW LEVEL SECURITY/i, true],
  ['feedback 插入策略只 TO authenticated', /CREATE POLICY feedback_insert_own[\s\S]{0,120}?TO authenticated/i, true],
  ['feedback 读取策略只 TO authenticated', /CREATE POLICY feedback_select_own[\s\S]{0,120}?TO authenticated/i, true],
  ['不得把任何策略授予 anon', /CREATE POLICY[\s\S]{0,160}?TO\s+anon\b/i, false],
  ['策略条件是 owner_id = auth.uid()', /owner_id = auth\.uid\(\)/i, true],
  ['anon 被收口（feedback）', /REVOKE ALL ON TABLE public\.feedback[\s\S]{0,80}?FROM[^;]*anon/i, true],
  ['anon 被收口（user_kv）', /REVOKE ALL ON TABLE public\.user_kv[\s\S]{0,80}?FROM[^;]*anon/i, true],
  ['anon 被收口（llm_events）', /REVOKE ALL ON TABLE public\.llm_events[\s\S]{0,80}?FROM[^;]*anon/i, true],
  ['service_role 显式补回（收紧 anon 不该把管理端一起收掉）', /GRANT ALL ON TABLE public\.feedback[\s\S]{0,60}?TO service_role/i, true],
  ['llm_events 保持只增不改（不给 UPDATE/DELETE）', /REVOKE UPDATE, DELETE ON TABLE public\.llm_events/i, true]
];
const missingSql = sqlNeed
  .filter(([, re, want]) => (want ? !re.test(sqlCode) : re.test(sqlCode)))
  .map(([label]) => label);
assert(
  'S7 收紧迁移文件存在且覆盖全部要求（判据读剥掉注释后的语句，注释掉的语句不算数）',
  sqlExists && missingSql.length === 0,
  sqlExists ? (missingSql.length ? `不合规：${missingSql.join('；')}` : `${sqlNeed.length} 项要求齐备`) : `缺文件 ${SQL_REL}`
);

/* ═══════════════════════ 四、陈旧注释（静态） ═══════════════════════ */
const cloudRaw = read('src/services/cloud.ts');
/** 注释块里的每一行（用于逐行判定「这句是不是在陈述现状」） */
const cloudCommentLines = cloudRaw
  .split('\n')
  .filter((l) => /^\s*(\*|\/\/|\/\*)/.test(l))
  .map((l) => l.replace(/^\s*(\*|\/\/|\/\*)/, '').trim());
/** 历史说明的标记词：出现它 ⇒ 这句话在讲「以前怎样」，不是在讲「现在怎样」 */
const HISTORY_MARK = /原文|改前|此前|已于|摘除|修正|不再|曾经|历史|更正/;
/** 一句话若同时出现「放行」与某个微信云函数名，它就必须带历史标记，否则是**陈旧现状陈述**。 */
const staleLines = cloudCommentLines.filter(
  (l) =>
    /放行/.test(l) &&
    WECHAT_ONLY_FN.some((n) => l.includes(n)) &&
    !HISTORY_MARK.test(l)
);
assert(
  'S8 cloud.ts 的注释不得把「微信云函数名」说成白名单**当前**放行的对象（提到它们必须写明是历史）',
  staleLines.length === 0,
  staleLines.length ? `陈旧陈述：${staleLines[0].slice(0, 90)}` : '（无陈旧现状陈述）'
);

/* ═══════════════════════ 五、线上探针（--live） ═══════════════════════ */
if (LIVE) {
  const ep = (read('src/services/cloudAuth.ts').match(/const CLOUD_ENDPOINT\s*=\s*'([^']+)'/) || [])[1];
  const key = (read('src/services/cloudAuth.ts').match(/const CLOUD_PUBLISHABLE_KEY\s*=\s*'([^']+)'/) || [])[1];
  const BASE = `${ep}/.cloud/database/rest`;

  async function call(method, p, body) {
    const t0 = Date.now();
    try {
      const res = await fetch(`${BASE}${p}`, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(key ? { 'x-wb-webapp-access-key': key } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* 非 JSON */ }
      return { status: res.status, text, json, ms: Date.now() - t0 };
    } catch (e) {
      return { status: 0, text: `NETWORK ${e.message}`, json: null, ms: Date.now() - t0 };
    }
  }

  /** 探针的判读：返回 'present'（对象在）/ 'absent'（对象不存在）/ 'unknown'（说不清）。
   *  ⚠️ 「对象在」有两种表现：能执行（200/204）或**无权执行**（42501）。
   *    42501「permission denied for function X」= 函数**存在**，只是匿名没权限 ——
   *    与 PGRST202「Could not find the function」是**相反**的结论，不能混为一谈。 */
  function judgeRpc(r) {
    if (r.status === 0) return 'unknown';
    if (/PGRST202/.test(r.text)) return /without parameters/.test(r.text) ? 'unknown' : 'absent';
    if (/42501|permission denied/.test(r.text)) return 'present';
    if (r.status === 200 || r.status === 204) return 'present';
    return 'unknown';
  }

  /* L1 探针判据本身要有判别力：同一个探针形状必须能同时判出「在」与「不在」 */
  // ⚠️ 用 kv_set_many 当「存在」的证人，**不用** log_client_error：后者是真写库函数，
  //   每跑一次门禁就往 client_errors 里塞一行垃圾。kv_set_many 传空数组不写任何行。
  const probeLive = await call('POST', '/rpc/kv_set_many', { p_items: [] });
  const probeGhost = await call('POST', '/rpc/webSearch', { action: 'search', feedback: '', id: 'probe' });
  const jLive = judgeRpc(probeLive);
  const jGhost = judgeRpc(probeGhost);
  assert(
    'L1 线上探针有判别力（同一个形状必须能同时判出「对象在」与「对象不在」）',
    jLive === 'present' && jGhost === 'absent',
    `kv_set_many=${jLive}(${probeLive.status}) / webSearch=${jGhost}(${probeGhost.status})`
  );

  /* L2 白名单里每个名字都必须探到「存在」——放行前必须有探针证明 */
  const allowProbe = [];
  for (const n of allowNames) {
    const r = await call('POST', `/rpc/${n}`, {});
    allowProbe.push(`${n}=${judgeRpc(r)}`);
  }
  assert(
    'L2 白名单里的每个名字都被线上探针证明存在',
    allowNames.every((n) => allowProbe.some((p) => p.startsWith(`${n}=present`))),
    allowProbe.length ? allowProbe.join(' ') : '（白名单为空，本条暂无对象）'
  );

  /* L3 微信云函数名在应用库里确实不存在（事实表，防「凭印象放行」）
   *  ⚠️ **必须带真实参数名**：PostgREST 按参数名匹配函数签名。
   *    空 body 会得到「Could not find the function public.X **without parameters**」——
   *    那句话只说明没匹配上这个调用形状，**不能**据此断定函数不存在（判据会变成 unknown）。
   *    下面每个 body 的参数名取自各云函数的真实入参（线上实测：带这些参数名时，
   *    这七个名字**全部**返回 PGRST202「Could not find the function public.X(...)」）。 */
  const GHOST_PROBE_BODY = {
    webSearch: { action: 'search', feedback: '', id: 'probe' },
    chat: { messages: [{ role: 'user', content: 'probe' }] },
    extract: { text: 'probe' },
    newsFeedback: { id: 'probe', feedback: 'up' },
    feedback: { type: 'other', content: 'probe' },
    getBriefing: { date: '2026-10-31' },
    shopping: { action: 'list' }
  };
  const ghostNames = [];
  for (const n of WECHAT_ONLY_FN) {
    const r = await call('POST', `/rpc/${n}`, GHOST_PROBE_BODY[n] || {});
    ghostNames.push(`${n}=${judgeRpc(r)}`);
  }
  assert(
    'L3 「只有微信云函数」的那批名字在应用数据库里确实不存在（带真实参数名探针，不可凭印象放行）',
    WECHAT_ONLY_FN.every((n) => ghostNames.some((p) => p.startsWith(`${n}=absent`))),
    ghostNames.join(' ')
  );

  /* L4 匿名读用户数据表必须读到 0 行 —— 表里有行且 RLS 失守时立刻红 */
  const readRows = [];
  const rowLeak = [];
  for (const t of USER_DATA_TABLES) {
    const r = await call('GET', `/${t}?limit=50`, null);
    let n = null;
    if (r.status === 200 && Array.isArray(r.json)) n = r.json.length;
    readRows.push(`${t}:${r.status}/${n === null ? '?' : n + '行'}`);
    if (n !== null && n > 0) rowLeak.push(`${t} 读到 ${n} 行`);
  }
  assert(
    'L4 匿名访客读 user_kv / llm_events / feedback 必须读到 0 行（一旦表里有行且 RLS 失守 ⇒ 立刻红）',
    rowLeak.length === 0,
    rowLeak.length ? `泄露：${rowLeak.join('；')}` : readRows.join(' ')
  );

  /* L5 匿名不得删用户数据表（用「匹配不到任何行」的过滤器 ⇒ 纯权限探测，不碰数据） */
  const delCol = { feedback: 'content', user_kv: 'key', llm_events: 'kind' };
  const delProbe = [];
  const delBad = [];
  for (const t of USER_DATA_TABLES) {
    const r = await call('DELETE', `/${t}?${delCol[t]}=eq.__no_such_value__`, null);
    delProbe.push(`${t}:${r.status}`);
    if (!(r.status === 401 || r.status === 403)) delBad.push(`${t}:${r.status}`);
  }
  assert(
    'L5 匿名对 user_kv / llm_events / feedback 没有删除权限（42501/403）',
    delBad.length === 0,
    delBad.length ? `异常：${delBad.join(' ')}` : delProbe.join(' ')
  );

  /* L5b 匿名不得写 feedback（唯一可安全标记+清理的表；llm_events 的 kind 无法标记，
   *   写进去会污染用量计数，故不写它 —— 它的写入面由 L4/L5 覆盖） */
  const marker = '__db_contract_probe__';
  const insFb = await call('POST', '/feedback', { type: 'other', content: marker, contact: '', page: 'probe' });
  if (insFb.status === 201 || insFb.status === 200) {
    const cleanup = await call('DELETE', `/feedback?content=eq.${marker}`, null);
    assert(
      'L6 匿名不得写 feedback（42501/403）',
      false,
      `⚠️ 匿名 INSERT 成功（${insFb.status}）⇒ feedback 无写入限制；已尝试清理标记行（${cleanup.status}）`
    );
  } else {
    assert(
      'L6 匿名不得写 feedback（42501/403）',
      insFb.status === 401 || insFb.status === 403,
      `POST /feedback → ${insFb.status}`
    );
  }

  /* L7 已收口的表要保持收口（别被顺手放开） */
  const revoked = [];
  const revokedBad = [];
  for (const t of REVOKED_TABLES) {
    const r = await call('GET', `/${t}?limit=1`, null);
    revoked.push(`${t}:${r.status}`);
    if (!(r.status === 401 || r.status === 403)) revokedBad.push(`${t}:${r.status}`);
  }
  assert(
    'L7 orders / client_errors 对匿名仍然完全关闭（已收口的保持收口）',
    revokedBad.length === 0,
    revokedBad.length ? `被放开：${revokedBad.join(' ')}` : revoked.join(' ')
  );
}

/* ═══════════════════════ 输出 ═══════════════════════ */
for (const r of rows) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
}
console.log(`PASS ${pass} / FAIL ${fail}`);
process.exit(fail > 0 ? 1 : 0);
