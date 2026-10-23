#!/usr/bin/env node
/**
 * verify-briefing-structure.js —— 晨报页「首屏结构 / 状态机 / 细节」静态断言。
 *
 * 为什么用源码断言而不是渲染测试：
 *   本仓没有测试框架，这批验收点全是**结构性**的（某块 JSX 挂在哪个父节点下、
 *   三/四态渲染的先后顺序、catch 分支把失败导到哪个 UI 态、i18n key 是否中英齐全）。
 *   源码断言既能精确捕捉回归，又能在变异验证里给出明确的 FAIL 集合。
 *
 * 这一批守的是 2026-10-24 审计发现并修掉的 6 个缺陷，全部来自「手感」层面：
 *   1. 记账卡被误粘进 headerActions（右上角图标按钮那一行，flex + flex-shrink:0）内部
 *      → 卡片按内容宽度撑开，把问候语列压到 0 宽、整页横向溢出；
 *   2. hasContent 只看日程/待办/收藏，不看情报 → 「今天没安排但有情报」的用户情报整块消失；
 *   3. 首帧 briefing=null 且骨架未武装 → 先闪一下「今天还没有安排」再出内容；
 *   4. 加载失败只 toast，页面落进「真空态」→ 断网时被告知今天没安排，且没有任何重试入口；
 *   5. doneIds 从不读 todo.status → 勾完的待办重进就复位，语音播报还会念出来；
 *   6. 「共 N 项已守护」用 navigateTo 跳 tabBar 页 → weapp 直接失败，点了没反应。
 *
 * ⚠️ 断言铁律：cond 必须是 boolean，非 boolean 直接抛错。
 *   历史事故：失败分支返回「说明原因的字符串」，非空字符串是 truthy → 失败被判 PASS，永久假绿。
 *
 * 用法：node .tools/verify-briefing-structure.js
 * 退出码：0 = 全 PASS
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let pass = 0;
const failures = [];

function assert(name, cond) {
  if (typeof cond !== 'boolean') {
    throw new TypeError(`断言 ${name} 的 cond 必须是 boolean，实际是 ${typeof cond}（禁止用字符串当条件）`);
  }
  if (cond === true) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}`);
  }
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const count = (src, s) => src.split(s).length - 1;

const PAGE = read('src/pages/briefing/index.tsx');
const LANG = read('src/store/language.ts');

/* ============================================================
 * 一、记账卡的位置：必须在 header 之外，且不在 headerActions 里
 * ============================================================ */
// headerActions 的**真实闭合位置**是它开标签之后的第一个 </View>：
// 内部只有两个自闭合结束的 <Button>，没有嵌套 <View>。（不能用「到横幅区为止」当窗口 ——
// 记账卡本来就该落在 header 与横幅之间，那种窗口会把合法位置也判成越界。）
const haOpen = PAGE.indexOf('<View className={styles.headerActions}>');
const haClose = haOpen >= 0 ? PAGE.indexOf('</View>', haOpen) : -1;
assert('找得到 headerActions 的开标签与闭合标签（断言自身没失锚）', haOpen > 0 && haClose > haOpen);

const headerWindow = haOpen >= 0 && haClose > haOpen ? PAGE.slice(haOpen, haClose) : '';
assert('headerActions 窗口内确实装着播报键与搜索键（窗口取对了）',
  headerWindow.includes('styles.audioButton') && headerWindow.includes('styles.searchButton'));
assert('记账卡不在 headerActions 里（否则卡片在 flex 行内被撑开、压垮问候语列）',
  headerWindow.includes('ledgerBrief') === false);

const ledgerIdx = PAGE.indexOf('ledgerBrief && ledgerBrief.count > 0');
const bannerIdx = PAGE.indexOf('hasContent && adaptiveBanner', haClose);
assert('记账卡渲染在 header 闭合之后（即 header 之外）', ledgerIdx > haClose && haClose > 0);
assert('记账卡仍在横幅区之前（信息优先级：当日概览排在提示条前）', ledgerIdx < bannerIdx && bannerIdx > 0);

/* ============================================================
 * 二、hasContent 必须把情报算进去
 * ============================================================ */
assert('hasContent 引入了 hasIntel', PAGE.includes('|| hasIntel'));
assert('hasIntel 统计情报条目', PAGE.includes('briefing.intel.intelItems.length > 0'));
assert('hasIntel 也统计天气（只有天气没有新闻时不该整块消失）', PAGE.includes('Boolean(briefing?.intel?.weather)'));

