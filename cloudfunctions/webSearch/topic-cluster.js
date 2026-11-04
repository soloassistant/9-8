/**
 * 话题聚类 —— 同事件判定的**唯一实现**（2026-11-03 从 .tools/static-server.js 原样抽出）。
 *
 * 为什么要抽出来：文档 §P0-3 明确要求「话题聚类可复用 static-server 的四通道近重复，
 * 不要另写一套」。此前这套判定只存在于 static-server.js 里，而该文件 require 时就会
 * 起服务、且不导出任何东西 —— fetch-data.js 想用只能抄，一抄就会口径分叉（本仓已三次教训）。
 *
 * 与 static-server.js 的分工：本模块是**纯判定**（归一化 + 四通道 + isSameEvent），
 * 那边保留倒排索引等性能优化，但判定必须调本模块。
 * 评估工具 .tools/dedupe-eval.js 的 96 对金色基准集现在也指向这里（精度不许下降）。
 *
 * ⚠️ 判定取向是「宁可漏合并，不可错合并」：误合并 = 用户本该看到的新闻凭空消失，
 *    且用户无从察觉。任何阈值调整都必须先跑 dedupe-eval 看 precision。
 */

// ---------- 跨源同事件合并（聚类）阈值：关键词重叠通道 ----------
// 只作用于「归一化后既非完全相等、也不互为子串」的标题对，见 isKeywordDuplicate。
// 三个阈值都调松 → 更多重复被压掉，但误合并（把两件不同的事合成一条，用户本该看到的新闻直接消失）风险上升；
// 调紧 → 更保守，重复留得多（用户滑过去即可，代价低）。误合并不可逆且用户无从察觉，故整体取向是「宁可漏合并」。
const KEYWORD_SHARED_MIN = 4; // 两条标题共享的内容单元（中文 bigram / 拉丁词）个数下限。
//   调低 → 更短的标题也能凑够门槛，误合并风险上升；调高 → 抓不到「短标题 + 长标题补语」这类真实同事件。
const KEYWORD_RATIO_MIN = 0.9; // 重叠率下限：shared / min(|A|, |B|)。用 min 作分母 = 「较短那条几乎被较长那条覆盖」。
//   调低到 0.6 会让「苹果发布新款手机 / 苹果发布新款手表」这类共享 6 个 bigram、只差一个词的**不同事件**被误合并；
//   调高到 1.0 则要求完全覆盖，会漏掉真实同事件中的轻微措辞差异。
const KEYWORD_MIN_LEN = 8; // 关键词通道的长度门槛：两侧归一化长度都须 ≥ 此值才做判定。
//   调低 → 短标题（信息量少、偶然重叠概率高）也参与，误合并风险上升；调高 → 短标题的真实重复漏掉。

// ---------- 跨源同事件合并（聚类）阈值：完全包含通道（2026-09-28 新增，见 isFullContainDuplicate） ----------
// 依据：.tools/dedupe-golden.json（96 对标注基准集）+ .tools/dedupe-eval.js 的实测结果。
// 关键词通道要求 shared/min ≥ 0.9，抓不到「热点话题标签 vs 具体报道」这类**缩略**形态：
// 微博热搜《华为mate90》与《华为Mate90系列正面高清渲染图曝光》的 shared/min 恒为 1.0（短侧只 2 个内容单元，
// 全部被长侧覆盖），但 shared=2 < KEYWORD_SHARED_MIN=4 被绝对门槛挡掉。实测该通道 precision 不变、recall 提升。
const CONTAIN_MIN_LEN = 6; // 完全包含通道的长度门槛：**较短一方**归一化长度须 ≥ 此值。
//   调松到 4 → 极短标题（如「中国队夺金」）也参与，偶然全包含概率上升，误合并风险上升；
//   调紧到 8 → 与关键词通道同宽，会漏掉「华为mate90」这类 8 字以内的热点短标签（该通道的主要收益来源）。
const CONTAIN_MIN_SHARED = 2; // 完全包含通道的**短侧**内容单元数下限（完全包含时 shared ≡ min(|A|,|B|)）。
//   调松到 1 → 只剩 1 个内容单元的标题（如纯数字/单个词）只要被长标题覆盖就判同，与「个别偶然 bigram 重合」无法区分；
//     且会让触发条件落到基准集候选口径之外（候选集要求 shared ≥ 2），即**无法被基准集度量**。
//   调紧到 3/4 → 更保守，「华为mate90」（短侧 2 个内容单元）被排除，实测该通道收益归零。

// 两个**派生**门槛（不单独调，跟着上面两组常量走）：
// 倒排索引的「收录长度门槛」与「预筛共享数门槛」都必须取两条通道里**较松**的那个，
// 否则预筛会比 isSameEvent 的判定范围更严 —— 判定范围被预筛悄悄收窄，
// 表现为「评估工具说能合，真实聚合却不合」，是最难查的一类偏差。
const TOKEN_MIN_LEN = Math.min(KEYWORD_MIN_LEN, CONTAIN_MIN_LEN);
const VOTE_SHARED_MIN = Math.min(KEYWORD_SHARED_MIN, CONTAIN_MIN_SHARED);

