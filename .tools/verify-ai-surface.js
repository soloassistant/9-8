#!/usr/bin/env node
/**
 * verify-ai-surface.js —— 「AI 入口只有一处」的结构门禁。
 *
 * 为什么需要这条门禁（2026-10-27）：
 *   用户对晨报页底部那条常驻输入栏的反馈是「这个取消了，页面 AI 生成放设置里面，
 *   剩下的全删掉」。当时的实际情况是**同一件事有三个入口、两套实现**：
 *     · 晨报页底部输入条（4 个快捷 chip + 输入行 + 语音按钮）—— 自己一套对话实现；
 *     · 全局悬浮球 + 浮层面板（AiAssistant 组件）—— 挂在 app.tsx，任何页都能唤起；
 *     · 引导气泡 —— 同一件事的第三个入口，常驻占位约 38px。
 *   删掉之后**没有任何东西阻止它长回来**：加一个悬浮球、加一条输入栏，都不会让别的
 *   门禁变红（它们只验各自的功能）。这条门禁就是那道锁。
 *
 * 守的不是"AI 功能存在"（那是别处的断言），而是**入口数量与位置**：
 *   · 晨报页（信息阅读页）不再是 AI 入口 —— 阅读页要留给内容；
 *   · 全站唯一的对话页是 pages/assistant，由「我的 → AI 助手」进入；
 *   · 语音（VoiceButton）只允许出现在两处：对话页与口语练习（都是真实 ASR 场景）。
 *
 * ⚠️ 断言铁律：cond 必须是 boolean。失败分支返回原因字符串 = truthy = 永久假绿。
 *
 * 用法：node .tools/verify-ai-surface.js
 * 退出码：0 = 全 PASS
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let pass = 0;
const failures = [];

function ok(name, cond) {
  if (typeof cond !== 'boolean') {
    throw new TypeError(`断言 ${name} 的 cond 必须是 boolean，实际是 ${typeof cond}`);
  }
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}`);
  }
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** 递归列出 src 下所有 ts/tsx（不做符号级判断，只用于"谁引用了它"这类全站扫描） */
function walk(dir, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(name)) acc.push(p);
  }
  return acc;
}

/* =====================================================================
 * A. 晨报页不再是 AI 入口（用户点名要撤的那一条）
 * ===================================================================== */
const brief = read('src/pages/briefing/index.tsx');

