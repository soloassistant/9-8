// 跨源同事件合并（isSameEvent）的**可复现回归评估工具**。
//
// 为什么是「抽取生产源码再 eval」而不是手抄一份判定逻辑：
//   本项目 2026-09-24 已因「两份各自维护的清单必然发散」踩过坑（见 static-server.js 的
//   loadRssSourcesFromCloud 注释）。判重逻辑若在评估侧手抄一份，评估就不再描述生产行为，
//   基准集会变成一份自我感觉良好的假证据。故本工具与 .tools/vet-feeds.js 同款做法：
//   按函数名从 .tools/static-server.js **抽取源码文本并 eval**，评估与生产走同一份代码。
//
// 用法：
//   node .tools/dedupe-eval.js                     # 当前生产规则，全量口径
//   node .tools/dedupe-eval.js --only high          # 只用 confidence=high 的样本（更保守口径）
//   node .tools/dedupe-eval.js --candidate all     # 生产 + 全部候选信号，并列出 P/R/F1 差异
//   node .tools/dedupe-eval.js --candidate full-contain --candidate num-conflict
//   node .tools/dedupe-eval.js --candidate rare-entity   # 稀有共享实体通道（需 DF 上下文）
//   node .tools/dedupe-eval.js --shared 3 --ratio 0.8 --minlen 6   # 扫参：覆盖三个 KEYWORD_* 阈值
//   node .tools/dedupe-eval.js --rare-df 2 --rare-token-min 6 --rare-min-len 8 --rare-ngram 3  # 扫参：稀有实体通道
//   node .tools/dedupe-eval.js --candidate rare-entity --df-mode corpus      # 换 DF 口径
//   node .tools/dedupe-eval.js --baseline 0.40     # 覆盖 F1 基准线
//
// 退出码：**当前生产规则**的 F1 低于 BASELINE_F1 时非 0（便于接进 CI 回归）。
//   基准线是具名常量，初始值为 2026-09-28 实测的当前生产规则 F1（见 BASELINE_F1 注释）。
//
// 本工具**只读**：不修改任何生产文件，不写盘。

const fs = require('fs');
const path = require('path');

const SERVER_JS = path.join(__dirname, 'static-server.js');
const GOLDEN_JSON = path.join(__dirname, 'dedupe-golden.json');

/** 当前生产规则的 F1 基准线（全量口径）。
 *  来源：2026-09-28 首次跑本工具实测所得（96 对基准集，生产规则 TP=9 FP=0 FN=34 TN=53，
 *  P=1.000 R=0.209 F1=0.3462）。低于该值即回归失败 —— 调阈值 / 改判定时若把 F1 调低，
 *  必须在这里留下可见的证据与理由。 */
const BASELINE_F1 = 0.346;

const src = fs.readFileSync(SERVER_JS, 'utf8');

// ---------- 从生产文件抽取代码（括号配平，抗行号漂移） ----------
function extractFn(text, name) {
  const start = text.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('生产文件中未找到函数 ' + name);
  let depth = 0;
  let seen = false;
  for (let j = text.indexOf('{', start); j < text.length; j++) {
    const c = text[j];
    if (c === '{') { depth++; seen = true; } else if (c === '}') {
      depth--;
      if (seen && depth === 0) return text.slice(start, j + 1);
    }
  }
  throw new Error('括号未配平: ' + name);
}
function extractConst(text, name) {
  const m = text.match(new RegExp('const\\s+' + name + '\\s*=\\s*([^;]+);'));
  if (!m) throw new Error('生产文件中未找到常量 ' + name);
  return m[1].trim();
}
/** 把 text 里名为 name 的函数整体替换为 replacement（同名函数替换 = 候选规则的接入方式） */
function replaceFn(text, name, replacement) {
  const old = extractFn(text, name);
  return text.replace(old, replacement);
}

