#!/usr/bin/env node
/**
 * verify-h5-coverage.mjs —— 「H5 功能覆盖面」门禁（2026-10-30）
 *
 * 背景（本轮审计实测出来的三条，同源于「通路断在暗处，用户只看到结果不对」）：
 *
 *   ① **跨端同步漏键**：H5 的跨设备同步靠 `cloudSync.SYNC_KEYS` → 应用数据库 user_kv。
 *      全仓 55 个本地存储键里，有 **21 个用户数据键**（社区动态/成就/习惯/连续天数/
 *      屏蔽词/类目偏好/早鸟锁价…）写了本地却**没进 SYNC_KEYS** ⇒ 换设备/重装/清缓存
 *      ⇒ 这份数据**静默消失**（用户视角：功能像坏了，界面不提示任何东西）。
 *      本轮补进 16 个（其中 `mb_locked_price` 是**权益**：早鸟终身锁价，不派生自 orders 表
 *      ⇒ 不会自动恢复 ⇒ 不同步就是换设备丢权益）。
 *
 *   ② **降级诚实性**：`cloud.ts` 的 `REAL_LOCAL_ACTIONS` 列出「回退结果是**真实本地数据**」
 *      的 action —— 它们**不登记降级**，因为页级横幅写的是「当前为本地**演示数据**」，
 *      对真实数据说「演示数据」= 反向谎言。
 *      ⇒ 集合里的每个 action，其降级模块**必须真的读本地存储**；
 *      否则它展示的是编造内容却不被告知 ⇒ 用户被骗。
 *
 *   ③ **横幅不串台**：页级横幅靠 `DemoDataHint` 的 `actions` prop 限定页面。
 *      此前 `actions={[]}`（显式空数组）会被当成「没传」⇒ 显示**全部**降级 ⇒ 本页本该
 *      不显示，却把别的页面的横幅拉过来。
 *
 * 判据取向：锁**事实**（哪些键必须跨端 / 哪些 action 不许宣称演示），
 * 不锁实现位置 —— 但「豁免清单」是显式的：新增本地键时**必须**在
 * 「要跨端」或「设备级豁免」之间二选一，否则这里判红。
 *
 * 用法: node .tools/verify-h5-coverage.mjs
 * 退出码: 0 = 全绿；1 = 有断言失败；2 = harness 自身出错
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0;
let fail = 0;
const rows = [];
function assert(name, cond, detail = '') {
  if (typeof cond !== 'boolean') throw new Error(`断言「${name}」的 cond 不是 boolean：${typeof cond}`);
  rows.push({ name, ok: cond, detail });
  if (cond) pass++;
  else fail++;
}

/* ───────────────────────── A. 跨端同步覆盖 ───────────────────────── */

/** 应当**跨设备**的用户数据键（权威清单）。新增本地用户数据键时必须进这里或下面的豁免表。 */
const CROSS_DEVICE_KEYS = [
  'shoppingList', 'dailyPlanStore', 'browseHistory', 'newsFeedback', 'news-interests',
  'news-interests-custom', 'activity-log', 'learnStore', 'ai-memory', 'user-settings',
  'user-city', 'collectionStore', 'usage-voice', 'feature-usage', 'briefingChatLog',
  'aiAssistantLog', 'brand-theme', 'app-lang', 'ui-scale', 'user-avatar', 'ledgerEntries',
  'ledger-categories', 'ledgerBudget', 'watchlist', 'sportRuns', 'sport-goal-km',
  // 2026-10-30 补齐的 16 个
  'learnCommunityStore', 'learnAchievements', 'learnNickname', 'habitStore',
  'readStreakStore', 'mb-brief-streak', 'mb_news_blocklist', 'mb-cat-affinity',
  'mb-prefs', 'mb_personalization', 'ai_chat_usage', 'notify-log', 'mb_tts_voice',
  'mb_renew_remind', 'mb_renew_remind_day', 'mb_locked_price'
];

