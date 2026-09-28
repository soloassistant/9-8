// =============================================================================
// .tools/boards-core.js —— 热榜板块的「零依赖 · 线上可跑」取数实现
// =============================================================================
//
// 【为什么有这个文件】
// 热榜此前只有一条取数路径：本机 .tools/DailyHotApi 服务（http://127.0.0.1:6688）。
// 但 GitHub Actions 的 runner **够不到本机 127.0.0.1** —— 于是每天定时刷新的
// GitHub Pages 线上站点永远拿不到热榜（.tools/fetch-data.js 里也留了这条已知差异的说明）。
// 本文件把「不需要 cookie / 不需要签名、裸请求就能取到」的板块做成**直接打上游**的实现，
// 让线上定时任务也能取到热榜，不再依赖本机服务。
//
// 【为什么只做 6 个】（下表是 2026-09-28 用**不带 cookie 的裸请求**实测的结果）
//
//   板块            上游                                              实测结论
//   ---------------------------------------------------------------------------------------
//   HelloGitHub    https://abroad.hellogithub.com/v1/?sort_by=all      ✅ 200 / 12KB / 抽得出标题
//   果壳           https://www.guokr.com/beta/proxy/science_api/...    ✅ 200 / 63KB
//   数字尾巴       https://opser.api.dgtle.com/v2/news/index            ✅ 200 / 21KB
//   B站热榜        https://api.bilibili.com/x/web-interface/ranking/v2 ✅ 200 / 149KB（无需 WBI 签名）
//   百度热点       https://top.baidu.com/board?tab=realtime            ✅ 200 / 190KB（HTML 内嵌 JSON）
//   豆瓣电影       https://movie.douban.com/chart                      ✅ 200 / 50KB（服务端渲染 HTML）
//   微博热搜       https://weibo.com/ajax/side/hotSearch               ❌ fetch failed（拒绝无 cookie 访问）
//   知乎热榜       https://api.zhihu.com/topstory/hot-lists/total      ❌ fetch failed
//   抖音热点       https://www.douyin.com/aweme/v1/web/hot/search/...  ❌ http 200 但 **0 字节**（需先取 cookie）
//
// 后 3 个在原生日志服务器环境里拿不到数据（必须带 cookie 或签名），**故不在本文件实现**。
// 不要试图硬来：不内置任何 cookie、不伪造签名、不用第三方镜像站 —— 那类做法要么违法
// 平台条款/随时失效，要么等于把「热榜」变成不可控的第三方中间层。它们保持只在
// 本机 DailyHotApi 路径可用（见 .tools/static-server.js 的 hotBoard 清单）。
//
// 【这不是第四份实现，而是**唯一一份线上实现**】
// 本仓库已经有三处「源清单/取数」代码，每多抄一份就必然发散（.tools/static-server.js:280
// 与 .tools/fetch-data.js:62 都为此写过教训）。所以本文件的口径必须与现有实现**逐字对齐**：
//   · hash 算法与 .tools/fetch-data.js:19 完全一致（h*31 + charCode，>>>0，base36）
//   · 统一条目的 id / summary / source / tags 口径与 .tools/static-server.js:257 的
//     `hotBoard()` 完全同构 —— 同一条热榜无论在线上还是本机，算出的 id 与文案都一样。
// 本文件只做「取到 + 解析成统一条目」，**不做**聚合、去重、新鲜度闸门、AI 精选 ——
// 那些在集成侧（lead 把 fetchAllBoards() 接进取数链路时）复用已有实现，不在此重复。
//
// 【本文件不依赖任何第三方包】
// 只用 Node 内建（AbortController）+ 全局 fetch（Node 18+；Actions runner 与 Node 20 都可用）。
// 不引入 cheerio / jsdom：百度与豆瓣两处 HTML 用**定宽正则 + 容错解析**搞定，见各自解析函数。
//
// 自测：node .tools/boards-core.js --probe
// =============================================================================

'use strict';

/** 单板块超时（ms）。**必须**与生产 fetchText 的 8000ms 一致：
 *  超了这个数就等于「上线即失败」（.tools/board-probe.ts 里同名门槛的由来）。 */
