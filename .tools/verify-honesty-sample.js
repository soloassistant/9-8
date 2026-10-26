#!/usr/bin/env node
/**
 * verify-honesty-sample.js —— 「假数据 / 假能力」回归闸门。
 *
 * 背景：PRD.md:25 承诺「不造演示数据」，但有两处直接违反：
 *   ① 学习社区的 seedPosts() 三条内置动态与真实用户动态混排、无任何标注；
 *   ② H5 端语音用 MOCK_TRANSCRIPTS 冒充识别结果，还扣了真实语音额度。
 *
 * 这两类问题的共同点是「读代码觉得没问题，用户却会被骗」，所以这里**只认源码事实**：
 * 标记字段、渲染分支、调用位置、常量残留。断言一律要求 cond === true ——
 * 失败分支若返回非空字符串会被 truthy 判成 PASS（本项目踩过这个坑）。
 *
 * 用法: node .tools/verify-honesty-sample.js
 * 退出码: 0 = 全 PASS；1 = 有 FAIL
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
let pass = 0;
let fail = 0;

function ok(name, cond) {
  if (cond === true) {
    pass++;
    console.log('PASS  ' + name);
  } else {
    fail++;
    console.log('FAIL  ' + name);
  }
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** 取 scss 中某个类名的声明块（第一个 `{...}`） */
function scssBlock(source, cls) {
  const i = source.indexOf('.' + cls);
  if (i < 0) return '';
  const s = source.indexOf('{', i);
  const e = source.indexOf('}', s);
  return s >= 0 && e > s ? source.slice(s + 1, e) : '';
}

/** 递归收集 src/ 下所有源文件（tsx/ts/scss） */
function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|scss)$/.test(name)) out.push(full);
  }
  return out;
}

/* ============ A. 学习社区：条目级「示例」标注 ============ */

const community = read('src/pages/learnCommunity/index.tsx');
const communityScss = read('src/pages/learnCommunity/index.module.scss');

const seedStart = community.indexOf('function seedPosts');
const seedEnd = community.indexOf('function markSamples');
const seedBody = seedStart >= 0 && seedEnd > seedStart ? community.slice(seedStart, seedEnd) : '';

