#!/usr/bin/env node
/**
 * verify-live-bridge.mjs —— 「线上 H5 通路」门禁（2026-10-30）
 *
 * 背景（全部来自线上实测，不是推测）：
 *
 *   2026-10-30 匿名探针：
 *     POST {endpoint}/.cloud/database/rest/rpc/webSearch
 *     → HTTP 404 {"code":"DATABASE_PGRST202",
 *                  "message":"Could not find the function public.webSearch(action, feedback, id)
 *                            in the schema cache"}
 *   ⇒ **应用数据库里根本没有 `webSearch` 这个 PG 函数**（微信云开发里的同名云函数与
 *     应用数据库是两套运行时）。而 `src/services/dataSource.ts` 的 RPC_ALLOWLIST 里
 *     一直放着它 ⇒ H5 每次调它都白发一发**注定 404** 的请求，并把「webSearch」
 *     登记进降级表 ⇒ 页级横幅亮出「云端功能暂不可用，当前为本地演示数据」，
 *     而热点页显示的是 **412 条真实 RSS** ⇒ **把真实数据说成演示数据**（反向谎言）。
 *
 *   一次带倒 4 个功能（全部 H5 死、小程序正常）：
 *     ① 热点页「🎬 视频精选」  apiVideoNews()   → [] → 板块永不渲染
 *     ② 晨报页「🎬 视频资讯」  apiGetVideoNews() → 降级模块不存在 → 动态 import 抛错 → reject
 *     ③ 「🔍 全网搜索」        apiNewsSearch()  → 退化为本地标题过滤
 *     ④ 「✨ AI 资讯精选」     apiAiNewsFilter()→ 退 /api/news/ai-filter → 线上无此路由 → 404
 *     ＋ 👍/👎 每次点击多打一发同样注定失败的 feedback 请求。
 *
 * 这道门禁守的就是「不要再把一个**不存在**的 PG 函数放回 H5 的白名单」，
 * 以及配套的三条数据侧修复（配图 / 视频 / 机构归一）不被悄悄改回去。
 *
 * 判据分两类：
 *   · 静态层：源码形态（**先剥注释** —— 本文件涉及的几个文件里，注释本身就写着
 *     `invoke('webSearch')`、`media:content`、`defer` 等关键字，不剥会被注释自己点亮）；
 *   · 运行层：真的 require 机构归一表 / 真的求值两端的提示词，逐字比对。
 *
 * 用法: node .tools/verify-live-bridge.mjs
 * 退出码: 0 = 全绿；1 = 有断言失败；2 = harness 自身出错
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const require_ = createRequire(import.meta.url);

const rows = [];
let pass = 0;
let fail = 0;
function assert(name, cond, detail = '') {
  if (typeof cond !== 'boolean') throw new Error(`断言「${name}」的 cond 不是 boolean：${typeof cond}`);
  rows.push({ name, ok: cond, detail });
  if (cond) pass++;
  else fail++;
}

/** 剥掉 JS 行注释与块注释 —— 判据不能把注释当事实 */
const stripJsComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** 统计子串出现次数（已剥注释的源码上调用） */
const countOf = (s, needle) => s.split(needle).length - 1;

/**
 * 取 `const <name> =` 到语句结束之间的**表达式**原文。
 * 扫描时跟踪引号状态，避免被字符串里的分号截断；
 * 结束条件有两个：显式 `;`，或 **ASI**（换行后下一个非空白字符不是 `+` / `,`）——
 * 少了后者，TS 里没写分号的常量会把后面整个函数吞进表达式（2026-10-30 实测踩过）。
 */
function extractConstExpr(src, name) {
  const marker = `const ${name} =`;
  const start = src.indexOf(marker);
  if (start < 0) return null;
  const from = start + marker.length;
  let i = from;
  // 跳过 marker 与表达式之间的空白：`const X =` 后换行再写表达式是常见排版，
  // 不跳过的话 ASI 规则会在这道换行上误判成「语句结束」。
  while (i < src.length && /\s/.test(src[i])) i++;
  let quote = null;
  while (i < src.length) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; i++; continue; }
    if (ch === ';') return src.slice(from, i).trim();
    if (ch === '\n') {
      // ASI：换行处若**上一行的最后一个非空白字符**是续行符（+ / ,），说明还没结束；
      // 若下一行的第一个非空白字符也不是续行符，才是真的语句边界。
      let p = i - 1;
      while (p >= 0 && /\s/.test(src[p])) p--;
      const prev = src[p];
      let k = i + 1;
      while (k < src.length && /\s/.test(src[k])) k++;
      const next = src[k];
      const continued = prev === '+' || prev === ',' || next === '+' || next === ',';
      if (!continued && next !== undefined) return src.slice(from, i).trim();
    }
    i++;
  }
  return null;
}