/** 标题归一化：只收敛「同一事件的不同书写」，**绝不做分词、绝不做改写**。
 *  小写 → 去所有空白（含全角空格 U+3000）→ 去标点与符号类字符。
 *  \p{P} 覆盖 ·、，。！？：；""''（）【】《》-—_|/.,!?:;'"()[]<> 等标点，
 *  \p{S} 覆盖 emoji 与 # * ~ + = % 等符号类字符（含货币/数学/修饰符号）。
 *  保守的根因见下方聚类处的注释：误合并＝用户本该看到的新闻直接消失，代价高于重复。 */
function normalizeTitle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[\p{P}\p{S}]/gu, '');
}

/** 近重复判定（保守）：归一化后完全相等，或两者归一化长度**都 ≥ 10**且互为子串
 *  （用于「标题带来源后缀」这类同事件不同措辞）。
 *  刻意**不做分词 / 相似度打分 / 模糊阈值匹配**：少合并只是多留一条重复（用户滑过去即可），
 *  误合并则是把用户本该看到的另一件事凭空抹掉，不可逆且用户无从察觉。宁可漏合并，不可错合并。 */
function isNearDuplicate(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.length >= 10 && b.length >= 10 && (a.includes(b) || b.includes(a));
}

/** CJK 文字范围（中日韩 + 假名 + 朝鲜文；含扩展 A 与兼容表意区）。
 *  用显式码点区间而非 \p{Script=Han}：后者会把日文汉字/朝鲜文汉字算作 Han，
 *  但两者都要走 bigram 通道，区间并集更直观也更快。 */
const CJK_CHAR_RE = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/;
const LATIN_DIGIT_RE = /[a-z0-9]+/g;

/** 内容单元抽取：入参必须是 normalizeTitle() **之后**的字符串（已小写、已去空白与标点符号）。
 *  中文没有分词器，用相邻字符的**二元组 bigram** 做稳妥近似（「林诗栋」→ 林诗 / 诗栋）——
 *  bigram 不依赖词典，不会因 OOV 把同一事件切成不同单元，代价只是颗粒度粗。
 *  拉丁字母/数字按词切分，只取长度 ≥2 的词（单字母/单数字是噪声，不参与）。
 *  返回去重后的 Set；刻意不返回数组 —— 判定只需要集合交的大小。 */
function contentTokens(s) {
  const out = new Set();
  if (!s) return out;
  const str = String(s);
  // 相邻 CJK 字符的 bigram：遇到非 CJK 字符（数字、拉丁词、残留符号）即断链，
  // 避免把「4」「3」这类分隔符两侧的字跨接成假 bigram。
  let run = '';
  for (const ch of str) {
    if (CJK_CHAR_RE.test(ch)) run += ch;
    else {
      for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
      run = '';
    }
  }
  for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  for (const w of (str.match(LATIN_DIGIT_RE) || [])) if (w.length >= 2) out.add(w);
  return out;
}

/** 关键词重叠判定：isNearDuplicate 之外**更宽松但有门槛**的一条通道，
 *  用于抓「同一事件、措辞不同、且不是互为子串」的跨源重复
 *  （实测目标：微博「林诗栋4比3林昀儒」vs 抖音「林诗栋4比3逆转林昀儒挺进决赛」）。
 *  三个条件**同时**成立才判近重复：
 *    shared >= KEYWORD_SHARED_MIN   绝对重叠数下限，挡住两个短标题因个别偶然 bigram 重合被合并
 *    shared / min(|A|,|B|) >= KEYWORD_RATIO_MIN   用 min 作分母 = 较短那条几乎被较长那条覆盖
 *    aLen / bLen 都 >= KEYWORD_MIN_LEN   短标题信息量太少，不参与
 *  保守性：任一条不满足即不合并。 */
function isKeywordDuplicate(aTokens, bTokens, aLen, bLen) {
  if (aLen < KEYWORD_MIN_LEN || bLen < KEYWORD_MIN_LEN) return false;
  const minSize = Math.min(aTokens.size, bTokens.size);
  if (!minSize) return false;
  let shared = 0;
  for (const t of aTokens) if (bTokens.has(t)) shared += 1;
  if (shared < KEYWORD_SHARED_MIN) return false;
  return shared / minSize >= KEYWORD_RATIO_MIN;
}