// 生产侧需要抽取的常量与函数（isSameEvent 是唯一判定入口，必须抽到）。
// ⚠️ 若 isSameEvent 新增了依赖（新的判重通道 / 新常量），必须同步加进这两个清单 ——
// 缺了会在 eval 时抛 ReferenceError（不会静默降级），这是刻意留的硬失败。
const CONST_NAMES = ['KEYWORD_SHARED_MIN', 'KEYWORD_RATIO_MIN', 'KEYWORD_MIN_LEN',
  'CONTAIN_MIN_LEN', 'CONTAIN_MIN_SHARED', 'CJK_CHAR_RE', 'LATIN_DIGIT_RE',
  'RARE_ENTITY_DF_MAX', 'RARE_ENTITY_MIN_LEN', 'RARE_ENTITY_TOKEN_MIN_LEN', 'RARE_ENTITY_NGRAM'];
const FN_NAMES = ['normalizeTitle', 'contentTokens', 'isNearDuplicate', 'isKeywordDuplicate',
  'isFullContainDuplicate', 'rareEntityTokens', 'buildRareEntityDf', 'isRareEntityDuplicate', 'isSameEvent'];

const PROD = {
  consts: Object.fromEntries(CONST_NAMES.map((n) => [n, extractConst(src, n)])),
  fns: Object.fromEntries(FN_NAMES.map((n) => [n, extractFn(src, n)]))
};

// ---------- 候选信号 ----------
// 每个候选只做一件事：用**同名函数的替换实现**改写判定（fns），可附带常量覆盖（consts）。
// 不改生产文件 —— 候选的采纳与否由基准集上的 P/R/F1 说话，不由直觉说话。
// status：proposed=待评；adopted=已并入生产（此时差异应为 0，差异非 0 就说明生产接线被改动过）。
const CANDIDATES = [
  {
    name: 'full-contain',
    status: 'adopted',
    note: '信号甲：较短一方的全部内容单元都出现在较长一方（shared === min(|A|,|B|)）且较短一方长度 ≥6 → 判同一事件',
    consts: { CONTAIN_MIN_LEN: '6', CONTAIN_MIN_SHARED: '2' },
    fns: {
      isSameEvent: [
        'function isSameEvent(aKey, bKey, aTokens, bTokens) {',
        '  if (isNearDuplicate(aKey, bKey)) return true;',
        '  if (isKeywordDuplicate(aTokens, bTokens, aKey.length, bKey.length)) return true;',
        '  return isFullContainDuplicate(aTokens, bTokens, aKey.length, bKey.length);',
        '}'
      ].join('\n')
    }
  },
  {
    name: 'num-conflict',
    status: 'rejected',
    note: '信号乙：两侧都有数字且数字集合不完全一致时**否决**合并（如 4比3 vs 4比1）',
    fns: {
      // 数字冲突抑制：体育/财经标题里的数字（比分、价格、轮次、数量）往往是区分事件的关键，
      // 而 contentTokens 把 digit 当非 CJK 断链符 → **完全看不见数字**，重叠率对数字差异不敏感。
      // 这里在归一化串上另取数字集合（\d+；小数点已被 normalizeTitle 当标点去掉，故 25.98 会变成
      // 2598 —— 两侧口径一致，不影响「是否冲突」的判断）。
      // 保守性：只有**双方都有数字**且集合不完全一致才算冲突；单侧有数字（《王楚钦vs阿拉米扬》）不算冲突。
      hasNumberConflict: [
        'function hasNumberConflict(aKey, bKey) {',
        '  const numRe = /\\d+/g;',
        '  const na = new Set(String(aKey || \'\').match(numRe) || []);',
        '  const nb = new Set(String(bKey || \'\').match(numRe) || []);',
        '  if (!na.size || !nb.size) return false;',
        '  if (na.size !== nb.size) return true;',
        '  for (const n of na) if (!nb.has(n)) return true;',
        '  return false;',
        '}'
      ].join('\n'),
      isSameEvent: [
        'function isSameEvent(aKey, bKey, aTokens, bTokens) {',
        '  const dup = isNearDuplicate(aKey, bKey)',
        '    || isKeywordDuplicate(aTokens, bTokens, aKey.length, bKey.length)',
        '    || isFullContainDuplicate(aTokens, bTokens, aKey.length, bKey.length);',
        '  if (!dup) return false;',
        '  return !hasNumberConflict(aKey, bKey);',
        '}'
      ].join('\n')
    }
  },
  {
    name: 'rare-entity',
    status: 'rejected',
    needsCtx: true,
    note: '信号丙：两条标题共享一个「稀有实体」（中文 3-gram / 拉丁词，且 DF ≤ RARE_ENTITY_DF_MAX）→ 判同一事件。'
      + '实测**不采纳**：112 档网格（N∈{3,4} × DF_MAX∈{1..8} × TOK_MIN∈{3..6} × MIN_LEN∈{6,8}）在线上真实 DF 口径下，'
      + 'FP=0 的 36 档**TP 全部恒等于基线 10 —— 零增益**；一旦有增益，最高 precision 只有 0.944（仍有 1 条 FP）。'
      + '任务建议档 N=3/DF_MAX=4/TOK_MIN=3/MIN_LEN=8 → TP=25 FP=21 P=0.543 R=0.581。'
      + '根因：DF 只能度量「出现次数少」，无法区分「专名」与「恰好低频的通用词」（发布会/技能包/如何评价），'
      + '更无法区分「同一专名的不同事件」（孔子诞辰两地、特斯拉降价vs涨价、智界R7上市vs交付）。',
    fns: {
      // 组合式接入：稀有实体通道**插在原有的近重复/关键词/完全包含之前**，任一条命中即判同。
      // 生产侧 isRareEntityDuplicate / buildRareEntityDf / rareEntityTokens 由本工具从
      // .tools/static-server.js 抽取（见 FN_NAMES），因此这里度量的就是生产源码本体，而非重写一份。
      // 唯一的外部输入是 DF 上下文 ctx（{ df: Map<实体, 文档频次> }），由本工具的 makeCtxFor 按
      // --df-mode 指定的语料构造 —— 这是「线上按当前快照算 DF」在离线评估里的等价物，差异见 makeCtxFor 注释。
      isSameEvent: [
        'function isSameEvent(aKey, bKey, aTokens, bTokens, ctx) {',
        '  if (isNearDuplicate(aKey, bKey)) return true;',
        '  if (isRareEntityDuplicate(aKey, bKey, ctx)) return true;',
        '  if (isKeywordDuplicate(aTokens, bTokens, aKey.length, bKey.length)) return true;',
        '  return isFullContainDuplicate(aTokens, bTokens, aKey.length, bKey.length);',
        '}'
      ].join('\n')
    }
  }
];

