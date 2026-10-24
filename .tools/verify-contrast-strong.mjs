#!/usr/bin/env node
/**
 * verify-contrast-strong.mjs —— 对比度定点修复的静态门禁。
 *
 * 背景（2026-10-24 视觉巡检基线）：11 页全 FAIL，四类硬伤
 *   ① tabBar 未选中 #999(2.85) / 选中 #FF7A45(2.59)
 *   ② 品牌色文字 on 白底 2.59（briefing/library/calendar/ledger/shopping/sxm）
 *   ③ 白字 on 品牌钮 2.59；白字 on 金钮 #F7BA1E 1.75
 *   ④ 禁用灰 $color-text-disabled(#c9cdd4,1.59) 被误用于**非禁用**正文（全仓 20+ 处）
 *
 * 解法分两路，互不混淆：
 *   A. 新增 `--brand-strong` / `$color-primary-strong` / `$color-secondary-strong`
 *      同色系加深变体，只用于「品牌色文字」与「白字品牌控件」；大场面背景仍用原色。
 *   B. 禁用灰逐点改 $color-text-tertiary(#657080,5.02) —— theme.scss 注释明确
 *      「禁用态有意豁免对比度」，所以**不动变量本身**，只改误用点。
 *
 * 断言口径（务必收窄，别写成符号级）：
 *   · 「文件里出现 $color-primary」会同时命中合法用法（渐变/背景），是假绿判据；
 *   · 一律框到 **具体类名的那一段**，并用 `ok(...) === true` 严格判（不返回原因串）。
 *
 * 用法: node .tools/verify-contrast-strong.mjs
 * 退出码: 0 = 全绿；1 = 有断言失败
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
let pass = 0;
let fail = 0;

function ok(name, cond) {
  if (cond === true) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`);
  }
  return cond === true;
}

/** 读文件，找不到直接炸（静默返回空串会让断言全绿，是最危险的假绿） */
function read(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) throw new Error(`文件不存在: ${rel}`);
  return fs.readFileSync(p, 'utf8');
}

/**
 * 取「某个类名选择器的那一段」：从 `.className {` 起到与之匹配的 `}`。
 *
 * ⚠️ 两个必须处理的现实：
 *  1) 锚点是**行首的 `.className`** 且右侧只能是空白 + `{`。否则 `.tab` 会抢先
 *     匹配到 `.tabActive`（前缀包含），抓到错误的块 —— 符号级判据的典型假红。
 *  2) 同一类名可能出现多次（组合选择器 `.tab,\n.tabActive {` + 单独规则
 *     `.tabActive {`）。只取第一段会漏掉后面真正改了颜色的那段。
 *     故返回**所有**匹配块，由断言侧判断「任一段满足」。
 * 3) 类名允许行首空白（缩进嵌套规则，如 calendar 的 `.dim { .cellDay { } }`）——
 *    2026-10-24 前不支持缩进，导致 `.dim .cellDay` 的禁用灰误用一直抓不到，
 *    运行时巡检报硬伤才发现。缩进只允许空白字符，`&.cellDay` 仍不匹配
 *    （那种是状态复合，语义不同）。
 */
function blocksOf(src, className) {
  const re = new RegExp(`(^|\\n)[ \\t]*\\.${className}\\s*\\{`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    out.push(src.slice(start, i - 1));
    re.lastIndex = i;
  }
  return out;
}

/** 剥掉 scss 注释。比「某字符串是否出现」的断言**必须先剥注释**：
 *  解释性注释里往往照抄了被禁掉的那个值（例："原来是 rgba(255,255,255,0.14) 的白膜"），
 *  不剥就会自己命中自己 —— 2026-10-24 J9 就是这么被自己的说明误杀成红的。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** 单块版：只在该类只出现一次时用（出现多次会抛，防止断言 silently 看漏） */
function blockOf(src, className) {
  const blocks = blocksOf(src, className);
  if (blocks.length > 1) {
    throw new Error(`.${className} 在文件中出现 ${blocks.length} 段，请改用 blocksOf（单块判据会漏）`);
  }
  return blocks[0] ?? null;
}

console.log('对比度定点修复门禁 (verify:contrast)');
console.log('──────────────────────────────────────────────────────────');