/* ───────────── A. 跨运行时白名单：PG 函数不存在 ⇒ 不许放行 ───────────── */
const dataSourceRaw = read('src/services/dataSource.ts');
const dataSource = stripJsComments(dataSourceRaw);
const allowlistMatch = dataSource.match(/const RPC_ALLOWLIST = new Set\(\[([^\]]*)\]\)/);
const allowlist = allowlistMatch ? allowlistMatch[1] : '';

assert(
  'A1 RPC_ALLOWLIST 里没有 webSearch（应用库无此 PG 函数，放行=每次白发一发 404）',
  !!allowlistMatch && !/['"]webSearch['"]/.test(allowlist),
  `allowlist = ${allowlist.trim() || '(解析失败)'}`
);
assert(
  'A2 RPC_ALLOWLIST 仍保留 chat / extract（不得把整张表清空）',
  /['"]chat['"]/.test(allowlist) && /['"]extract['"]/.test(allowlist)
);

const apiTs = stripJsComments(read('src/services/api.ts'));
const libraryTsx = stripJsComments(read('src/pages/library/index.tsx'));
const cloudTs = stripJsComments(read('src/services/cloud.ts'));

/** 取某个顶层函数的函数体（从 `function <name>(` 到顶格 `}`）。
 *  用来判「某个调用点是否在本函数的 H5 早退分支之后」。 */
function sliceFunc(src, name) {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) return null;
  const j = src.indexOf('\n}', i);
  return j < 0 ? src.slice(i) : src.slice(i, j + 2);
}

/** 断言「某函数体里，H5 早退分支在某个调用之前」——这是本轮所有 H5 通路的共同形状。 */
function hasH5GuardBefore(body, callNeedle) {
  if (!body) return false;
  const g = body.indexOf('if (!isWeapp) {');
  const c = body.indexOf(callNeedle);
  return g >= 0 && c > g;
}

assert(
  'A3 白名单闸在取 rpc 之前（未放行的名字**不发网络请求**，只在本地抛错）',
  (() => {
    const iGate = dataSource.indexOf('if (!RPC_ALLOWLIST.has(name)) {');
    const iRpc = dataSource.indexOf('getCloudRpc()');
    return iGate >= 0 && iRpc > iGate;
  })(),
  '这是「摘除 webSearch 白名单 ⇒ H5 立刻止损（不再白发 404）」能成立的前提'
);
assert(
  'A4 api.ts 里的 webSearch rpc 调用点没有增加（新增调用点 = 新增一处必败请求）',
  countOf(apiTs, "invoke('webSearch'") === 3,
  `出现 ${countOf(apiTs, "invoke('webSearch'")} 次（videoNews / searchNews / feedback 的 weapp 分支）`
);
{
  const fb = sliceFunc(libraryTsx, 'apiNewsFeedback');
  assert(
    'A5 收藏页的 feedback rpc 只在 weapp 分支（H5 由 cloudSync 上云，不发必败请求）',
    !!fb &&
      fb.includes("invoke('webSearch'") &&
      fb.indexOf('if (!isWeapp)') >= 0 &&
      fb.indexOf('if (!isWeapp)') < fb.indexOf("invoke('webSearch'")
  );
}
{
  const nInvoke = countOf(cloudTs, "invoke('webSearch'");
  const iInvoke = cloudTs.indexOf("invoke('webSearch'");
  const iH5Branch = cloudTs.indexOf('if (!isWeapp) {');
  const iCallFn = cloudTs.indexOf("callFunction<T>('webSearch'");
  assert('A6 cloud.ts 只剩小程序端那一处 webSearch rpc', nInvoke === 1, `出现 ${nInvoke} 次`);
  assert(
    'A7 小程序端那一处排在 H5 分支之后（H5 走 cloud.llm，不走必败的 rpc）',
    nInvoke === 1 && iH5Branch >= 0 && iInvoke > iH5Branch,
    `H5 分支 @${iH5Branch} / invoke @${iInvoke}`
  );
  assert(
    'A8 cloud.ts 里 callFunction(\'webSearch\') 只在小程序分支（H5 走它会登记降级 → 假横幅）',
    iCallFn < 0 || (iH5Branch >= 0 && iCallFn > iH5Branch),
    `H5 分支 @${iH5Branch} / callFunction @${iCallFn}`
  );
  assert(
    'A9 H5 的 AI 精选走 cloud.llm 直连（真 AI，不是必然 404）',
    /if \(!isWeapp\)/.test(cloudTs) && /cloudLlmChat\(\{[\s\S]{0,80}AI_FILTER_SYSTEM_PROMPT/.test(cloudTs)
  );
}

/* ───────────── B. 视频通路：同源静态载荷（零新增请求） ───────────── */
assert(
  'B1 apiVideoNews 的 H5 分支读 getHotspotPayload()（与热点条目同一个 JSON、同一次请求）',
  hasH5GuardBefore(sliceFunc(apiTs, 'apiVideoNews'), 'getHotspotPayload()')
);
assert(
  'B2 apiGetVideoNews 的 H5 分支读 getHotspotPayload()',
  hasH5GuardBefore(sliceFunc(apiTs, 'apiGetVideoNews'), 'getHotspotPayload()')
);
assert(
  'B3 cloud.ts 导出 getHotspotPayload（供 api.ts 复用同一次请求）',
  /export function getHotspotPayload\(/.test(cloudTs)
);
assert(
  'B4 cloud.ts 导出 getHotspotVideos（视频条目的读取口）',
  /export function getHotspotVideos\(/.test(cloudTs)
);
assert(
  'B5 载荷解析了 videos 字段（数据契约）',
  /videos:\s*norm\(payload\.videos\)/.test(cloudTs)
);
{
  const fetchData = stripJsComments(read('.tools/fetch-data.js'));
  assert(
    'B6 fetch-data 产出 videos（buildVideos 从已在抓的 B站热榜派生，零新增请求）',
    /function buildVideos\(/.test(fetchData) && /videos,/.test(fetchData)
  );
  assert(
    'B7 视频 url 用 bvid 重建规范形态（前端白名单只认 bilibili.com/video/BV…）',
    /'https:\/\/www\.bilibili\.com\/video\/'\s*\+\s*bvid/.test(fetchData)
  );
  const boards = stripJsComments(read('.tools/boards-core.js'));
  assert(
    'B8 B站解析带齐封面/时长/UP主/播放量/bvid',
    /image: pic/.test(boards) &&
      /duration/.test(boards) &&
      /author: owner/.test(boards) &&
      /play:/.test(boards) &&
      /bvid/.test(boards)
  );
  assert(
    'B9 duration 是秒数 → mm:ss（ranking/v2 的 duration 是数字，不是字符串）',
    /function formatDuration\(/.test(boards) && /Math\.floor\(total \/ 3600\)/.test(boards)
  );
}

/* ───────────── C. 配图：线上原本 0/412 = 0.0% ───────────── */
{
  const fetchData = stripJsComments(read('.tools/fetch-data.js'));
  assert('C1 fetch-data 有 pickImage（与云函数同口径）', /function pickImage\(/.test(fetchData));
  assert(
    'C2 pickImage 覆盖四路来源（media:content / media:thumbnail / enclosure / 首个 img）',
    fetchData.includes('media:content') &&
      fetchData.includes('media:thumbnail') &&
      fetchData.includes('enclosure') &&
      fetchData.includes('<img[^>]*src=')
  );
  {
    // —— C2b 行为层：真的把 pickImage 求值出来，四路各给一个「只有这一路」的块 ——
    // 为什么必须行为层（2026-10-30 变异实测踩过）：
    //   C2 判的是 `includes('media:content')`，而变异把正则改成 `media:contentX`
    //   —— 子串还在 ⇒ C2 照样绿 ⇒ 变异 NOT-CAUGHT。
    //   「源码里还写着这个字符串」≠「这一路真的还在抽图」。
    //   真求值 + 每路只给一个只含该路的块 ⇒ 任何一路被删/被改坏，这里立刻红。
    const srcRaw = read('.tools/fetch-data.js');
    const iSafe = srcRaw.indexOf('function safeMediaUrl');
    const iParse = srcRaw.indexOf('function parseRss');
    let pick = null;
    try {
      pick = new Function(`${srcRaw.slice(iSafe, iParse)}\nreturn { safeMediaUrl, pickImage };`)();
    } catch {
      pick = null;
    }
    assert('C2b pickImage 可被求值（行为层判据的前提）', !!pick && typeof pick.pickImage === 'function');
    if (pick) {
      const routes = [
        ['media:content', '<item><media:content url="https://cdn.example.com/a.jpg"/></item>', 'https://cdn.example.com/a.jpg'],
        ['media:thumbnail', '<item><media:thumbnail url="https://cdn.example.com/b.jpg"/></item>', 'https://cdn.example.com/b.jpg'],
        ['enclosure(type 在 url 前)', '<item><enclosure type="image/jpeg" url="https://cdn.example.com/c.jpg"/></item>', 'https://cdn.example.com/c.jpg'],
        ['enclosure(url 在 type 前)', '<item><enclosure url="https://cdn.example.com/d.jpg" type="image/jpeg"/></item>', 'https://cdn.example.com/d.jpg'],
        ['正文首个 img', '<item><description><img src="https://cdn.example.com/e.jpg"/></description></item>', 'https://cdn.example.com/e.jpg']
      ];
      for (const [route, block, want] of routes) {
        const got = pick.pickImage(block);
        assert(`C2b 抽图 ${route} 能抽出自己的 url`, got === want, `got=${got}`);
      }
      // 安全网：非 http(s) 与超长 url 都不许过（safeMediaUrl 的职责，不能被绕开）
      assert(
        'C2b 抽图拒绝非 http(s) 协议',
        pick.pickImage('<item><media:content url="javascript:alert(1)"/></item>') === undefined
      );
      assert(
        'C2b 抽图拒绝超长 url',
        pick.pickImage(`<item><media:content url="https://e.com/${'x'.repeat(600)}"/></item>`) === undefined
      );
    }
  }
  {
    // 注意窗口方向：safeMediaUrl 的**定义**在 pickImage 之前，
    // 要看的是 pickImage **内部**有没有调用它 ⇒ 从 pickImage 的位置往后找。
    const iPick = fetchData.indexOf('function pickImage');
    const iCall = fetchData.indexOf('safeMediaUrl(', iPick);
    assert(
      'C3 抽图走 safeMediaUrl（只放行 http/https、≤512、无控制字符）',
      /function safeMediaUrl\(/.test(fetchData) && iPick >= 0 && iCall > iPick && iCall - iPick < 1200,
      `pickImage@${iPick} safeMediaUrl@${iCall}`
    );
  }
  assert(
    'C4 parseRss 把 image 放进条目（不是抽了不用）',
    /const image = pickImage\(b\)/.test(fetchData) && /\.\.\.\(image \? \{ image \} : \{\}\)/.test(fetchData)
  );
  assert(
    'C5 热点卡片渲染 item.image 且 lazyLoad（首屏预算：图片不许阻塞首屏）',
    /item\.image \?/.test(libraryTsx) && /lazyLoad/.test(libraryTsx)
  );
}

/* ───────────── D. 机构归一：alsoFrom 不得是「一家机构自己的两个 feed」 ───────────── */
{
  const { orgOfSource, FEED_ORG_MAP } = require_(path.join(ROOT, 'cloudfunctions/webSearch/cross-source.js'));
  const sameOrg = (names, label) =>
    assert(
      `D-${label}：${names.join(' / ')} 归一到同一机构`,
      new Set(names.map((n) => orgOfSource(n))).size === 1,
      names.map((n) => `${n}→${orgOfSource(n)}`).join(', ')
    );
  sameOrg(['NASA 新闻发布', 'NASA 快讯', 'NASA Science'], 'nasa');
  sameOrg(['Variety', 'Hollywood Reporter', 'Billboard', 'Rolling Stone', 'Pitchfork', 'Stereogum', 'IndieWire'], 'pmc');
  sameOrg(['中新网-财经', '中新网-社会', '中新网-即时'], 'chinanews');
  assert(
    'D4 不同机构不被误归（机构名 ≠ 来源名时不得塌成一家）',
    orgOfSource('IT之家') !== orgOfSource('少数派') &&
      orgOfSource('Ars Technica') !== orgOfSource('ScienceDaily')
  );
  assert(
    'D5 未登记的来源原样返回（不得凭空造机构名）',
    orgOfSource('IT之家') === 'IT之家' && orgOfSource('NASA 新闻发布') === 'NASA'
  );
  assert(
    'D6 机构表非空且覆盖到 NASA / PMC（防止以后新增源忘了登记）',
    Object.keys(FEED_ORG_MAP).length >= 11
  );
}

/* ───────────── E. 降级横幅：页面粒度（不许把真实数据说成演示数据） ───────────── */
{
  const hint = stripJsComments(read('src/components/DemoDataHint/index.tsx'));
  assert(
    'E1 DemoDataHint 支持页面粒度（actions prop）',
    /actions\?:\s*string\[\]/.test(hint) && /scope\.indexOf\(a\)\s*>=\s*0/.test(hint)
  );
  const scoped = [
    ['src/pages/library/index.tsx', '热点页'],
    ['src/pages/inbox/index.tsx', '收件箱页'],
    ['src/pages/shopping/index.tsx', '购物页'],
    ['src/pages/learnCommunity/index.tsx', '学习社区页']
  ];
  // ⚠️ 「我的」页**不在**这份清单里：那一页本来就承担全局降级提示（设置 / 用量 / 注销
  // 都在这页，显示全部降级是对的），且该文件当前由并行会话同时改动（多 AI 并发铁律：
  // 外来未提交改动原样保留、不碰）⇒ 门禁不对它提要求，避免「CI 拉的版本没有这一行」而红。
  for (const [rel, label] of scoped) {
    const src = stripJsComments(read(rel));
    assert(
      `E2 ${label} 传了自己的 actions（别的页面的降级不该串进来）`,
      /<DemoDataHint\s+actions=\{/.test(src)
    );
  }
}

/* ───────────── F. AI 精选提示词：两端逐字一致（防口径漂移） ───────────── */
{
  const webSearch = read('cloudfunctions/webSearch/index.js');
  const aiBranch = webSearch.slice(webSearch.indexOf("action === 'aiFilter'"));
  const cloudExpr = extractConstExpr(aiBranch, 'systemContent');
  const feExpr = extractConstExpr(read('src/services/cloud.ts'), 'AI_FILTER_SYSTEM_PROMPT');
  let same = false;
  let detail = '';
  try {
    if (!cloudExpr || !feExpr) {
      detail = `提取失败：cloud=${!!cloudExpr} fe=${!!feExpr}`;
    } else {
      const a = new Function(`return (${cloudExpr});`)();
      const b = new Function(`return (${feExpr});`)();
      same = a === b;
      detail = same ? '逐字一致' : `长度 ${String(a).length} vs ${String(b).length}`;
    }
  } catch (err) {
    detail = `求值失败：${err && err.message}`;
  }
  assert('F1 AI 精选提示词两端逐字一致（改一处不改另一处会被抓住）', same, detail);
}

/* ───────────── G. 热点数据源顺序：首屏请求预算 ───────────── */
{
  const iSame = cloudTs.indexOf('fetchHotspotJson(SAME_ORIGIN_HOTSPOT_URL)');
  const iLive = cloudTs.indexOf('fetchHotspotJson(LIVE_HOTSPOT_URL)');
  const iLocal = cloudTs.indexOf('fetchHotspotJson(LOCAL_API_HOTSPOT_URL)');
  assert(
    'G1 同源 ./api/hotspot.json 是第一优先（无跨域成本；实测那份必然 404 的目录路由不能再排第一）',
    iSame >= 0 && iLive >= 0 && iLocal >= 0 && iSame < iLive && iLive < iLocal,
    `same@${iSame} live@${iLive} local@${iLocal}`
  );
  assert(
    'G2 载荷有内存缓存与 in-flight 去重（跨页不重复下载几百 KB）',
    /hotspotInFlight/.test(cloudTs) && /hotspotCache/.test(cloudTs)
  );
  assert(
    'G3 载荷有新鲜度闸（烘焙副本过期才去问远端 ⇒ 常态只有 1 个请求）',
    /HOTSPOT_FRESH_MS/.test(cloudTs) && /HOTSPOT_CACHE_MS/.test(cloudTs)
  );
}

/* ───────────── 输出 ───────────── */
for (const r of rows) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
console.log(`PASS ${pass} / FAIL ${fail}`);
process.exit(fail > 0 ? 1 : 0);