ok(
  'A1 晨报页不再引用 VoiceButton（底部输入栏语音按钮已撤）',
  !brief.includes('VoiceButton')
);
ok(
  'A2 晨报页无快捷指令 chip（QUICK_COMMANDS 常量已删）',
  !brief.includes('QUICK_COMMANDS')
);
ok(
  'A3 晨报页无输入栏 / 消息区样式引用',
  !brief.includes('styles.inputBar') && !brief.includes('styles.messages')
);
// 只判裸 `apiChat` 会被 `apiChat` 出现在注释/import 里误杀；判「带括号的调用」。
ok(
  'A4 晨报页不再直接发起 AI 对话（无 apiChat( 调用）',
  !/apiChat\(/.test(brief) && !/apiChatStream\(/.test(brief)
);
ok(
  'A5 晨报页不再自带对话日志 key（BRIEFING_CHAT_LOG_KEY 已删）',
  !brief.includes('BRIEFING_CHAT_LOG_KEY')
);

/* =====================================================================
 * B. 全站唯一 AI 对话入口 = pages/assistant
 * ===================================================================== */
const app = read('src/app.tsx');
ok('B1 app.tsx 不再挂全局 AI 悬浮球（无 AiAssistant 引用）', !app.includes('AiAssistant'));

const assistantPage = read('src/pages/assistant/index.tsx');
ok(
  'B2 assistant 页以整页模式渲染（<AiAssistant embedded>）',
  /<AiAssistant\s+embedded\s*\/>/.test(assistantPage)
);

// 除助手页本身，任何页面都不许再 import AiAssistant（否则又是第二处入口）
const srcFiles = walk(path.join(ROOT, 'src'));
const importers = srcFiles
  .filter((f) => !/[\\/]pages[\\/]assistant[\\/]/.test(f))
  .filter((f) => /import\s+AiAssistant\s+from/.test(fs.readFileSync(f, 'utf8')));
ok(
  `B3 除 pages/assistant 外无任何文件 import AiAssistant（实际命中：${importers.length}）`,
  importers.length === 0
);

const mine = read('src/pages/mine/index.tsx');
const entryHits = (mine.match(/\/pages\/assistant\/index/g) || []).length;
ok(`B4 「我的」页恰好一处 /pages/assistant/index 跳转（实际 ${entryHits}）`, entryHits === 1);

const config = read('src/app.config.ts');
ok(
  'B5 app.config.ts 注册了 pages/assistant/index',
  (config.match(/'pages\/assistant\/index'/g) || []).length === 1
);

/* =====================================================================
 * C. 语音只出现在真实 ASR 场景（对话页 + 口语练习）
 * ===================================================================== */
const voiceUsers = srcFiles
  .filter((f) => /import\s+VoiceButton\s+from/.test(fs.readFileSync(f, 'utf8')))
  .map((f) => path.relative(ROOT, f).replace(/\\/g, '/'))
  .sort();
ok(
  `C1 VoiceButton 恰好被 2 个文件引用（对话页 + 口语练习），实际：${voiceUsers.join(', ') || '无'}`,
  voiceUsers.length === 2 &&
    voiceUsers.includes('src/components/AiAssistant/index.tsx') &&
    voiceUsers.includes('src/pages/learnDetail/SpeakingDrill.tsx')
);

const panel = read('src/components/AiAssistant/index.tsx');
// 语音按钮必须在输入行里（否则就是"挂了组件但没人点得到"）
const inputRowAt = panel.indexOf('styles.inputRow');
const voiceAt = panel.indexOf('<VoiceButton');
ok(
  'C2 对话页语音按钮落在输入行内（不是悬空引用）',
  inputRowAt > -1 && voiceAt > inputRowAt && voiceAt - inputRowAt < 300
);

/* =====================================================================
 * D. 三个新页各就各位（搬走的东西不许两头留）
 * ===================================================================== */
const membership = read('src/pages/membership/index.tsx');
const prefs = read('src/pages/prefs/index.tsx');

ok(
  'D1 会员中心承接支付下单（apiCreateOrder），我的页不再下单',
  membership.includes('apiCreateOrder') && !mine.includes('apiCreateOrder')
);
ok(
  'D2 偏好设置承接城市写入（handleSaveCity + user-city），我的页不再写',
  prefs.includes('const handleSaveCity') && !mine.includes('handleSaveCity')
);
ok(
  'D3 我的页三行入口齐全（会员中心 / 偏好设置 / AI 助手）',
  mine.includes('/pages/membership/index') &&
    mine.includes('/pages/prefs/index') &&
    mine.includes('/pages/assistant/index')
);
ok(
  'D4 三个新页都在 app.config.ts 注册（且各一次）',
  (config.match(/'pages\/membership\/index'/g) || []).length === 1 &&
    (config.match(/'pages\/prefs\/index'/g) || []).length === 1
);

/* =====================================================================
 * E. 整页模式的语义（没有悬浮球可点，进来就必须是打开的）
 * ===================================================================== */
ok('E1 整页模式默认展开（useState(embedded)）', /useState\(embedded\)/.test(panel));
ok(
  'E2 整页模式不渲染悬浮球（embedded ? null : <View id=\'ai-fab\'）',
  /\{embedded\s*\?\s*null\s*:\s*\(?\s*<View\s+id='ai-fab'/.test(panel)
);
ok('E3 整页模式不渲染关闭按钮（没有可关回的地方）', /\{embedded\s*\?\s*null\s*:\s*\(?\s*<View\s+className=\{styles\.panelClose\}/.test(panel));
ok(
  'E4 引导气泡已彻底移除（同一件事的第三个入口）',
  !panel.includes('hintBubble') && !panel.includes('hintVisible')
);

console.log('\n通过 ' + pass + ' / 失败 ' + failures.length);
if (failures.length > 0) {
  console.log('\n失败项：');
  failures.forEach((f) => console.log('  · ' + f));
  process.exit(1);
}