// ---------- 组装可 eval 的判定源码 ----------
// overrides.thresholds：覆盖上面任一类阈值常量（扫参用）
// overrides.candidate ：候选信号（同名函数替换 + 常量覆盖）
// 注意：rareEntityTokens / buildRareEntityDf / isRareEntityDuplicate 也**从生产文件抽取**，
//   即使当前未被 isSameEvent 调用 —— 它们是有意保留的候选通道实现（评估未通过，见 static-server.js 注释），
//   抽取进来才能保证「评估到的稀有实体判定」与生产源码逐字一致。
const BASE_FN_ORDER = ['normalizeTitle', 'contentTokens', 'isNearDuplicate', 'isKeywordDuplicate',
  'isFullContainDuplicate', 'rareEntityTokens', 'buildRareEntityDf', 'isRareEntityDuplicate'];

function buildDecider(overrides = {}) {
  const cand = overrides.candidate || null;
  const consts = { ...PROD.consts, ...(overrides.thresholds || {}), ...((cand && cand.consts) || {}) };
  const fns = { ...PROD.fns, ...((cand && cand.fns) || {}) };
  const lines = CONST_NAMES.map((n) => {
    if (!(n in consts)) throw new Error('缺少常量 ' + n);
    return 'const ' + n + ' = ' + consts[n] + ';';
  });
  for (const n of BASE_FN_ORDER) lines.push(fns[n]);
  // 候选自带的、不在基础清单里的辅助函数（如 hasNumberConflict）—— 必须排在 isSameEvent 之前
  for (const [n, s] of Object.entries((cand && cand.fns) || {})) {
    if (n !== 'isSameEvent' && !BASE_FN_ORDER.includes(n)) lines.push(s);
  }
  lines.push(fns.isSameEvent);
  lines.push('return { normalizeTitle, contentTokens, isNearDuplicate, isKeywordDuplicate, isFullContainDuplicate,'
    + ' rareEntityTokens, buildRareEntityDf, isRareEntityDuplicate, isSameEvent,'
    + ' KEYWORD_SHARED_MIN, KEYWORD_RATIO_MIN, KEYWORD_MIN_LEN, CONTAIN_MIN_LEN, CONTAIN_MIN_SHARED,'
    + ' RARE_ENTITY_DF_MAX, RARE_ENTITY_MIN_LEN, RARE_ENTITY_TOKEN_MIN_LEN, RARE_ENTITY_NGRAM };');
  // eval 出的正是生产代码本体。no-new-func 是有意为之：唯一目的是消除评估与生产之间的发散。
  return new Function(lines.join('\n'))(); // eslint-disable-line no-new-func
}