/* 情报区块自身的渲染门禁也要含 weather */
assert('情报区块门禁含 weather',
  PAGE.includes('(briefing.intel.intelItems && briefing.intel.intelItems.length > 0) || briefing.intel.weather'));
assert('平铺渲染对 intelItems 缺字段有兜底（只有天气时不崩）',
  PAGE.includes('(briefing.intel.intelItems ?? []).map('));

/* ============================================================
 * 三、四态渲染：首帧占位 → 骨架 → 失败 → 空态/内容
 * ============================================================ */
assert('首帧占位态存在（briefing 为空且骨架未武装时渲染 null，不落空态）',
  PAGE.includes('!briefing && !showSkeleton && !loadError ? null'));
assert('失败态在空态之前判定（否则断网会显示「今天还没有安排」）', (() => {
  const errIdx = PAGE.indexOf('loadError ? (');
  const emptyIdx = PAGE.indexOf(') : !hasContent ? (', errIdx);
  return errIdx > 0 && emptyIdx > errIdx;
})());

/* ============================================================
 * 四、加载失败：独立失败态 + 可重试
 * ============================================================ */
assert('存在 loadError 状态', PAGE.includes('const [loadError, setLoadError] = useState(false)'));
assert('只有手上没有旧数据时才进失败态（有缓存先展示缓存）',
  PAGE.includes('if (!briefingRef.current) setLoadError(true);'));
assert('成功路径会清掉失败态', PAGE.includes('setLoadError(false)'));
assert('失败态用的是「加载失败」文案而不是空态文案', PAGE.includes("title={t('briefing.loadFailedTitle')}"));
assert('失败态给了重试入口', PAGE.includes("onAction={() => loadBriefing(true)}"));

assert('失败态 i18n：中英各一份（loadFailedTitle）', count(LANG, "'briefing.loadFailedTitle'") === 2);
assert('失败态 i18n：中英各一份（loadFailedHint）', count(LANG, "'briefing.loadFailedHint'") === 2);
assert('失败态 i18n：中英各一份（retry）', count(LANG, "'briefing.retry'") === 2);

/* ============================================================
 * 五、doneIds 从服务端 todo.status 回填
 * ============================================================ */
assert('存在「回填 status」的 effect', PAGE.includes("(td) => td.status === 'done'"));
assert('回填结果写进 doneIds', PAGE.includes('setDoneIds(new Set(done))'));
assert('回填以 briefing 引用为触发（刷新即对齐服务端真值）', /useEffect\(\(\) => \{\s*if \(!briefing\) return;[\s\S]{0,400}?\}, \[briefing\]\)/.test(PAGE));

/* ============================================================
 * 六、「我的」是 tabBar 页，必须 switchTab
 * ============================================================ */
assert('app.config 里 pages/mine/index 确在 tabBar（前提仍成立）',
  /tabBar[\s\S]*?pagePath: 'pages\/mine\/index'/.test(read('src/app.config.ts')));
// 只看 HabitGuardBar 这一处：全文件别的 navigateTo('/pages/mine/index') 是 switchTab 的
// catch 兜底（handleGoSubscribe :666），那是合法写法，不能一并禁掉。
const hgIdx = PAGE.indexOf('<HabitGuardBar');
const hgBlock = hgIdx >= 0 ? PAGE.slice(hgIdx, PAGE.indexOf('/>', hgIdx)) : '';
assert('找得到 HabitGuardBar 的 JSX 块', hgBlock.includes('onView') && hgBlock.includes('onRestoreAll'));
assert('守护记录入口 onView 改用 switchTab', hgBlock.includes("switchTab({ url: '/pages/mine/index' })"));
// 判「调用」而不是判「这个词」：注释里解释这个 bug 时必然会写到 navigateTo 这个词，
// 用 includes('navigateTo') 会被自己的注释误杀（本轮踩到）。
assert('守护记录入口 onView 不再用 navigateTo', hgBlock.includes('Taro.navigateTo(') === false);

/* ============================================================
 * 汇总
 * ============================================================ */
console.log('');
if (failures.length > 0) {
  console.log(`FAILED ${failures.length} / ${pass + failures.length}`);
  failures.forEach((f) => console.log(`  · ${f}`));
  process.exit(1);
}
console.log(`PASS ${pass} / ${pass + failures.length} —— 晨报首屏结构与状态机断言全绿`);