/** **不该**上云的键：合规同意 / 设备级引导 / 实验分流 / 缓存 / 派生值。逐个都有理由。 */
const DEVICE_ONLY_KEYS = {
  'privacy-consent': '合规同意（设备级）',
  'sxm-privacy-consent': '合规同意（设备级）',
  'location-cross-border-consent': '出境定位同意（合规，设备级）',
  'onboarded-v2': '新手引导状态（设备级）',
  'burst-banner-dismissed': '弹窗关闭状态（设备级）',
  'sxm-phone-bind-done': '绑定引导状态（设备级）',
  'sxm-phone-bind-dismissed': '绑定引导状态（设备级）',
  'sxm-remember-login': '记住登录（会话/设备级）',
  'sxm-dial-code': '拨号区号偏好（设备级）',
  'llm-conversation-id': '对话会话 id（会话级）',
  'mb-cat-affinity-ab': 'A/B 分流计数器（代码注释已写明不上云）',
  'mb_ai_audio_trace': '音频链路追踪计数器（不含内容）',
  'mb-sub-auth-at': '授权时间戳（统计用）',
  'subscribeStat': '订阅统计计数器',
  'subscribeDeny': '订阅拒绝计数（统计用）',
  'mb_habit_notices': '习惯提醒节流状态（设备级）',
  'mb_price_notices': '价格提醒节流状态（设备级）',
  'mb_shopping_notified': '已提醒标记（设备级节流）',
  'briefingDailyCache': '当日晨报缓存（可重新拉取）',
  'library-open-history': '打开历史（次要，已有 browseHistory 覆盖）',
  'h5-subscription': '派生缓存（真值在 orders 表，由订阅回放修复）'
};

const syncSrc = read('src/services/cloudSync.ts');
const syncBlock = syncSrc.slice(
  syncSrc.indexOf('const SYNC_KEYS = ['),
  syncSrc.indexOf('] as const;') + 1
);
const syncKeys = [...syncBlock.matchAll(/^\s*'([^']+)'/gm)].map((m) => m[1]);
const syncSet = new Set(syncKeys);

// A1 权威清单里的键必须真的在 SYNC_KEYS 里
{
  const missing = CROSS_DEVICE_KEYS.filter((k) => !syncSet.has(k));
  assert(
    `A1 ${CROSS_DEVICE_KEYS.length} 个「应跨设备」的用户数据键全部在 SYNC_KEYS 里（否则换设备失忆）`,
    missing.length === 0,
    missing.join(', ')
  );
}

// A2 清单里的键必须**在源码里确有本地写入点**（防止清单里写了一个不存在的键 —— 那等于假覆盖）
{
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
    }
  };
  walk(path.join(ROOT, 'src'));
  const blob = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const ghost = CROSS_DEVICE_KEYS.filter((k) => !blob.includes(k));
  assert(
    'A2 清单里每个键在源码里确有出现（防止列了不存在的键 = 假覆盖）',
    ghost.length === 0,
    ghost.join(', ')
  );
}

// A3 全仓本地键 - SYNC_KEYS 必须**全部**在豁免表里（新增用户数据键忘了登记 ⇒ 这里红）
{
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
    }
  };
  walk(path.join(ROOT, 'src'));
  const localKeys = new Set();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const consts = new Map();
    for (const m of src.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*'([^']{1,60})'/g)) consts.set(m[1], m[2]);
    for (const m of src.matchAll(/setStorageSync\(\s*[`']([^`']{1,60})[`']/g)) localKeys.add(m[1]);
    for (const m of src.matchAll(/setStorageSync\(\s*([A-Za-z_$][\w$]*)/g)) {
      const v = consts.get(m[1]);
      if (v) localKeys.add(v);
    }
  }
  const unlisted = [...localKeys].filter((k) => !syncSet.has(k) && !(k in DEVICE_ONLY_KEYS));
  assert(
    `A3 全仓 ${localKeys.size} 个本地键：不在 SYNC_KEYS 的必须逐个登记豁免理由（漏登记 = 用户数据悄悄失忆）`,
    unlisted.length === 0,
    unlisted.join(', ')
  );
  const stale = Object.keys(DEVICE_ONLY_KEYS).filter((k) => !localKeys.has(k));
  assert(
    'A4 豁免表里没有已不存在的键（豁免表本身要跟着代码走）',
    stale.length === 0,
    stale.join(', ')
  );
}

// A5 设备级键不得混进 SYNC_KEYS（合规数据不该上云 —— 隐私红线）
{
  const leaked = Object.keys(DEVICE_ONLY_KEYS).filter((k) => syncSet.has(k));
  assert('A5 设备级/合规键没有混进 SYNC_KEYS（不该上云的数据不上云）', leaked.length === 0, leaked.join(', '));
}

// A6 每个同步键都要有 REMOVE_PLACEHOLDER（漏了 ⇒ 删除动作同步不出去，云端留着旧数据）
{
  const phBlock = syncSrc.slice(
    syncSrc.indexOf('const REMOVE_PLACEHOLDER'),
    syncSrc.indexOf('};', syncSrc.indexOf('const REMOVE_PLACEHOLDER')) + 2
  );
  const noPh = syncKeys.filter((k) => !phBlock.includes(`'${k}'`) && !phBlock.includes(`${k}:`));
  assert('A6 每个 SYNC_KEY 都有 REMOVE_PLACEHOLDER（删除动作也要能同步出去）', noPh.length === 0, noPh.join(', '));
}