// ---------- DF 上下文（仅稀有实体通道需要） ----------
// 线上口径：DF 的语料 = **当前这一轮抓取的全部条目**（含被比较的两条条目本身）→ 共享实体 DF 恒 ≥2。
// 评估口径有两个可选模式：
//   inject（默认，**还原线上事实**）：DF 语料 = 基准集涉及的两份快照全量条目 ∪ {该对的两条标题}。
//     理由：基准集里的「构造型」负例（如《苹果发布新款手机》/《苹果发布新款手表》）并不在快照里，
//     若不加进去，它们的实体 DF=0 会被判为「不稀有」而漏触发，precision 被虚高（实测差到 0 → 假 1.000）。
//   corpus：DF 语料 = 两份快照全量条目（不含该对标题）。保留是为了量化上面这个偏差有多大。
// 与线上的已知差异（已实测，方向明确）：线上 DF 只按「当前快照」（单次抓取）；评估默认用
//   「基准集两份快照全量条目并集」（hotspot.json 262 条 + raw-snapshot.json 262 条，去重后 334 条）。
//   语料更大 → DF 偏大 → 更少实体够得上「稀有」→ 更少合并。实测把语料换成单份快照（262 条，= 线上规模）后
//   默认档 FP 由 21 升到 25（P 0.543 → 0.561）—— 即**本评估相对线上是偏乐观的**：
//   真实线上的 precision 只会比这里更差，不会更好。故「FP>0」的结论在线上同样成立且更强。
// 语料文件支持两种快照形态（本项目历史上两种都出现过，都要能读）：
//   { at, items: [...] }                  —— 聚合后的产物（static-server 的磁盘缓存 hotspot.json）
//   { at, groups: [{name, items:[...]}] } —— 未聚合的原始抓取（.tmp-verify 的 raw-snapshot.json）
function snapshotTitles(j, normalize) {
  const out = [];
  if (Array.isArray(j.items)) out.push(...j.items);
  if (Array.isArray(j.groups)) for (const g of j.groups) if (g && Array.isArray(g.items)) out.push(...g.items);
  return out.map((it) => normalize(it && it.title)).filter(Boolean);
}