ok('A1 seedPosts() 存在且可定位', seedBody.length > 0);
ok('A2 seedPosts() 三条示例都带 sample: true', (seedBody.match(/sample:\s*true/g) || []).length === 3);
ok(
  'A3 Post 类型声明了 sample?: boolean',
  /interface Post\s*\{[\s\S]*?sample\?:\s*boolean/.test(community)
);
ok(
  'A4 老存储数据按 seed- 前缀补标（老用户也会看到徽章）',
  community.includes("startsWith('seed-')") && /markSamples[\s\S]*?sample:\s*true/.test(community)
);
ok(
  'A5 条目渲染引用 community.sampleBadge 且以 p.sample 为条件',
  community.includes("t('community.sampleBadge')") && /p\.sample\s*&&\s*\(?\s*<Text/.test(community)
);
ok('A6 打卡墙标题下引用 community.sampleNote', community.includes("t('community.sampleNote')"));
ok(
  'A7 示例条目挂独立样式类（非纯文字标注）',
  /classnames\(styles\.postItem,\s*p\.sample\s*&&\s*styles\.postItemSample\)/.test(community)
);
const sampleItemCss = scssBlock(communityScss, 'postItemSample');
const sampleBadgeCss = scssBlock(communityScss, 'sampleBadge');

ok(
  'A8 scss 定义 .postItemSample 且有底色/左边框',
  sampleItemCss.includes('background:') && sampleItemCss.includes('border-left:')
);
ok(
  'A9 scss 定义 .sampleBadge 且有描边/底色/字重',
  sampleBadgeCss.includes('border:') &&
    sampleBadgeCss.includes('background:') &&
    sampleBadgeCss.includes('font-weight:')
);
ok('A10 scss 定义 .sampleNote', /\.sampleNote\s*\{/.test(communityScss));

/* ============ B. 页级降级提示：markDegraded + DemoDataHint ============ */

ok(
  'B1 learnCommunity 从 @/services/cloud 导入 markDegraded',
  /import\s*\{\s*markDegraded\s*\}\s*from\s*'@\/services\/cloud'/.test(community)
);
ok("B2 learnCommunity 调用 markDegraded('learnCommunity')", community.includes("markDegraded('learnCommunity')"));
ok(
  'B3 learnCommunity 导入并渲染 DemoDataHint',
  /import DemoDataHint from '@\/components\/DemoDataHint'/.test(community) && community.includes('<DemoDataHint />')
);

/* ============ C. H5 语音：不 mock、不扣额度 ============ */

// 2026-10-27：晨报页底部输入栏撤除后，语音能力随 AI 对话搬进 AiAssistant（整页形态）。
// 断言锚点跟着搬家 —— 守的仍是同一条：H5 无转写能力时绝不冒充、绝不扣额度。
const panel = read('src/components/AiAssistant/index.tsx');
const fnStart = panel.indexOf('const handleVoiceResult');
const fnEnd = panel.indexOf('const handleApprovePlan', fnStart);
const voiceBody = fnStart >= 0 && fnEnd > fnStart ? panel.slice(fnStart, fnEnd) : '';

ok('C1 handleVoiceResult 存在且可定位', voiceBody.length > 0);
ok('C2 H5 守卫存在（!isWeapp 提前 return）', /if\s*\(\s*!isWeapp\s*\)\s*\{[\s\S]*?return;/.test(voiceBody));
// 用「带括号的调用」定位真实代码行：函数内注释也提到了 bumpVoiceUsage，
// 只搜裸标识符会把注释算进去（第一次跑就是这样误判的）。
const guardAt = voiceBody.indexOf('if (!isWeapp)');
const bumpAt = voiceBody.indexOf('bumpVoiceUsage();');
const quotaAt = voiceBody.indexOf('checkVoiceQuota()');
ok(
  'C3 守卫行号早于 bumpVoiceUsage（H5 绝不扣额度）',
  guardAt >= 0 && bumpAt >= 0 && guardAt < bumpAt
);
ok(
  'C4 守卫行号早于 checkVoiceQuota（H5 连弹额度提示都不该有）',
  guardAt >= 0 && quotaAt >= 0 && guardAt < quotaAt
);
ok('C5 守卫使用 briefing.voiceWeappOnly 文案', voiceBody.includes("t('briefing.voiceWeappOnly')"));

const srcFiles = walk(path.join(ROOT, 'src'));
const mockHits = srcFiles.filter((f) => {
  const s = fs.readFileSync(f, 'utf8');
  return s.includes('MOCK_TRANSCRIPTS') || s.includes('mockIndexRef');
});
ok('C6 MOCK_TRANSCRIPTS / mockIndexRef 在 src/ 下零命中', mockHits.length === 0);

const locale = read('src/store/language.ts');
ok(
  'C7 briefing.voiceWeappOnly 中英各一条',
  (locale.match(/'briefing\.voiceWeappOnly'/g) || []).length === 2 &&
    locale.includes('语音输入仅在微信小程序里可用') &&
    locale.includes('Voice input is only available in the WeChat mini program')
);

/* ============ D. 约定写进 AGENTS.md ============ */

const agents = read('AGENTS.md');
ok('D1 AGENTS.md 含「条目级标注」约定', agents.includes('条目级标注'));
ok('D2 AGENTS.md 含「不得因此消耗用户额度」约定', agents.includes('不得因此消耗用户额度'));

/* ============ E. extract 降级路径：不编造提取结果（2026-10-24 P0） ============ */
/*
 * 背景：src/data/extract.ts 是 AI 提取的**第三级**兜底（① cloud.llm → ② 本地代理 → ③ 这里）。
 * 修正前它对**任何输入**都返回固定的「产品评审会 / 3 号会议室 / 评审前更新演示文稿」
 * （图片通道则是「季度复盘会（来自截图）」），还把用户原文贴成 source，
 * 由 inbox 套上「— 由 AI 提取整理，请核对 —」标识 —— 用户点确认就写进真实日历。
 * 同时踩三条硬规则：法务条文 4（没有 AI 却称 AI 提取）、AGENTS.md 8.1（示例须条目级标注）、
 * 《AI 标识办法》（不得对非 AI 生成内容作 AI 标识）。
 */
const extractSrc = read('src/data/extract.ts');

/**
 * 剥掉注释再断言。
 * ⚠️ 不剥会自己误杀自己：本模块的注释里**刻意保留**了旧缺陷的原文
 *    （「产品评审会 / 3 号会议室 / 评审前更新演示文稿」），那是给人看的事故记录。
 *    第一版直接在原文上匹配 → E1/E4 全红，而代码其实已经改好了。
 *    与 verify-docs B3 被自己的解释性注释误杀是同一个坑：**判据不能把注释当代码**。
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}
const extractCode = stripComments(extractSrc);
const inboxCode = stripComments(read('src/pages/inbox/index.tsx'));

// E1：不得残留编造出来的具体内容串（这些串一旦回来，就说明有人把假数据又写回去了）
const FABRICATED = [
  '产品评审会',
  '评审前更新演示文稿',
  '季度复盘会',
  '3 号会议室',
  '按截图里的清单核对会议材料',
  '转发内容摘要'
];
const leaked = FABRICATED.filter((s) => extractCode.includes(s));
ok(
  `E1 mock 不含编造的内容串${leaked.length ? '（残留: ' + leaked.join(' / ') + '）' : ''}`,
  leaked.length === 0
);

// E2：降级时必须**不出结果**。空数组是「没解析出东西」的诚实表达。
ok('E2 mock 返回空 events（不编造日程）', /events:\s*\[\s*\]/.test(extractCode));
ok('E3 mock 返回空 todos（不编造待办）', /todos:\s*\[\s*\]/.test(extractCode));

// E4：不得把用户原文回贴成 source —— 那会让假结果看起来像是「从你的内容里提取的」。
// ⚠️ 正则必须同时盖住 `content.slice` 与 `content?.slice`（可选链）。
//    第一版写成 /content\.slice/，反向变异注入 `_data?.content?.slice(0, 50)` 时**没被抓住**
//    （NOT-CAUGHT）—— 断言看着在跑、也打印 PASS，但对真实形态没有判别力。
//    顺带把 substring / substr 一起盖住：换个切片方法就能绕过的断言等于没有。
//    `content` 前必须有词边界 —— 否则 `mycontent.slice` 也会误命中（第二次栽在同一判据上）。
ok(
  'E4 不把用户原文回贴成 source',
  !/\bcontent\s*\??\.\s*(slice|substring|substr)\b/.test(extractCode)
);

// E5：降级必须**说真话**，不能是 undefined（那会只剩一条笼统 toast，看不出是能力不可用）
const noteMatch = extractCode.match(/note:\s*(['"])[^'"]{10,}\1/);
ok('E5 降级时必须给出 note 说明原因', noteMatch !== null);

// E6：AI 标识必须被 `drafts.length > 0` 守住 —— 没有结果时不得显示「由 AI 提取整理」
const guardStart = inboxCode.indexOf('{drafts.length > 0 ? (');
const guardEnd = inboxCode.indexOf(') : note ? (', guardStart);
const guarded = guardStart >= 0 && guardEnd > guardStart ? inboxCode.slice(guardStart, guardEnd) : '';
ok(
  'E6 AI 标识只在有草稿时渲染（且空态分支仍在）',
  guardStart >= 0 && guardEnd > guardStart && guarded.includes('resultAiLabel')
);

// E7：仍必须是能被 `import(\`../data/${name}\`)` 动态加载的默认导出
ok('E7 仍是可动态 import 的默认导出', /export default function extract/.test(extractCode));

console.log('\n通过 ' + pass + ' / 失败 ' + fail);
if (fail > 0) process.exit(1);