// ============ A. strong 变体已定义且注入 ============
try {
  const theme = read('src/store/theme.ts');
  const presets = theme.slice(theme.indexOf('THEME_PRESETS'), theme.indexOf('];', theme.indexOf('THEME_PRESETS')));

  ok('A1 theme.ts 四个预设都带 strong 字段（4/4）', (presets.match(/strong:/g) || []).length === 4);
  ok('A2 strong 取值是加深变体而非原色', presets.includes("strong: '#C7371A'") && presets.includes("strong: '#3560B8'"));
  ok('A3 brandVars 注入 --brand-strong', /--brand-strong['"]?\s*:\s*theme\.strong/.test(theme));

  const scss = read('src/styles/theme.scss');
  ok('A4 theme.scss 定义 $color-primary-strong', /\$color-primary-strong\s*:\s*#c7371a/i.test(scss));
  ok('A5 theme.scss 定义 $color-secondary-strong', /\$color-secondary-strong\s*:\s*#3560b8/i.test(scss));
  // $color-text-disabled 必须保持原值：theme.scss 注释明确禁用态有意豁免对比度，
  // 改它会削弱「禁用」的视觉语义。修法是逐点改误用处，不是改变量。
  ok('A6 $color-text-disabled 保持 #c9cdd4（禁用态豁免是有意设计，不许顺手改变量）', /\$color-text-disabled\s*:\s*#c9cdd4/i.test(scss));
} catch (e) {
  ok('A 组读取失败: ' + e.message, false);
}

// ============ B. tabBar 配置色加深 ============
try {
  const cfg = read('src/app.config.ts');
  const tab = cfg.slice(cfg.indexOf('tabBar:'));
  ok('B1 tabBar 未选中色 #657080（原 #999999 仅 2.85:1）', tab.includes("color: '#657080'"));
  ok('B2 tabBar 选中色 #C7371A（原 #FF7A45 仅 2.59:1）', tab.includes("selectedColor: '#C7371A'"));
} catch (e) {
  ok('B 组读取失败: ' + e.message, false);
}

// ============ C. 品牌色文字 / 白字控件改 strong ============
// 每条形如：文件 → 类名 → 期望在该类块内出现的字符串。
// ⚠️ 期望串分两种，别混：
//   · `--brand-strong` —— 走 CSS 变量（页面注入了 brandVars，随主题切换）
//   · `$color-primary-strong` / `$color-secondary-strong` —— SCSS 变量（写死加深色，
//     用于该文件本来就用 SCSS 色而非 var(--brand) 的地方）
// 判「走变量还是写死」要看该行**原来**用的是什么，不能一律要求 --brand-strong。
const STRONG_POINTS = [
  ['src/pages/briefing/index.module.scss', 'locateBtn', '$color-primary-strong'],
  ['src/pages/briefing/index.module.scss', 'intelNoteCta', '$color-primary-strong'],
  ['src/pages/briefing/index.module.scss', 'sendButton', '--brand-strong'],
  ['src/pages/briefing/index.module.scss', 'intelNoteText', 'color-text-tertiary'],
  ['src/pages/briefing/index.module.scss', 'intelLeadTag', 'color-text-tertiary'],
  ['src/pages/briefing/index.module.scss', 'aiGeneratedTag', 'color-text-tertiary'],
  ['src/pages/briefing/index.module.scss', 'chatHint', 'color-text-tertiary'],
  ['src/pages/library/index.module.scss', 'aiEditBtn', '--brand-strong'],
  ['src/pages/library/index.module.scss', 'aiGoBtn', '--brand-strong'],
  ['src/pages/library/index.module.scss', 'aiSaveBtn', '--brand-strong'],
  ['src/pages/library/index.module.scss', 'newsSource', 'color-secondary-strong'],
  ['src/pages/library/index.module.scss', 'feedbackActive', '--brand-strong'],
  ['src/pages/library/index.module.scss', 'whyToggle', '--brand-strong'],
  ['src/pages/calendar/index.module.scss', 'qaBtn', '--brand-strong'],
  ['src/pages/calendar/index.module.scss', 'syncButton', '--brand-strong'],
  ['src/pages/mine/index.module.scss', 'subButton', '--brand-strong'],
  ['src/pages/mine/index.module.scss', 'linkText', '--brand-strong'],
  ['src/pages/ledger/index.module.scss', 'catExport', '--brand-strong'],
  ['src/pages/ledger/index.module.scss', 'addBtn', '--brand-strong'],
  ['src/pages/shopping/index.module.scss', 'addBtn', '--brand-strong'],
  ['src/pages/shopping/index.module.scss', 'actionBtn', '--brand-strong'],
  ['src/pages/shopping/index.module.scss', 'cheapest', '--brand-strong'],
  ['src/pages/sxm/index.module.scss', 'tabActive', '--brand-strong'],
  ['src/pages/sxm/index.module.scss', 'verdictPick', 'color-secondary-strong'],
  ['src/pages/inbox/index.module.scss', 'addButton', '--brand-strong'],
  ['src/pages/learn/index.module.scss', 'makeupBtn', '--brand-strong'],
  ['src/pages/learn/index.module.scss', 'statNumOn', '--brand-strong'],
  ['src/pages/learn/index.module.scss', 'doneBadge', '--brand-strong'],
  // 2026-10-24 运行时巡检逮到的三处漏网（首轮静态扫描没覆盖组件目录与 chip 激活态）
  ['src/components/IntelGroupCard/index.module.scss', 'itemIndex', '$color-primary-strong'],
  ['src/components/TagChip/index.module.scss', 'active', '$color-primary-strong'],
  ['src/components/PartnerEntry/index.module.scss', 'action', '--brand-strong']
];
console.log('\nC 组 品牌色文字/白字控件 → strong（逐类名定位）');
for (const [file, cls, expect] of STRONG_POINTS) {
  try {
    const src = read(file);
    // 用 blocksOf：同一类名可能有多段（组合选择器 + 单独规则），任一段含期望串即算过
    const blocks = blocksOf(src, cls);
    const hit = blocks.some((b) => b.includes(expect));
    ok(`C ${cls} (${file.split('/').slice(-2)[0]}) 含 ${expect}`, blocks.length > 0 && hit);
  } catch (e) {
    ok(`C ${cls} 读取失败: ${e.message}`, false);
  }
}

// ============ D. 禁用灰误用点已改 tertiary ============
const TERTIARY_POINTS = [
  ['src/pages/library/index.module.scss', 'sectionBarHint'],
  ['src/pages/library/index.module.scss', 'dataMetaText'],
  ['src/pages/library/index.module.scss', 'aiHeadHint'],
  ['src/pages/library/index.module.scss', 'newsTime'],
  ['src/pages/library/index.module.scss', 'aiLabel'],
  ['src/pages/library/index.module.scss', 'time'],
  ['src/pages/library/index.module.scss', 'disclaimerText'],
  ['src/pages/library/index.module.scss', 'blockEmpty'],
  ['src/pages/calendar/index.module.scss', 'weekDay'],
  ['src/pages/calendar/index.module.scss', 'statsTitle'],
  // 2026-10-24：其他月日期是信息性占位而非失效控件，豁免口径修正——
  // 运行时巡检实测 1.59:1 报硬伤。blocksOf 已支持缩进嵌套才能抓到它。
  ['src/pages/calendar/index.module.scss', 'cellDay'],
  ['src/pages/calendar/index.module.scss', 'todoDue'],
  ['src/pages/mine/index.module.scss', 'cardTitle'],
  ['src/pages/mine/index.module.scss', 'subSectionTitle'],
  ['src/pages/mine/index.module.scss', 'entryArrow'],
  ['src/pages/mine/index.module.scss', 'valueHint'],
  ['src/pages/mine/index.module.scss', 'arrow'],
  ['src/pages/mine/index.module.scss', 'platformHint'],
  ['src/pages/mine/index.module.scss', 'dndSep'],
  ['src/pages/learn/index.module.scss', 'recHint'],
  ['src/pages/learn/index.module.scss', 'courseArrow'],
  ['src/pages/shopping/index.module.scss', 'hint'],
  ['src/pages/shopping/index.module.scss', 'adDividerText']
];
console.log('\nD 组 禁用灰误用 → tertiary（逐类名定位，且必须不再用 disabled）');
for (const [file, cls] of TERTIARY_POINTS) {
  try {
    const src = read(file);
    const blocks = blocksOf(src, cls);
    // 该类的**所有**段都不能再用 disabled，且至少一段用了 tertiary
    const noDisabled = blocks.every((b) => !b.includes('$color-text-disabled'));
    const hasTertiary = blocks.some((b) => b.includes('$color-text-tertiary'));
    ok(`D ${cls} (${file.split('/').slice(-2)[0]}) 改 tertiary 且不再用 disabled`, blocks.length > 0 && noDisabled && hasTertiary);
  } catch (e) {
    ok(`D ${cls} 读取失败: ${e.message}`, false);
  }
}

// ============ E. 金色按钮改深字（白字无解） ============
try {
  const src = read('src/pages/briefing/index.module.scss');
  const blk = blockOf(src, 'tipAction');
  ok('E1 briefing tipAction 金底改深色字（白字 on #F7BA1E 仅 1.75:1，无解）', blk !== null && blk.includes('$color-text-primary'));
} catch (e) {
  ok('E 组读取失败: ' + e.message, false);
}

// ============ F. learn 三语种 accent 加深（数据源） ============
try {
  const src = read('src/data/learn.ts');
  ok('F1 en accent #2F6DB5（原 #4A90D9 仅 3.15:1）', src.includes("accent: '#2F6DB5'"));
  ok('F2 ja accent #C7394A（原 #E8636F 仅 3.4:1）', src.includes("accent: '#C7394A'"));
  ok('F3 ko accent #5B4FC4（原 #7C6FE0 仅 4.2:1）', src.includes("accent: '#5B4FC4'"));
} catch (e) {
  ok('F 组读取失败: ' + e.message, false);
}

// ============ G. 三页补 brandVars（消除回退蓝与主题橙不一致） ============
console.log('\nG 组 三页根节点注入 brandVars');
for (const [file, marker] of [
  ['src/pages/library/index.tsx', 'styles.page} style={brandVars(theme)}'],
  ['src/pages/inbox/index.tsx', 'styles.page} style={brandVars(theme)}'],
  ['src/pages/learn/index.tsx', 'styles.page} style={brandVars(theme)}']
]) {
  try {
    ok(`G ${file.split('/').slice(-2)[0]} 根 View 注入 brandVars`, read(file).includes(marker));
  } catch (e) {
    ok(`G ${file} 读取失败`, false);
  }
}

// ============ H. FAB 浮层收缩 + 滚动收起 ============
try {
  const ai = read('src/components/AiAssistant/index.module.scss');
  // blocksOf：.wrapper 有两段（基础规则 + @media (min-width:500px) 里的宽屏适配），
  // blockOf 单块版会抛「出现 2 段」——2026-10-24 blocksOf 支持缩进嵌套后抓到第二段。
  const wBlks = blocksOf(ai, 'wrapper');
  ok('H1 AiAssistant wrapper 收缩为 width:max-content（原 left:0;right:0 全宽 → 幻影遮挡）',
    wBlks.some((b) => b.includes('width: max-content')));
  ok('H2 wrapper 有收起过渡（transform/opacity 200ms）',
    wBlks.some((b) => b.includes('transition: transform 200ms')));
  ok('H3 尊重 prefers-reduced-motion（动效可关，20 款 App 共同结论）',
    ai.includes('prefers-reduced-motion'));

  const tsx = read('src/components/AiAssistant/index.tsx');
  ok('H4 滚动监听挂在真实滚动容器 .taro_page（挂 window 收不到 Taro 内部滚动）',
    tsx.includes("document.querySelector('.taro_page')"));
  ok('H5 下滑阈值 8px 且 48px 内视为顶部常驻', /dy > 8/.test(tsx) && /y <= 48/.test(tsx));
  ok('H6 面板打开时强制显示（对话中收起会让用户以为 AI 消失）',
    /fabHidden && !open/.test(tsx));
  // H7-H9：底部内容右避让。球固定在右下角，全宽底部元素会被它的盒子压住
  // （2026-10-24 巡检实测：免责声明 11-13% / 隐私卡 7% / 社区入口 8%）。
  // 避让量 160rpx = 球 ≈108rpx + right:24rpx + 余量。
  ok('H7 briefing disclaimerFooter 右避让 160rpx（巡检实测被球压 11-13%）',
    (blockOf(read('src/pages/briefing/index.module.scss'), 'disclaimerFooter') || '').includes('160rpx'));
  ok('H8 mine privacyCard 右避让 160rpx（巡检实测被球压 7%）',
    (blockOf(read('src/pages/mine/index.module.scss'), 'privacyCard') || '').includes('margin-right: 160rpx'));
  ok('H9 learn communityEntry 右避让 160rpx（巡检实测被球压 8%）',
    (blockOf(read('src/pages/learn/index.module.scss'), 'communityEntry') || '').includes('160rpx'));
} catch (e) {
  ok('H 组读取失败: ' + e.message, false);
}

// ============ J. 日志级别：信息不进 error 通道，故障必须留痕 ============
try {
  const bp = read('src/pages/briefing/index.tsx');
  // 2026-10-24：ledger brief 两条日志原先级别写反——成功路径用 error（污染
  // consoleErrors，巡检报假阳性），失败路径用 warn（生产构建剔除、线上零痕迹）。
  ok('J1 ledger brief 成功统计用 console.info（调试信息不进 error 通道）',
    /console\.info\(\s*'\[BriefingPage\] ledger brief loaded:'/.test(bp));
  ok('J2 ledger brief 失败留痕用 console.error（warn 会被生产构建剔除，铁律）',
    /console\.error\('\[BriefingPage\] ledger brief load failed:'/.test(bp));
} catch (e) {
  ok('J 组读取失败: ' + e.message, false);
}

// ============ I. mine 订单失败态不再伪装成空态 ============
try {
  const src = read('src/pages/mine/index.tsx');
  // I1 收窄到两条失败路径分别置位。原判据 /setOrdersError\(true\)/ 是符号级——
  // 2026-10-24 变异验证实测漏报：把 ok:false 分支的置位改掉、只留 catch 分支，
  // 门禁仍全绿。服务端明确拒绝（ok:false）与网络异常（catch）是两条独立失败路径，
  // 少任何一条，「已付费用户查不到订单」都会重新伪装成「暂无支付记录」。
  // [^{}]* 保证不跨出 else 块边界——用 [\s\S]{0,300}? 会 backtrack 到 catch 里的
  // 置位，等于没查（第一版就这么漏的）。
  ok('I1a ok:false 拒绝分支置 ordersError（服务端明确失败 ≠ 空态）',
    /Array\.isArray\(r\.result\.orders\)[\s\S]{0,300}?else\s*\{[^{}]*setOrdersError\(true\)/.test(src));
  ok('I1b catch 异常分支置 ordersError（网络抖动 ≠ 空态）',
    /loadOrders failed[\s\S]{0,120}?setOrdersError\(true\)/.test(src));
  ok('I2 渲染分支区分 ordersError 与 orders.length===0', /ordersError && orders\.length === 0/.test(src));
  const lang = read('src/store/language.ts');
  ok('I3 中英文都有 ordersError 与 common.retry 键',
    (lang.match(/'mine\.ordersError':/g) || []).length === 2 && (lang.match(/'common\.retry':/g) || []).length === 2);
} catch (e) {
  ok('I 组读取失败: ' + e.message, false);
}

// ============ K. 情报条目卡片化（2026-10-24 对标 weapp-benchmark P1-2） ============
// 网易新闻精选形态：卡片单条（醒目标题 + 配图 + 见解）。三条断言各守一个不变量：
// 浅灰面（不能白面白底看不见）、来源 chip 的白底+tertiary（5.02:1）、
// 正文保持 secondary（不抢导语层级，medium 字重提供醒目）。
try {
  const scss = read('src/components/IntelGroupCard/index.module.scss');
  const itemBlocks = blocksOf(scss, 'item');
  ok('K1 情报条目浅灰面 $color-bg-page（嵌套白卡内的卡片层次，白面会看不见）',
    itemBlocks.length > 0 && itemBlocks.some((b) => b.includes('$color-bg-page')));
  const srcBlocks = blocksOf(scss, 'itemSource');
  ok('K2 来源 chip 白底 $color-bg-card + tertiary 字（#657080 on #fff = 5.02:1）',
    srcBlocks.length > 0 && srcBlocks.some((b) => b.includes('$color-text-tertiary') && b.includes('$color-bg-card')));
  const textBlocks = blocksOf(scss, 'itemText');
  ok('K3 条目正文保持 secondary 色 + medium 字重（醒目但不抢导语层级）',
    textBlocks.length > 0 && textBlocks.some((b) => b.includes('$color-text-secondary') && b.includes('$font-weight-medium')));
  const shareBlocks = blocksOf(scss, 'shareBtn');
  ok('K4 分享按钮热区 min-height: 88rpx（≥44px，修遗留「热区 32/44px」；原 library 分享按钮行高约 20px 点不中）',
    shareBlocks.length > 0 && shareBlocks.some((b) => b.includes('min-height: 88rpx')));
} catch (e) {
  ok('K 组读取失败: ' + e.message, false);
}

// ============ J. 运行时巡检实测的「白字压在浅橙上」（2026-10-24 补） ============
// 这几处此前**都不在本清单里** —— 静态清单是按类名逐条加的，漏一条就等于没有保护。
// 数值来自 cdp-probe 真页面实测（先关开屏/同意遮罩再量）：
//   · --brand(#FF7A45) 上白字 2.59；--brand-strong(#C7371A) 上白字 5.26
//   · $color-sub-gradient(#ff9a76→#ff7a45) 上白字 2.07 / 2.59
console.log('\nJ 组 巡检实测白字过淡 → 品牌深色');
const J_POINTS = [
  ['src/components/ConsentGate/index.module.scss', 'consentAgree', '--brand-strong', '首启同意按钮（每个新用户第一个按钮）'],
  ['src/pages/learnCommunity/index.module.scss', 'postButton', 'color-primary-strong', '社区发布'],
  ['src/pages/inbox/index.module.scss', 'extractButton', '--brand-strong', 'AI 提取'],
  ['src/pages/mine/index.module.scss', 'subCard', '--brand-strong', '付费卡底（卡内 14 处文字）']
];
for (const [file, cls, expect, why] of J_POINTS) {
  try {
    const blocks = blocksOf(read(file), cls);
    ok(`J ${cls} 用 ${expect}（${why}）`, blocks.length > 0 && blocks.some((b) => b.includes(expect)));
  } catch (e) {
    ok(`J ${cls} 读取失败: ${e.message}`, false);
  }
}
// J5 付费卡内文字不得再用 75% 白：深橙底上只有 3.58:1，小字号过不了 AA
try {
  const mineScss = read('src/pages/mine/index.module.scss');
  const FADED = ['subTitle', 'subDesc', 'subscribedUntil', 'planLabel', 'planPrice', 'planUnit', 'lockTitle', 'lockBody', 'lockLose'];
  const bad = FADED.filter((cls) => {
    const blocks = blocksOf(mineScss, cls);
    return blocks.some((b) => /rgba\(255, 255, 255, 0\.75\)/.test(b));
  });
  ok(`J5 付费卡 9 个文字类均不用 75% 白（违规：${bad.join(',') || '无'}）`, bad.length === 0);
  // J6 金色不能承载正文：$color-gold(#f7ba1e) 在深橙底 2.22、浅橙底 1.09，任何主题都过不了
  const lockBlocks = blocksOf(mineScss, 'lockTitle');
  ok('J6 lockTitle 不再用 $color-gold（任何橙底都 <4.5）',
    lockBlocks.length > 0 && lockBlocks.every((b) => !b.includes('$color-gold')));
} catch (e) {
  ok('J5/J6 读取失败: ' + e.message, false);
}
// J7 「真禁用」必须有自己的 [disabled] 规则：disabledAttr() 只治「假 disabled」，
// 真禁用时 WeUI 会把字染成 rgba(255,255,255,.6)，浅底上等于按钮消失。
try {
  const clearBlocks = blocksOf(read('src/pages/history/index.module.scss'), 'clearButton');
  ok('J7 history .clearButton 自带 [disabled] 规则（防回退）',
    clearBlocks.length > 0 && clearBlocks.some((b) => b.includes('[disabled]')));
  const mineScss2 = read('src/pages/mine/index.module.scss');
  const subBtn = blocksOf(mineScss2, 'subButton');
  ok('J8 mine .subButton 自带 [disabled] 规则（同上）',
    subBtn.length > 0 && subBtn.some((b) => b.includes('[disabled]')));
} catch (e) {
  ok('J7/J8 读取失败: ' + e.message, false);
}

// ============ J9 – J15. 第二轮巡检（修正「渐变当白底」口径后仍不合格的项） ============
// 这批的成因与 J1–J8 不同，不是「白字压在浅橙按钮上」，而是三类：
//   ① 半透明白膜把深底提亮（.planCard / .planCardActive）；
//   ② 把 `$color-text-disabled`(#c9cdd4) 当**内容**色用（成就进度、动态时间戳）；
//   ③ 旧品牌深色 `--brand-deep`(#e85d2a) 当正文色（3.07–3.20:1）。
// 数值全部来自 .tmp-verify/run-sweep.mjs 真页面实测（先点掉开屏 + 同意遮罩再量）。
try {
  const mineScss3 = stripComments(read('src/pages/mine/index.module.scss'));
  const pc = blocksOf(mineScss3, 'planCard');
  const pca = blocksOf(mineScss3, 'planCardActive');
  ok('J9 mine .planCard 不再用白色蒙版（白膜把 brand-strong 提亮 → 白字 3.83:1）',
    pc.length > 0 && pc.every((b) => !/rgba\(255,\s*255,\s*255/.test(b)));
  ok('J9b mine .planCardActive 也不提亮（选中态由白边框 + 阴影表达）',
    pca.length > 0 && pca.every((b) => !/rgba\(255,\s*255,\s*255/.test(b)));
  const planText = [...blocksOf(mineScss3, 'planLabel'), ...blocksOf(mineScss3, 'planUnit')];
  ok('J10 mine .planLabel/.planUnit 用纯白（92%/90% 白没有余量）',
    planText.length >= 2 && planText.every((b) => b.includes('$color-text-white') && !/rgba\(255,\s*255,\s*255/.test(b)));
} catch (e) {
  ok('J9/J10 读取失败: ' + e.message, false);
}

try {
  const lc = read('src/pages/learnCommunity/index.module.scss');
  const meta = [...blocksOf(lc, 'badgeDesc'), ...blocksOf(lc, 'postTime')];
  ok('J11 learnCommunity 成就进度/动态时间不误用禁用灰（#c9cdd4 白底 1.5:1）',
    meta.length >= 2 && meta.every((b) => !b.includes('$color-text-disabled')));
  const headSub = blocksOf(lc, 'headSub');
  ok('J11b learnCommunity .headSub 不用 88% 白（实测 4.49:1，差 0.01 落榜）',
    headSub.length > 0 && headSub.every((b) => !/rgba\(255,\s*255,\s*255,\s*0\.88\)/.test(b)));
} catch (e) {
  ok('J11 读取失败: ' + e.message, false);
}

try {
  const sq = read('src/pages/search/index.module.scss');
  const st = blocksOf(sq, 'scopeTabTextActive');
  ok('J12 search .scopeTabTextActive 用 --brand-strong（原 --brand-deep 3.20:1）',
    st.length > 0 && st.some((b) => b.includes('--brand-strong')) && st.every((b) => !b.includes('var(--brand-deep')));
} catch (e) {
  ok('J12 读取失败: ' + e.message, false);
}

try {
  const cal = read('src/pages/calendar/index.module.scss');
  // 去掉注释再比顺序：注释里也写着 `.today`/`.selected`，直接 indexOf 会被自己的解释误杀
  const calCode = cal.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const today = blocksOf(cal, 'today');
  const sel = blocksOf(cal, 'selected');
  ok('J13 calendar .today .cellDay 底色用 --brand-strong（原 --brand 渐变最亮档白字 2.59）',
    today.length > 0 && today.some((b) => b.includes('--brand-strong') && !/var\(--brand,/.test(b)));
  ok('J14 calendar .today 规则排在 .selected 之后（今天恰被选中时白字必须赢，原 1.35:1）',
    calCode.indexOf('.today {') > -1 &&
      calCode.indexOf('.selected {') > -1 &&
      calCode.indexOf('.today {') > calCode.indexOf('.selected {'));
  ok('J14b calendar .selected .cellDay 不用 --brand-deep（#e85d2a 浅底 3.07:1）',
    sel.length > 0 && sel.every((b) => !b.includes('var(--brand-deep')));
} catch (e) {
  ok('J13/J14 读取失败: ' + e.message, false);
}

try {
  const learnScss = read('src/pages/learn/index.module.scss');
  const freeze = blocksOf(learnScss, 'freezeText');
  ok('J15 learn .freezeText 用 #0b57c9（#1266e0 在浅蓝冻结卡上实测 4.36:1）',
    freeze.length > 0 && freeze.some((b) => /#0b57c9/i.test(b)));
} catch (e) {
  ok('J15 读取失败: ' + e.message, false);
}

console.log('──────────────────────────────────────────────────────────');
console.log(`PASS ${pass} / FAIL ${fail}（共 ${pass + fail} 条断言）`);
process.exit(fail > 0 ? 1 : 0);