function makeCtxFor(decider, o, golden) {
  const files = o.dfCorpus.length
    ? o.dfCorpus
    : (golden.snapshots || []).map((s) => s.file).filter(Boolean);
  const titles = [];
  const seen = new Set();
  const loaded = [];
  for (const f of files) {
    let j;
    try {
      j = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) {
      console.log('  ⚠️ DF 语料不可读，已跳过：' + f + '（' + e.message + '）');
      continue;
    }
    const ks = snapshotTitles(j, decider.normalizeTitle);
    for (const k of ks) if (!seen.has(k)) { seen.add(k); titles.push(k); }
    loaded.push(f + '（items=' + ks.length + '）');
  }
  if (!titles.length) {
    throw new Error('稀有实体通道需要 DF 语料，但一条可用条目都没读到（--df-corpus 指定，或 golden.snapshots[].file）');
  }
  const baseDf = decider.buildRareEntityDf(titles); // corpus 口径的 DF，构建一次复用
  const dfMeta = { mode: o.dfMode, files: loaded, corpusItems: titles.length };
  const cache = new Map();
  return {
    meta: dfMeta,
    /** 按当前 --df-mode 给出该标题对的 ctx；inject 模式把两条标题并进语料后再算 DF。 */
    ctxFor(aKey, bKey) {
      if (o.dfMode === 'corpus') return { df: baseDf };
      const id = aKey + '\u0000' + bKey;
      if (cache.has(id)) return cache.get(id);
      // 直接重建 DF 而不是「baseDf 各 +1」：被比较条目可能本就已在语料里，重建口径更不易错。
      const ctx = { df: decider.buildRareEntityDf(titles.concat(bKey === aKey ? [aKey] : [aKey, bKey])) };
      cache.set(id, ctx);
      return ctx;
    }
  };
}

// ---------- 命令行 ----------
function parseArgs(argv) {
  const o = { only: '', candidates: [], thresholds: {}, baseline: BASELINE_F1, errors: true,
    dfMode: 'inject', dfCorpus: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--only') o.only = String(next() || '').toLowerCase();
    else if (a === '--candidate') o.candidates.push(String(next() || ''));
    else if (a === '--all') o.candidates.push('all');
    else if (a === '--shared') o.thresholds.KEYWORD_SHARED_MIN = Number(next());
    else if (a === '--ratio') o.thresholds.KEYWORD_RATIO_MIN = Number(next());
    else if (a === '--minlen') o.thresholds.KEYWORD_MIN_LEN = Number(next());
    else if (a === '--rare-df') o.thresholds.RARE_ENTITY_DF_MAX = Number(next());
    else if (a === '--rare-token-min') o.thresholds.RARE_ENTITY_TOKEN_MIN_LEN = Number(next());
    else if (a === '--rare-min-len') o.thresholds.RARE_ENTITY_MIN_LEN = Number(next());
    else if (a === '--rare-ngram') o.thresholds.RARE_ENTITY_NGRAM = Number(next());
    else if (a === '--df-mode') o.dfMode = String(next() || '').toLowerCase();
    else if (a === '--df-corpus') o.dfCorpus.push(String(next() || ''));
    else if (a === '--baseline') o.baseline = Number(next());
    else if (a === '--no-errors') o.errors = false;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error('未知参数 ' + a);
  }
  if (o.dfMode !== 'inject' && o.dfMode !== 'corpus') throw new Error('--df-mode 只能是 inject 或 corpus');
  return o;
}

function metrics(cases, decide, ctxFor) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  const errors = [];
  for (const c of cases) {
    const ka = decide.normalizeTitle(c.a);
    const kb = decide.normalizeTitle(c.b);
    // ctx 只有稀有实体通道会读；其余候选/生产规则的 isSameEvent 忽略第 5 个参数。
    const ctx = ctxFor ? ctxFor(ka, kb) : null;
    const pred = decide.isSameEvent(ka, kb, decide.contentTokens(ka), decide.contentTokens(kb), ctx);
    const truth = c.label === 'same';
    if (pred && truth) tp += 1;
    else if (pred && !truth) fp += 1;
    else if (!pred && truth) fn += 1;
    else tn += 1;
    if (pred !== truth) errors.push({ c, pred });
  }
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const total = tp + fp + fn + tn;
  return { tp, fp, fn, tn, precision, recall, f1, accuracy: total ? (tp + tn) / total : 0, total, errors };
}

const fmt = (x) => (x * 100).toFixed(1).padStart(5) + '%';
const f3 = (x) => x.toFixed(3);