/* ───────────────────── B. 降级诚实性（真实数据不许被说成演示数据） ───────────────────── */

const cloudSrc = read('src/services/cloud.ts');
const realLocalMatch = cloudSrc.match(/REAL_LOCAL_ACTIONS\s*=\s*new Set\(\[([^\]]*)\]/);
const realLocalActions = realLocalMatch ? [...realLocalMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];

// B1 集合里的每个 action，其降级模块必须**读本地存储**（真数据 ⇒ 不登记降级 ⇒ 不谎称演示）
{
  const readsStorage = (name) => {
    const p = path.join(ROOT, 'src/data', `${name}.ts`);
    if (!fs.existsSync(p)) return false;
    const src = fs.readFileSync(p, 'utf8');
    // ⚠️ 必须匹配**调用**而不是标识符：只写 `listCollections` 会连
    //    `import { listCollections } from './collectionStore'` 这行 import 一起命中
    //    ⇒ 有人把降级模块改成硬编码返回时，判据照样绿（实测踩过）。
    return /(listCollections|readPlan|readStore|getStorageSync|readH5Subscription)\s*\(/.test(src);
  };
  const notReal = realLocalActions.filter((n) => !readsStorage(n));
  assert(
    `B1 REAL_LOCAL_ACTIONS（${realLocalActions.length} 个）里的降级模块都真的读本地存储（否则是编造数据，不该被免报）`,
    realLocalActions.length > 0 && notReal.length === 0,
    notReal.join(', ')
  );
}

// B2 markDegraded 必须对 REAL_LOCAL_ACTIONS 短路（不登记降级）
{
  const fn = cloudSrc.slice(cloudSrc.indexOf('export function markDegraded'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert(
    'B2 markDegraded 对 REAL_LOCAL_ACTIONS 短路（真实本地数据不登记降级）',
    /REAL_LOCAL_ACTIONS\.has\(name\)/.test(body) && /return/.test(body)
  );
}

/* ───────────────────── C. 页级横幅：只显示本页的、且区分「没传」与「空数组」 ───────────────────── */

{
  const hintSrc = read('src/components/DemoDataHint/index.tsx');
  // ⚠️ 必须**剥注释**再判：本组件的注释里就写着旧写法 `scope && scope.length`
  //   （那是在解释「以前怎么错的」）⇒ 不剥会被注释自己点亮 ⇒ 假红。
  const hintCode = hintSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert(
    "C1 DemoDataHint 区分「没传 actions」与「传了空数组」（空数组 = 本页不显示，不是显示全部）",
    /scope === undefined/.test(hintCode) && !/scope && scope\.length/.test(hintCode)
  );
  // C2 页面声明的 actions 里不得含 REAL_LOCAL_ACTIONS 的 action（那些永不降级 = 死配置）
  const pagesDir = path.join(ROOT, 'src/pages');
  const offenders = [];
  const pages = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/index\.tsx$/.test(e.name)) pages.push(p);
    }
  };
  walk(pagesDir);
  for (const p of pages) {
    const src = fs.readFileSync(p, 'utf8');
    for (const m of src.matchAll(/<DemoDataHint\s+actions=\{\[([^\]]*)\]\}/g)) {
      const acts = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
      const bad = acts.filter((a) => realLocalActions.includes(a));
      if (bad.length) offenders.push(`${path.relative(ROOT, p).split(path.sep).join('/')}: ${bad.join(',')}`);
    }
  }
  assert(
    'C2 页级横幅的 actions 里不含「永不降级」的 action（真实本地数据的 action 永不登记降级）',
    offenders.length === 0,
    offenders.join(' | ')
  );
  // C3 用了横幅的页面必须显式声明 actions（不声明 = 显示全部 = 别的页面的降级会串进来）
  const undeclared = [];
  for (const p of pages) {
    const src = fs.readFileSync(p, 'utf8');
    if (src.includes('<DemoDataHint') && !/<DemoDataHint\s+actions=/.test(src)) {
      undeclared.push(path.relative(ROOT, p).split(path.sep).join('/'));
    }
  }
  assert('C3 用了横幅的页面都显式声明了 actions（不声明会显示全部降级 ⇒ 串台）', undeclared.length === 0, undeclared.join(', '));
}

/* ───────────────────────── 输出 ───────────────────────── */
for (const r of rows) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : '  → ' + r.detail}`);
}
console.log(`\nPASS ${pass} / FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
