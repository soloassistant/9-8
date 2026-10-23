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

const briefing = read('src/pages/briefing/index.tsx');
const fnStart = briefing.indexOf('const handleVoiceResult');
const fnEnd = briefing.indexOf('const handleRenewSubscribe', fnStart);
const voiceBody = fnStart >= 0 && fnEnd > fnStart ? briefing.slice(fnStart, fnEnd) : '';

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

console.log('\n通过 ' + pass + ' / 失败 ' + fail);
if (fail > 0) process.exit(1);
