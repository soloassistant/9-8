#!/usr/bin/env node
/**
 * verify-batch1.js —— 第 ① 批（A 返回键 / B 订阅分叉 / C tab 新鲜窗口）静态断言。
 *
 * 为什么用「读源码 + 精确断言」而不是渲染测试：
 *   本仓没有测试框架，A/B/C 的验收点全是**结构性**的（控件是否存在、顺序是否正确、
 *   守卫是否包住定时器、i18n key 是否中英齐全）。这些点用源码断言既能精确捕捉回归，
 *   又能在变异验证里给出「精确 FAIL 集合」。
 *
 * ⚠️ 断言铁律（项目里踩过的坑）：cond **必须是 boolean**。
 *   历史事故：失败分支返回了「说明原因的字符串」，非空字符串是 truthy，于是失败被判成 PASS，
 *   整份测试永久假绿。本文件的 assert() 对非 boolean 直接抛错，从机制上堵死这条路。
 *
 * 用法：node .tools/verify-batch1.js
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
const has = (src, s) => src.includes(s);
const at = (src, s, from = 0) => src.indexOf(s, from);

/**
 * 从 startIdx 所在语句起按花括号配对取出**整块**（含最外层 `{}`）。
 *
 * 为什么需要它（2026-10-23）：本文件原来用「两个 indexOf 的先后顺序」代表「A 包住了 B」，
 * 但 `guardIdx < timerIdx` 只能说明守卫出现在定时器**之前**，守卫块早被 `}` 关掉了也照样成立 ——
 * 守卫被挪出块外（本项目 P0 就是这么回归的）时断言仍然 PASS，是典型的结构性假绿。
 * 结构断言必须落在「同一个块内」，而不是「同一份文件里」。
 */
function blockAt(src, startIdx) {
  if (startIdx < 0) return '';
  const open = src.indexOf('{', startIdx);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(startIdx, i + 1);
    }
  }
  return '';
}

/* =====================================================================
 * A. 四个二级页补返回键（history / learn / shopping / ledger）
 * ===================================================================== */
const PAGES = [
  {
    name: 'history',
    tsx: 'src/pages/history/index.tsx',
    scss: 'src/pages/history/index.module.scss',
    anchor: '<View className={styles.header}>'
  },
  {
    name: 'learn',
    tsx: 'src/pages/learn/index.tsx',
    scss: 'src/pages/learn/index.module.scss',
    anchor: '{/* 语种切换 */}'
  },
  {
    name: 'shopping',
    tsx: 'src/pages/shopping/index.tsx',
    scss: 'src/pages/shopping/index.module.scss',
    anchor: '<DemoDataHint />'
  },
  {
    name: 'ledger',
    tsx: 'src/pages/ledger/index.tsx',
    scss: 'src/pages/ledger/index.module.scss',
    anchor: '<View className={styles.head}>'
  }
];