function printReport(title, m) {
  console.log('--- ' + title + ' ---');
  console.log('  混淆矩阵  预测同/实际同 TP=' + m.tp + '   预测同/实际异 FP=' + m.fp
    + '   预测异/实际同 FN=' + m.fn + '   预测异/实际异 TN=' + m.tn + '   （N=' + m.total + '）');
  console.log('  precision=' + f3(m.precision) + ' (' + fmt(m.precision) + ')'
    + '  recall=' + f3(m.recall) + ' (' + fmt(m.recall) + ')'
    + '  F1=' + f3(m.f1) + '  accuracy=' + f3(m.accuracy) + ' (' + fmt(m.accuracy) + ')');
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log('用法见本文件头部注释。');
    return 0;
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN_JSON, 'utf8'));
  const all = golden.cases;
  const cases = o.only === 'high' ? all.filter((c) => c.confidence === 'high') : all;

  console.log('基准集：' + GOLDEN_JSON);
  console.log('  总对数 ' + all.length + '（same=' + all.filter((c) => c.label === 'same').length
    + ' / different=' + all.filter((c) => c.label === 'different').length
    + '），confidence=low ' + all.filter((c) => c.confidence === 'low').length);
  for (const s of golden.snapshots || []) console.log('  快照 ' + s.file + '  at=' + s.at + '  items=' + s.items);
  console.log('  本次口径：' + (o.only === 'high' ? '--only high（仅 high 置信度，' + cases.length + ' 对）' : '全量（' + cases.length + ' 对）'));
  const prod = buildDecider({ thresholds: o.thresholds });
  console.log('  生效阈值：KEYWORD_SHARED_MIN=' + prod.KEYWORD_SHARED_MIN
    + '  KEYWORD_RATIO_MIN=' + prod.KEYWORD_RATIO_MIN + '  KEYWORD_MIN_LEN=' + prod.KEYWORD_MIN_LEN
    + '  CONTAIN_MIN_LEN=' + prod.CONTAIN_MIN_LEN + '  CONTAIN_MIN_SHARED=' + prod.CONTAIN_MIN_SHARED);
  if (o.thresholds.RARE_ENTITY_DF_MAX !== undefined || o.thresholds.RARE_ENTITY_TOKEN_MIN_LEN !== undefined
    || o.thresholds.RARE_ENTITY_MIN_LEN !== undefined || o.thresholds.RARE_ENTITY_NGRAM !== undefined) {
    console.log('  稀有实体通道阈值：RARE_ENTITY_DF_MAX=' + prod.RARE_ENTITY_DF_MAX
      + '  RARE_ENTITY_TOKEN_MIN_LEN=' + prod.RARE_ENTITY_TOKEN_MIN_LEN
      + '  RARE_ENTITY_MIN_LEN=' + prod.RARE_ENTITY_MIN_LEN + '  RARE_ENTITY_NGRAM=' + prod.RARE_ENTITY_NGRAM);
  }
  console.log('  抽取自生产文件的常量：' + JSON.stringify(PROD.consts));

  // DF 上下文：仅当本次要评的候选里含 needsCtx 的（稀有实体通道）才去读语料 —— 默认运行零开销、零依赖。
  const wanted = o.candidates.length ? o.candidates : [];
  const list = wanted.includes('all') ? CANDIDATES.map((c) => c.name) : wanted;
  const needCtx = list.some((n) => { const c = CANDIDATES.find((x) => x.name === n); return c && c.needsCtx; });
  let ctxFor = null;
  if (needCtx) {
    const built = makeCtxFor(prod, o, golden);
    ctxFor = built.ctxFor;
    console.log('  DF 上下文（--df-mode ' + built.meta.mode + '，语料 ' + built.meta.corpusItems + ' 条去重标题）：');
    for (const f of built.meta.files) console.log('    ' + f);
    console.log('    注：inject 模式会再把「被比较的两条标题」并入语料 —— 还原线上「被判定条目必在本次快照内」的事实。');
  }
  console.log('');

  const prodM = metrics(cases, prod, ctxFor);
  printReport('当前生产规则（static-server.js 的 isSameEvent）', prodM);
  if (o.errors && prodM.errors.length) {
    console.log('  误判清单（' + prodM.errors.length + ' 条）：');
    for (const e of prodM.errors) {
      console.log('    [' + (e.pred ? 'FP 误合并' : 'FN 漏合并') + '] ratio=' + e.c.ratio
        + ' conf=' + e.c.confidence + ' ' + e.c.srcA + '《' + e.c.a + '》 <-> ' + e.c.srcB + '《' + e.c.b + '》');
    }
  }

  // 候选规则对比（同一基准集、同一抽样口径）
  if (wanted.length) {
    console.log('');
    console.log('=== 候选规则对比（相对生产规则的 P/R/F1 差异）===');
    for (const name of list) {
      const cand = CANDIDATES.find((c) => c.name === name);
      if (!cand) { console.log('  未知候选：' + name + '（可选：' + CANDIDATES.map((c) => c.name).join(' / ') + '）'); continue; }
      const m = metrics(cases, buildDecider({ thresholds: o.thresholds, candidate: cand }), ctxFor);
      console.log('');
      console.log('  [' + cand.name + ']（status=' + (cand.status || 'proposed') + '）' + cand.note);
      console.log('    dTP=' + (m.tp - prodM.tp) + ' dFP=' + (m.fp - prodM.fp)
        + ' dFN=' + (m.fn - prodM.fn) + ' dTN=' + (m.tn - prodM.tn));
      console.log('    P ' + f3(prodM.precision) + ' → ' + f3(m.precision) + ' (' + (m.precision - prodM.precision >= 0 ? '+' : '') + f3(m.precision - prodM.precision) + ')'
        + '   R ' + f3(prodM.recall) + ' → ' + f3(m.recall) + ' (' + (m.recall - prodM.recall >= 0 ? '+' : '') + f3(m.recall - prodM.recall) + ')');
      console.log('    F1 ' + f3(prodM.f1) + ' → ' + f3(m.f1) + ' (' + (m.f1 - prodM.f1 >= 0 ? '+' : '') + f3(m.f1 - prodM.f1) + ')'
        + '   accuracy ' + f3(prodM.accuracy) + ' → ' + f3(m.accuracy));
      const verdict = cand.status === 'adopted'
        ? (m.f1 === prodM.f1 && m.precision === prodM.precision
          ? '已并入生产：与生产规则完全一致（差异非 0 即说明生产接线被改动，需排查）'
          : '⚠️ 已并入生产，但评估出的行为与生产不一致 —— 生产接线或常量被改动过，必须排查')
        : (m.f1 > prodM.f1 && m.precision >= prodM.precision
          ? '采纳候选（F1 提升且 precision 未下降）'
          : (m.f1 > prodM.f1 ? '不采纳（F1 提升但 precision 下降）' : '不采纳（F1 无提升）'));
      console.log('    结论：' + verdict);
      if (o.errors) {
        const newly = m.errors.filter((e) => e.pred && prodM.errors.every((p) => p.c !== e.c || p.pred));
        const fixed = prodM.errors.filter((p) => m.errors.every((e) => e.c !== p.c));
        if (newly.length) {
          console.log('    新增误判（' + newly.length + ' 条）：');
          for (const e of newly) console.log('      [' + (e.pred ? 'FP' : 'FN') + '] ratio=' + e.c.ratio + ' ' + e.c.srcA + '《' + e.c.a + '》 <-> ' + e.c.srcB + '《' + e.c.b + '》');
        }
        if (fixed.length) {
          console.log('    修正误判（' + fixed.length + ' 条）：');
          for (const e of fixed) console.log('      [' + (e.pred ? 'FP' : 'FN') + '] ratio=' + e.c.ratio + ' ' + e.c.srcA + '《' + e.c.a + '》 <-> ' + e.c.srcB + '《' + e.c.b + '》');
        }
      }
    }
  }

  console.log('');
  const ok = prodM.f1 >= o.baseline;
  console.log('F1 基准线 ' + f3(o.baseline) + '，生产规则 F1 ' + f3(prodM.f1) + ' → ' + (ok ? 'PASS' : 'FAIL'));
  if (!ok) {
    console.log('（生产规则 F1 低于基准线：请核对是阈值被改坏，还是基准集/基准线需要显式更新并说明理由）');
  }
  return ok ? 0 : 1;
}

process.exitCode = main();