/** 完全包含判定（第三条通道，2026-09-28 新增）：较短一方的**全部**内容单元都出现在较长一方
 *  （即 shared === min(|A|,|B|)）且较短一方归一化长度 ≥ CONTAIN_MIN_LEN。
 *  与 isKeywordDuplicate 的分工：关键词通道用「重叠率 ≥ 0.9」近似「短侧几乎被覆盖」，
 *  但它带 shared ≥ KEYWORD_SHARED_MIN 的绝对门槛，且两侧长度都要 ≥ 8，
 *  于是「热点短标签 vs 具体报道」（微博《华为mate90》/《华为Mate90系列正面高清渲染图曝光》）被挡在门外；
 *  完全包含通道专门补这一类：短侧内容单元**全部**被长侧覆盖才算，判定反而比 0.9 更严（要求 1.0 且是全量覆盖）。
 *  实测（.tools/dedupe-eval.js，96 对基准集）：precision 1.000 → 1.000 不变，recall 0.209 → 0.233，F1 +0.031。
 *  刻意**不**改成「只比 CJK bigram」：那样会丢掉起区分作用的拉丁/数字词 —— 实测把
 *  《iQOO16新品发布会》与《派早报：小米召开秋季新品发布会…》误合并（iQOO16 vs 小米），precision 掉到 0.917，故否决。
 *  CONTAIN_MIN_LEN 调松/调紧的影响见常量处注释。 */
function isFullContainDuplicate(aTokens, bTokens, aLen, bLen) {
  if (Math.min(aLen, bLen) < CONTAIN_MIN_LEN) return false;
  const minSize = Math.min(aTokens.size, bTokens.size);
  if (minSize < CONTAIN_MIN_SHARED) return false;
  let shared = 0;
  for (const t of aTokens) if (bTokens.has(t)) shared += 1;
  return shared === minSize;
}

/** 同事件判定的**唯一入口**：归一化相等 / 互为子串 / 关键词重叠 / 完全包含，四选一。
 *  fetchHotspot 内的候选判定必须走这里 —— 单测是从本文件抽取函数源码再 eval，
 *  若在生产里另写一份组合逻辑，抽取到的判定就与真实行为发散。 */
function isSameEvent(aKey, bKey, aTokens, bTokens) {
  if (isNearDuplicate(aKey, bKey)) return true;
  if (isKeywordDuplicate(aTokens, bTokens, aKey.length, bKey.length)) return true;
  return isFullContainDuplicate(aTokens, bTokens, aKey.length, bKey.length);
}

module.exports = {
  normalizeTitle,
  isNearDuplicate,
  contentTokens,
  isKeywordDuplicate,
  isFullContainDuplicate,
  isSameEvent,
  KEYWORD_SHARED_MIN,
  KEYWORD_RATIO_MIN,
  KEYWORD_MIN_LEN,
  CONTAIN_MIN_LEN,
  CONTAIN_MIN_SHARED,
  TOKEN_MIN_LEN,
  VOTE_SHARED_MIN,
  clusterItems,
  clusterKeyOf,
};

/**
 * 话题聚类（fetch-data 侧用）：把「同事件」的条目聚成一组，每组留一个代表条目。
 *
 * 保守取向的两点体现：
 *  · 只在**同一天**的条目之间判定（跨天同题更可能是不同事件的进展）；
 *  · 比较用归一化标题 + token 集合，用 isSameEvent 单一入口，不另写组合逻辑。
 *
 * 返回 [{ main, alsoFrom }] 顺序与输入一致（按首次出现的代表条目排序）。
 * alsoFrom 是「其他来源的机构名」数组（与 cross-source.js 的 orgOfSource 同口径，
 * 由调用方注入 orgOfSource —— 本模块不 require 那个文件，保持纯判定零依赖）。
 */
function clusterKeyOf(item) {
  return normalizeTitle((item && item.title) || '');
}

function clusterItems(items, opts = {}) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  const orgOf = typeof opts.orgOf === 'function' ? opts.orgOf : ((s) => s || '');
  const maxAlsoFrom = Number.isFinite(opts.maxAlsoFrom) ? opts.maxAlsoFrom : 5;
  const dayOf = (it) => String((it && (it.pubDate || it.createTime)) || '').slice(0, 10);

  const keys = list.map(clusterKeyOf);
  const tokens = keys.map((k) => contentTokens(k));
  const parent = list.map((_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[rb] = ra; };

  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (find(i) === find(j)) continue;
      // 同天才比（跨天同题更可能是事件进展）
      const di = dayOf(list[i]);
      const dj = dayOf(list[j]);
      if (di && dj && di !== dj) continue;
      if (!isSameEvent(keys[i], keys[j], tokens[i], tokens[j])) continue;
      union(i, j);
    }
  }

  // 按组收敛：代表条目 = 组内最早出现的那条（输入顺序即抓取时的时间序）
  const groups = new Map();
  for (let i = 0; i < list.length; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, { main: list[i], alsoFrom: [] });
    else {
      const g = groups.get(r);
      const org = orgOf(list[i] && list[i].source);
      if (org && org !== orgOf(g.main.source) && g.alsoFrom.length < maxAlsoFrom && !g.alsoFrom.includes(org)) {
        g.alsoFrom.push(org);
      }
    }
  }
  return [...groups.values()];
}