for (const p of PAGES) {
  const tsx = read(p.tsx);
  const scss = read(p.scss);

  // A-1 返回逻辑：优先 navigateBack，栈底兜底 reLaunch 回晨报
  assert(
    `A/${p.name}/tsx/handleBack`,
    has(tsx, 'const handleBack = useCallback(() => {') &&
      has(tsx, 'Taro.navigateBack()') &&
      has(tsx, "Taro.reLaunch({ url: '/pages/briefing/index' })")
  );

  // A-2 控件本身：View + 可点 + 文案走已存在的 common.back（不新增 key）
  const backIdx = at(tsx, '<View className={styles.backButton} onClick={handleBack}>');
  assert(
    `A/${p.name}/tsx/jsx`,
    backIdx >= 0 &&
      has(tsx, '<Text className={styles.backIcon}>‹</Text>') &&
      has(tsx, "<Text className={styles.backText}>{t('common.back')}</Text>")
  );

  // A-3 必须是根容器的**第一个子元素**（排在 header / langBar / DemoDataHint 之前）
  assert(`A/${p.name}/tsx/firstChild`, backIdx >= 0 && at(tsx, p.anchor) > backIdx);

  // A-4 样式必须提到 scss 顶层（不能被嵌进 .searchBar 之类）
  assert(
    `A/${p.name}/scss/topLevel`,
    /^\.backButton\s*\{/m.test(scss) && /^\.backIcon\s*\{/m.test(scss) && /^\.backText\s*\{/m.test(scss)
  );

  const block = scss.match(/^\.backButton\s*\{([\s\S]*?)\n\}/m);
  const body = block ? block[1] : '';

  // A-5 高度必须用 $button-height-md（80rpx）——不允许 px（pxtransform 会把 px 当设计像素，点击区缩半）
  assert(`A/${p.name}/scss/heightToken`, has(body, 'min-height: $button-height-md;'));
  assert(`A/${p.name}/scss/noPx`, !/(?:min-)?height:\s*\d+(?:\.\d+)?px/.test(body));

  // A-6 flex 行
  assert(`A/${p.name}/scss/flex`, has(body, 'display: flex;'));
}

/* =====================================================================
 * B. 订阅区按 subscribed 分叉，堵住重复扣费
 * ===================================================================== */
const mine = read('src/pages/mine/index.tsx');
const channelIdx = at(mine, 'if (!channel) {');
const subscribedIdx = at(mine, 'if (profile?.subscribed) {');
const payingIdx = at(mine, 'setPaying(true);');

// B-1 二次确认存在，且文案/按钮齐全
//     ⚠️ 必须**落在 if (profile?.subscribed) 的块内**：原来只断言这几个 key 在整份文件里出现过，
//     弹窗被挪到别的函数/注释里也照样 PASS —— 那是「字符串存在」不是「续费前必经确认」。
const subscribedBlock = blockAt(mine, subscribedIdx);
assert(
  'B/tsx/confirmExists',
  subscribedBlock !== '' &&
    has(subscribedBlock, 'Taro.showModal({') &&
    has(subscribedBlock, "title: t('mine.renewTitle')") &&
    has(subscribedBlock, "content: t('mine.renewBody', { date: (profile.expiredAt || '').slice(0, 10) })") &&
    has(subscribedBlock, "confirmText: t('mine.renewConfirm')") &&
    has(subscribedBlock, "cancelText: t('cancel')")
);

// B-2 顺序铁律：channel 判空 → subscribed 确认 → setPaying(true)
//     放错到 channel 之前，H5 用户会先看到续费弹窗、再被告知「请在小程序打开」。
assert(
  'B/tsx/confirmOrder',
  channelIdx >= 0 && subscribedIdx > channelIdx && payingIdx > subscribedIdx
);

// B-3 确认结果必须真正阻断下单（取消 → return，不能继续往下扣费）
//     ⚠️ 三条字符串必须都在**同一个确认块**里，且阻断发生在 awaiting 之后、setPaying 之前。
//     原来只做全文件 includes：把 `if (!ok) return;` 挪到别的分支（或写进注释）仍然 PASS。
assert(
  'B/tsx/confirmBlocks',
  subscribedBlock !== '' &&
    has(subscribedBlock, 'success: (r) => resolve(!!r.confirm)') &&
    has(subscribedBlock, 'fail: () => resolve(false)') &&
    has(subscribedBlock, 'if (!ok) return;') &&
    at(subscribedBlock, 'if (!ok) return;') > at(subscribedBlock, 'Taro.showModal({') &&
    // 确认块整体必须在 setPaying(true) 之前闭合：否则「先下单、后确认」等于没拦
    subscribedIdx + subscribedBlock.length <= payingIdx
);

// B-4 按钮文案三分支：paying / 已订阅（续费）/ 未订阅
//     只在**按钮块内**断言，避免命中页面别处同名字符串而假绿。
const btnStart = at(mine, '<Button className={styles.subButton}');
const btnEnd = btnStart >= 0 ? at(mine, '</Button>', btnStart) : -1;
const btnBlock = btnStart >= 0 && btnEnd > btnStart ? mine.slice(btnStart, btnEnd) : '';
assert(
  'B/tsx/buttonText',
  has(btnBlock, "t('mine.subscribing')") &&
    has(btnBlock, "t('mine.renew')") &&
    has(btnBlock, "t('mine.subscribe')") &&
    // 嵌套三元：三选一，不是写死单分支。
    // ⚠️ 只数裸 `?` 会被可选链 `profile?.subscribed` 混进来（一个 `?.` 顶一个三元），
    //    这里只数「? 后面紧跟 t(」的真三元。
    (btnBlock.match(/\?\s*t\(/g) || []).length >= 2
);

// B-5 已订阅时补「订阅至 {date}」一行
assert(
  'B/tsx/untilRow',
  has(mine, '<Text className={styles.subscribedUntil}>') &&
    has(mine, "t('mine.subscribedUntil', { date: (profile.expiredAt || '').slice(0, 10) })")
);

// B-6 i18n：中英各 5 个 key 必须齐全（en 的类型是 Record<keyof typeof zh, string>）
const lang = read('src/store/language.ts');
const zhStart = at(lang, 'const zh = {');
const enStart = at(lang, 'const en: Record<keyof typeof zh, string> = {');
const zhSrc = lang.slice(zhStart, enStart);
const enSrc = lang.slice(enStart);
const B_KEYS = ['mine.renew', 'mine.renewTitle', 'mine.renewBody', 'mine.renewConfirm', 'mine.subscribedUntil'];
for (const k of B_KEYS) {
  assert(`B/i18n/zh/${k}`, has(zhSrc, `'${k}':`));
  assert(`B/i18n/en/${k}`, has(enSrc, `'${k}':`));
}

// B-7 样式
const mineScss = read('src/pages/mine/index.module.scss');
assert('B/scss/subscribedUntil', /^\.subscribedUntil\s*\{/m.test(mineScss));

/* =====================================================================
 * C. 切回 tab 闪骨架 / 无谓重拉（P0-2 修复引入的回归）
 * ===================================================================== */
const lib = read('src/pages/library/index.tsx');

// C-1 60s 新鲜窗口 + 在 useDidShow 里真正生效
assert(
  'C/library/freshWindow',
  has(lib, 'const LOAD_FRESH_MS = 60_000;') &&
    has(lib, 'if (Date.now() - lastLoadedAt.current < LOAD_FRESH_MS) return;')
);

// C-2 成功结束才记时间（失败不记 → 下次切回仍重试）
assert('C/library/lastLoadedAtWrite', has(lib, 'lastLoadedAt.current = Date.now();'));

// C-3 骨架屏只在「没有数据」时挂定时器；且必须用 ref（load 是 [] 依赖，读 items.length 会永远拿初值）
assert(
  'C/library/skeletonGuard',
  has(lib, 'const hasDataRef = useRef(false);') && has(lib, 'if (!hasDataRef.current) {')
);

// C-4 守卫必须真正包住 setTimeout（不是写在别处）
//     ⚠️ 只比 indexOf 先后是不够的：`guardIdx < timerIdx` 在「守卫块已闭合、定时器写在块外」
//     时依然成立 —— 这正是 2026-10 「切 tab 闪骨架」的回归形态。必须按花括号取出守卫块，
//     再断言 setTimeout 落在**块内**。
const guardIdx = at(lib, 'if (!hasDataRef.current) {');
const guardBlock = blockAt(lib, guardIdx);
assert(
  'C/library/skeletonGuardScope',
  guardIdx >= 0 && has(guardBlock, 'skeletonTimer.current = setTimeout')
);

// C-5 防旧响应覆盖三件套必须原样保留（改 C 不能破坏 P0-2 的核心修复）
const deltaCleanIdx = at(lib, 'if (seq === loadSeq.current) {');
assert(
  'C/library/seqGuardIntact',
  has(lib, 'const loadSeq = useRef(0);') &&
    has(lib, 'const aliveRef = useRef(true);') &&
    has(lib, 'const skeletonTimer = useRef') &&
    has(lib, 'if (!aliveRef.current || seq !== loadSeq.current) return;') &&
    deltaCleanIdx >= 0
);

const cal = read('src/pages/calendar/index.tsx');

// C-6 日历同样 60s 窗口
assert(
  'C/calendar/freshWindow',
  has(cal, 'const LOAD_FRESH_MS = 60_000;') &&
    has(cal, 'if (Date.now() - lastBriefingAt.current < LOAD_FRESH_MS) return;')
);

// C-7 成功才写时间戳（ref 声明 + 赋值都必须在）
assert(
  'C/calendar/lastBriefingAtWrite',
  has(cal, 'const lastBriefingAt = useRef(0);') && has(cal, 'lastBriefingAt.current = Date.now();')
);

/* ---------------- 汇总 ---------------- */
console.log(`\n通过 ${pass} / 失败 ${failures.length}`);
if (failures.length) {
  console.log('FAIL 集合：');
  for (const n of failures) console.log(`  - ${n}`);
}
process.exit(failures.length === 0 ? 0 : 1);