const DEFAULT_TIMEOUT_MS = 8000;

/** 每板块默认取几条。与生产每源 10 条一致（static-server.js / fetch-data.js 都是 10）。 */
const DEFAULT_LIMIT = 10;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const ACCEPT_JSON = 'application/json, text/plain, */*';
const ACCEPT_HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const ACCEPT_LANG = 'zh-CN,zh;q=0.9,en;q=0.8';

/** 与 .tools/fetch-data.js / .tools/static-server.js 同一个 hash 口径（base36、无符号）。 */
function hash(s) {
  let h = 0;
  const str = String(s);
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** 文本归一：解码常见实体 → 剥标签 → 折叠空白 → trim。
 *  这不是洁癖：数字尾巴的 title 实测带回车换行前缀（"\r\n智美新境，越级而来。智能…"），
 *  不压平会污染标题，也会污染由 title 求出的 id。 */
function wash(s) {
  return String(s == null ? '' : s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 造一个带可读 reason 的错误。reason 会一路冒泡到 statuses[].reason。 */
function fail(reason, detail) {
  const e = new Error(reason);
  e.reason = reason;
  if (detail) e.detail = String(detail);
  return e;
}

/**
 * 取文本。超时用 AbortController（不用 Promise.race：race 在超时后请求仍在跑，
 * 不会释放连接；AbortController 会真正中断）。
 * @param {string} url
 * @param {{accept?:string, timeoutMs?:number, trace?:object, fetchImpl?:Function}} [opts]
 */
async function fetchText(url, opts) {
  const o = opts || {};
  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const doFetch = o.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) throw fail('no-fetch', 'global fetch 不可用（需 Node 18+）');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await doFetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: o.accept || ACCEPT_JSON,
        'Accept-Language': ACCEPT_LANG
      },
      redirect: 'follow',
      signal: ctrl.signal
    });
    if (o.trace) o.trace.http = res.status;
    if (!res.ok) throw fail('http-' + res.status);
    const text = await res.text();
    if (o.trace) o.trace.bytes = text.length;
    return text;
  } catch (e) {
    if (e && e.reason) throw e; // 已经是我们自己的可读 reason
    if (e && (e.name === 'AbortError' || /aborted/i.test(String(e.message)))) throw fail('timeout');
    const x = fail('network', (e && e.message) || e);
    throw x;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 各板块解析器
//
// 契约：入参是上游响应的**原文**，出参是数组，每项形如
//   { title, url, mobileUrl, hot, desc }
// 字段允许缺失/为空串 —— 归一与兜底在 normalizeList() 里统一做，解析器本身不做防御式判断。
// 解析器**不允许**因为结构变化而抛「看不懂」的错：抽不到就返回 []，
// 由上方把 reason 记成 empty-parse（真抛了则记 parse-error）。
// ---------------------------------------------------------------------------

/** HelloGitHub：JSON，条目在 data[]；item_id 是仓库 id（字符串 hash），
 *  链接形如 https://hellogithub.com/repository/<item_id>。hot 用 clicks_total。 */
function parseHelloGitHub(text) {
  const d = JSON.parse(text);
  const arr = Array.isArray(d && d.data) ? d.data : [];
  return arr.map((it) => {
    const repoId = it && it.item_id != null ? String(it.item_id) : '';
    const url = repoId ? 'https://hellogithub.com/repository/' + repoId : '';
    return {
      title: it && (it.title || it.name),
      url,
      mobileUrl: url,
      hot: it && it.clicks_total,
      desc: it && it.summary
    };
  });
}

/** 果壳：JSON，**顶层就是数组**（不是 {data:[]}）。
 *  实测 summary 全为空串，故 desc 常常为空 —— 如实呈现，不拿别的字段冒充。
 *  hot 用 replies_count（实测多为 0，0 视作无热度）。 */
function parseGuokr(text) {
  const d = JSON.parse(text);
  const arr = Array.isArray(d) ? d : Array.isArray(d && d.result) ? d.result : [];
  return arr.map((it) => {
    const id = it && it.id != null ? String(it.id) : '';
    const url = id ? 'https://www.guokr.com/article/' + id : '';
    const replies = Number(it && it.replies_count);
    return {
      title: it && it.title,
      url,
      mobileUrl: url,
      hot: replies > 0 ? String(replies) : '',
      desc: it && it.summary
    };
  });
}

/** 数字尾巴：JSON，条目在顶层 items[]（注意不是 data/result）。
 *  链接形如 https://www.dgtle.com/news-<id>-<type>.html，type 实测取值 14 / 5。
 *  hot 留空：上游只有 liketimes(0~1) / membernum / commentnum，都不是「热度」，不硬凑。 */
function parseDgtle(text) {
  const d = JSON.parse(text);
  const arr = Array.isArray(d && d.items) ? d.items : [];
  return arr.map((it) => {
    const id = it && it.id != null ? String(it.id) : '';
    const type = it && it.type != null ? String(it.type) : '';
    const url = id ? 'https://www.dgtle.com/news-' + id + '-' + type + '.html' : '';
    return {
      title: it && it.title,
      url,
      mobileUrl: url,
      hot: '',
      desc: it && (it.content || it.cate_name)
    };
  });
}

/** B站热榜：JSON data.list[]；**实测无需 WBI 签名**，裸请求即可。
 *  链接优先 short_link_v2（形如 https://b23.tv/BV14Baa6JENd，本身已是移动短链），
 *  兜底 https://www.bilibili.com/video/<bvid>。hot 用 stat.view（播放量）。 */
function parseBilibili(text) {
  const d = JSON.parse(text);
  const arr = Array.isArray(d && d.data && d.data.list) ? d.data.list : [];
  return arr.map((it) => {
    const bvid = it && it.bvid ? String(it.bvid) : '';
    const short = it && it.short_link_v2 ? String(it.short_link_v2) : '';
    const url = short || (bvid ? 'https://www.bilibili.com/video/' + bvid : '');
    const view = it && it.stat && it.stat.view;
    return {
      title: it && it.title,
      url,
      mobileUrl: url,
      hot: view == null ? '' : String(view),
      desc: it && it.desc
    };
  });
}

/** 百度热点：数据不在接口里，而是**页面 HTML 的注释节点**里内嵌一段 JSON：
 *      <!--s-data:{"data":{"cards":[{"component":"hotList","content":[...]}]}}-->
 *  实测该注释块长达 ~44KB / 51 个条目。这里用 matchAll 抓全部 s-data 块并**逐块容错**
 *  （单块 JSON 坏掉只跳过该块，不影响其他块）。条目字段：word/query 标题、
 *  desc 摘要、hotScore 热度、url 与 rawUrl 链接。 */
function parseBaidu(text) {
  const items = [];
  const re = /<!--s-data:([\s\S]*?)-->/g;
  let m;
  while ((m = re.exec(String(text)))) {
    let d;
    try {
      d = JSON.parse(m[1]);
    } catch (e) {
      continue; // 单块坏 → 跳过，不拖垮整板块
    }
    const cards = d && d.data && Array.isArray(d.data.cards) ? d.data.cards : [];
    for (const card of cards) {
      const content = card && Array.isArray(card.content) ? card.content : [];
      for (const e of content) {
        if (!e) continue;
        items.push({
          title: e.word || e.query,
          url: e.url || e.rawUrl || '',
          mobileUrl: e.rawUrl || e.url || '',
          hot: e.hotScore == null ? '' : String(e.hotScore),
          desc: e.desc
        });
      }
    }
  }
  return items;
}

/** 豆瓣电影：服务端渲染 HTML，热门榜条目是 <tr class="item"> 行。
 *  用正则抽取（不引 cheerio）：按行切分再在**行内定长窗口**里找 `<a class="nbg" href title>`。
 *  坑（实测）：a 标签属性间是**两个空格**（`class="nbg" href="…"  title="…"`），
 *  所以属性间必须用 \s+ 而不是单个空格，否则 10 行一条都抽不出来。
 *  顺带把评分/评价人数塞进 desc（豆瓣的 rating 不是「热度」，故 hot 留空）。 */
function parseDouban(text) {
  const chunks = String(text).split(/<tr\s+class="item">/).slice(1);
  const out = [];
  for (const chunk of chunks) {
    const seg = chunk.slice(0, 2000); // 行内定长窗口，避免跨行误抓
    const a = seg.match(/<a\s+class="nbg"\s+href="([^"]+)"\s+title="([^"]*)"/);
    if (!a) continue;
    const rating = (seg.match(/<span\s+class="rating_nums">([^<]*)<\/span>/) || [])[1] || '';
    const votes = (seg.match(/<span\s+class="pl">\(?([^<)]*?)\)?<\/span>/) || [])[1] || '';
    const parts = [];
    if (wash(rating)) parts.push('豆瓣评分 ' + wash(rating));
    if (wash(votes)) parts.push(wash(votes));
    out.push({
      title: a[2],
      url: a[1],
      mobileUrl: a[1],
      hot: '',
      desc: parts.join(' · ')
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 板块注册表 —— **唯一事实源**
//
// BOARDS 是从 ROUTES 派生的公开视图（只有 {id,label,tag}），不另抄一份，
// 免得「公开清单」与「真实注册表」各自维护而发散（这仓库已经为此吃过两次亏）。
//
// tag 的取值：垂类榜填类目（开源 / 科学 / 数码 / 影视），**综合榜填空串**。
// 这与生产口径完全一致：.tools/static-server.js 的 hotBoard(route,label,limit,tag) 里，
// 综合榜（微博/知乎/百度/抖音/B站）**不传 tag**，条目 tags 只有 ['热榜']，前端 categoryOf()
// 因此把它们归为「综合热榜」一类；垂类榜才挂 ['热榜', 类目]。
// 2026-09-28 修正：本模块初版把 B站热榜/百度热点硬塞成「科技」，那会凭空造出一个假的科技类目、
// 并把综合榜的时政敞口伪装成垂类内容 —— 二者本质都是算法综合榜，必须还原为综合榜语义。
const ROUTES = [
  {
    id: 'hellogithub',
    label: 'HelloGitHub',
    tag: '开源',
    url: 'https://abroad.hellogithub.com/v1/?sort_by=all&tid=&page=1',
    accept: ACCEPT_JSON,
    kind: 'json',
    parse: parseHelloGitHub
  },
  {
    id: 'guokr',
    label: '果壳',
    tag: '科学',
    url: 'https://www.guokr.com/beta/proxy/science_api/articles?limit=30',
    accept: ACCEPT_JSON,
    kind: 'json',
    parse: parseGuokr
  },
  {
    id: 'dgtle',
    label: '数字尾巴',
    tag: '数码',
    url: 'https://opser.api.dgtle.com/v2/news/index',
    accept: ACCEPT_JSON,
    kind: 'json',
    parse: parseDgtle
  },
  {
    id: 'bilibili',
    label: 'B站热榜',
    tag: '', // 综合榜：不挂类目（与生产 hotBoard 不传 tag 一致）
    url: 'https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all',
    accept: ACCEPT_JSON,
    kind: 'json',
    parse: parseBilibili
  },
  {
    id: 'baidu',
    label: '百度热点',
    tag: '', // 综合榜：不挂类目；另注意其榜单时政占比高，展示层降权策略须覆盖
    url: 'https://top.baidu.com/board?tab=realtime',
    accept: ACCEPT_HTML,
    kind: 'html',
    parse: parseBaidu
  },
  {
    id: 'douban-movie',
    label: '豆瓣电影',
    tag: '影视',
    url: 'https://movie.douban.com/chart',
    accept: ACCEPT_HTML,
    kind: 'html',
    parse: parseDouban
  }
];

/** 公开板块清单：[{ id, label, tag }] */
const BOARDS = ROUTES.map((b) => ({ id: b.id, label: b.label, tag: b.tag }));

/** 归一 + 截断：保证返回的一定是 {title,url,mobileUrl,hot,desc} 全为字符串的数组，
 *  丢掉空标题项，并按 limit 截断。任何字段类型不符（null/number/object）都被强转成字符串。 */
function normalizeList(list, limit) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const it of list) {
    if (!it) continue;
    const title = wash(it.title);
    if (!title) continue;
    out.push({
      title,
      url: String(it.url || ''),
      mobileUrl: String(it.mobileUrl || ''),
      hot: wash(it.hot),
      desc: wash(it.desc)
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 取单个板块。
 *
 * **契约：对上游的任何问题都不抛异常，一律返回数组**（取不到就是 []）。
 * 失败原因不丢，而是写进 opts.trace.reason（见下）—— 这样调用方拿到的永远是
 * 声明好的 Array 形状，同时 reason 又能在 fetchAllBoards / --probe 里如实上报。
 * 唯一会抛的是 `unknown-board`：那是调用方把 id 传错了（编码错误），不是上游状况。
 *
 * @param {string} id BOARDS 里的 id
 * @param {{limitPerBoard?:number, timeoutMs?:number, trace?:object,
 *          urlOverride?:Object<string,string>, fetch?:Function}} [opts]
 *   trace   —— 传入一个对象即可回读 { http, bytes, reason }，用于诊断与自测。
 *   urlOverride / fetch —— 给测试留的缝：不动线上代码、不真打生产 URL 也能做容错演练。
 * @returns {Promise<Array<{title:string,url:string,mobileUrl:string,hot:string,desc:string}>>}
 */
async function fetchBoard(id, opts) {
  const o = opts || {};
  const src = ROUTES.find((b) => b.id === id);
  if (!src) throw fail('unknown-board', id);
  const limit = Number(o.limitPerBoard) > 0 ? Number(o.limitPerBoard) : DEFAULT_LIMIT;
  const url = (o.urlOverride && o.urlOverride[id]) || src.url;

  try {
    const text = await fetchText(url, {
      accept: src.accept,
      timeoutMs: o.timeoutMs,
      trace: o.trace,
      fetchImpl: o.fetch
    });
    // 解析器本身也只返回数组；它若抛（JSON 坏 / 结构完全变了），在这里归类成可读 reason
    return normalizeList(src.parse(text, limit), limit);
  } catch (e) {
    const reason = (e && e.reason) || (src.kind === 'json' ? 'json-parse' : 'parse-error');
    if (o.trace) o.trace.reason = reason;
    return [];
  }
}

/**
 * 并发取全部板块 → 统一条目 + 状态。
 *
 * 关键性质：
 *   · **单个板块失败绝不影响其他板块**（每个板块各自 try/catch，Promise.all 只等不炸）
 *   · items 按 BOARDS 顺序**按板块分组**输出（板块内保持上游排名），
 *     是否跨板块轮询交错由集成侧的既有合并逻辑决定 —— 本文件不重复实现那套。
 *   · 统一条目口径与 .tools/static-server.js:257 的 hotBoard() 完全一致：
 *     id = 'hot_' + hash(label + title)、summary = "<label> 第 N 位[ · 热度 X]"、
 *     source = label、tags = ['热榜', tag]。
 *
 * @returns {Promise<{items:Array, statuses:Array<{id:string,label:string,ok:boolean,count:number,reason:string,ms:number}>}>}
 */
async function fetchAllBoards(opts) {
  const o = opts || {};

  const results = await Promise.all(
    BOARDS.map(async (board) => {
      const t0 = Date.now();
      const trace = {};
      let list = [];
      let reason = '';
      try {
        list = await fetchBoard(board.id, Object.assign({}, o, { trace }));
        if (!list.length) reason = trace.reason || 'empty-parse';
      } catch (e) {
        // fetchBoard 已保证不因上游问题抛错；这里纯粹是「隔离兜底」：
        // 万一有未预料的异常，也只影响本板块，绝不让 Promise.all 整体 reject。
        reason = (e && e.reason) || 'unknown';
      }
      return { board, list, reason, ms: Date.now() - t0 };
    })
  );

  const items = [];
  const statuses = [];
  for (const r of results) {
    for (let i = 0; i < r.list.length; i++) {
      const it = r.list[i];
      items.push({
        id: 'hot_' + hash(r.board.label + it.title),
        title: it.title,
        summary: r.board.label + ' 第 ' + (i + 1) + ' 位' + (it.hot ? ' · 热度 ' + it.hot : ''),
        source: r.board.label,
        url: it.mobileUrl || it.url || '',
        // 综合榜 tag 为空 → 只挂 ['热榜']，前端 categoryOf() 归为「综合热榜」（与 static-server 同口径）
        tags: r.board.tag ? ['热榜', r.board.tag] : ['热榜']
      });
    }
    statuses.push({
      id: r.board.id,
      label: r.board.label,
      ok: r.list.length > 0,
      count: r.list.length,
      reason: r.list.length > 0 ? '' : r.reason || 'empty-parse',
      ms: r.ms
    });
  }

  return { items, statuses };
}

// ---------------------------------------------------------------------------
// CLI 自测：node .tools/boards-core.js --probe
//
// 逐板块打印 http / 耗时 / 条数 / 前 2 条标题，**任一板块失败也继续跑完**，
// 末尾汇总「可用 N/6」。因为要如实读耗时，这里**串行**跑（并发会互相争带宽，
// 耗时读数会失真）；并发能力由随后的 fetchAllBoards() 单独验证。
// 退出码：6 个全可用 → 0，否则 1（便于接进 CI 当门槛）。
// ---------------------------------------------------------------------------
async function probe() {
  console.log(
    '[boards-core] 逐板块探测 · 超时 ' + DEFAULT_TIMEOUT_MS + 'ms · 每板块 ' + DEFAULT_LIMIT + ' 条 · 共 ' + BOARDS.length + ' 个板块'
  );
  let okCount = 0;
  for (const board of BOARDS) {
    const trace = {};
    const t0 = Date.now();
    let list = [];
    let reason = '';
    try {
      list = await fetchBoard(board.id, { trace });
      if (!list.length) reason = trace.reason || 'empty-parse';
    } catch (e) {
      reason = (e && e.reason) || 'unknown';
    }
    const ms = Date.now() - t0;
    const ok = list.length > 0;
    if (ok) okCount++;
    const flags = [];
    if (ok && list.length < 5) flags.push('⚠ 条数<5');
    if (ms > DEFAULT_TIMEOUT_MS) flags.push('⚠ 超过 ' + DEFAULT_TIMEOUT_MS + 'ms');
    console.log(
      '  [' + (ok ? 'OK  ' : 'FAIL') + '] ' +
        board.id.padEnd(13) + board.label.padEnd(11) +
        ' http=' + String(trace.http == null ? '-' : trace.http).padEnd(4) +
        ' ' + String(ms).padStart(5) + 'ms' +
        ' 条数=' + String(list.length).padStart(2) +
        (reason ? '  reason=' + reason : '') +
        (flags.length ? '  ' + flags.join(' ') : '')
    );
    for (const t of list.slice(0, 2)) console.log('           - ' + t.title.slice(0, 60));
  }
  console.log('\n[boards-core] 可用 ' + okCount + '/' + BOARDS.length);

  // 顺便验证生产路径（并发 + 状态 + 统一条目），并留一份形状样例
  const { items, statuses } = await fetchAllBoards();
  console.log('[boards-core] fetchAllBoards() 统一条目 ' + items.length + ' 条');
  console.log('[boards-core] statuses = ' + JSON.stringify(statuses, null, 2));
  console.log('[boards-core] 前 2 条统一条目 = ' + JSON.stringify(items.slice(0, 2), null, 2));

  process.exit(okCount === BOARDS.length ? 0 : 1);
}

if (require.main === module && process.argv.indexOf('--probe') > -1) {
  probe().catch((e) => {
    console.error('[boards-core] probe 致命错误：' + ((e && e.message) || e));
    process.exit(1);
  });
}

module.exports = { BOARDS, fetchBoard, fetchAllBoards };
