#!/usr/bin/env node
/**
 * verify-hotkeys.mjs —— 桌面端键盘快捷键门禁（2026-10-27）。
 *
 * 快捷键是一类**特别容易假绿**的功能：绑定表看起来对、帮助面板写得漂亮，
 * 但实际按键要么被输入法吃掉、要么在 Mac 上按 Ctrl 也触发、要么绑到了浏览器的
 * ⌘W 上。这些都不报错、不崩溃，只是「按了没反应」或「按了干了别的事」。
 *
 * 因此本门禁分两部分：
 *   A–B. **真值表**：把纯逻辑层编译后在 Node 里直接喂事件对象，逐条钉住判定口径
 *        （平台归一的双向、字符键不校验 shift、多余修饰键不匹配、序列前缀的消费语义）。
 *   C.   **表的自洽**：每个跳转键的目标页真实存在且是 tabBar 页（switchTab 只对 tab 页有效）、
 *        每个 labelKey 中英文都有、没有绑定浏览器保留键。
 *   D.   **接线**：断言必须框到具体函数体 —— 「文件里出现过某符号」是假绿，
 *        import 与别的流程里也有同样的词。
 *
 * 用法: node .tools/verify-hotkeys.mjs
 * 退出码: 0 = 全绿；1 = 有断言失败；2 = harness 自身出错
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import esbuild from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);

let pass = 0;
let fail = 0;

/** 断言铁律：cond 必须是 boolean，非 boolean 直接抛（防止 `assert('...')` 这类假绿） */
function assert(name, cond) {
  if (typeof cond !== 'boolean') {
    throw new Error(`断言「${name}」的 cond 不是 boolean，而是 ${typeof cond}：${String(cond)}`);
  }
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}`);
  }
}

function section(title) {
  console.log(`\n── ${title} ──`);
}

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * 取一段源码：从 startMarker 到 endMarker（不含）。找不到 start 返回空串。
 * 用于把断言框到**具体函数/段落**，而不是整份文件。
 */
function region(src, startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  if (s < 0) return '';
  if (!endMarker) return src.slice(s);
  const e = src.indexOf(endMarker, s + startMarker.length);
  return e < 0 ? src.slice(s) : src.slice(s, e);
}

/** 编译单个 src 模块并在隔离 vm 里求值（与 verify-util-logic 同一手法）。 */
async function loadModule(relPath) {
  const built = await esbuild.build({
    entryPoints: [path.join(ROOT, relPath)],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    alias: { '@': path.join(ROOT, 'src') },
    logLevel: 'silent'
  });
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require,
    console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
    process,
    setTimeout,
    clearTimeout
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(built.outputFiles[0].text, sandbox, { filename: relPath });
  return sandbox.module.exports;
}

const hk = await loadModule('src/utils/hotkeys.ts');

/* ================================================================== */
/* A. matchChord 真值表                                                */
/* ================================================================== */
section('A. matchChord 真值表（平台归一 / 修饰键 / 字符键）');

const KEY = (over) => ({ key: 'x', ...over });
const isMac = true;
const isWin = false;

assert('A1 `?` 不按 shift 也命中（e.key 已经是 ?，不该再校验 shiftKey）',
  hk.matchChord(KEY({ key: '?' }), '?', isWin) === true);
assert('A2 `?` 带 shift 也命中（shift+/ 的真实形态）',
  hk.matchChord(KEY({ key: '?', shiftKey: true }), '?', isWin) === true);
assert('A3 字符键不因 shift 状态不同而失配（`/` + shift 仍算 `/`）',
  hk.matchChord(KEY({ key: '/', shiftKey: true }), '/', isWin) === true);
assert('A4 带 Ctrl 的 `/` 不命中裸 `/`（多余的修饰键视为不匹配）',
  hk.matchChord(KEY({ key: '/', ctrlKey: true }), '/', isWin) === false);

assert('A5 Mac 上 ⌘+Enter 命中 mod+enter',
  hk.matchChord(KEY({ key: 'Enter', metaKey: true }), 'mod+enter', isMac) === true);
assert('A6 ★ Mac 上 Ctrl+Enter 不命中 mod+enter（否则两个键都触发）',
  hk.matchChord(KEY({ key: 'Enter', ctrlKey: true }), 'mod+enter', isMac) === false);
assert('A7 Windows 上 Ctrl+Enter 命中 mod+enter',
  hk.matchChord(KEY({ key: 'Enter', ctrlKey: true }), 'mod+enter', isWin) === true);
assert('A8 Windows 上 ⌘/Win+Enter 不命中 mod+enter',
  hk.matchChord(KEY({ key: 'Enter', metaKey: true }), 'mod+enter', isWin) === false);
assert('A9 两个修饰键同时按着不算（Mac ⌘+Ctrl+Enter）',
  hk.matchChord(KEY({ key: 'Enter', metaKey: true, ctrlKey: true }), 'mod+enter', isMac) === false);
assert('A10 ⌘+Shift+Enter 不等同于 ⌘+Enter',
  hk.matchChord(KEY({ key: 'Enter', metaKey: true, shiftKey: true }), 'mod+enter', isMac) === false);

assert('A11 字母键必须校验 shift：裸 b 命中、Shift+b 不命中',
  hk.matchChord(KEY({ key: 'b' }), 'b', isWin) === true
  && hk.matchChord(KEY({ key: 'b', shiftKey: true }), 'b', isWin) === false);
assert('A12 大写字母归一化为小写后命中',
  hk.matchChord(KEY({ key: 'B' }), 'b', isWin) === true);
assert('A13 Escape 与 Esc 两种写法都命中',
  hk.matchChord(KEY({ key: 'Escape' }), 'escape', isWin) === true
  && hk.matchChord(KEY({ key: 'Esc' }), 'escape', isWin) === true);
assert('A14 方向键走命名键归一',
  hk.matchChord(KEY({ key: 'ArrowUp' }), 'arrowup', isWin) === true);
assert('A15 带 Alt 的字母不命中裸字母',
  hk.matchChord(KEY({ key: 'b', altKey: true }), 'b', isWin) === false);

/* ================================================================== */
/* B. resolveSequence 状态机                                            */
/* ================================================================== */
section('B. resolveSequence 序列手势（g + 字母）');

const s1 = hk.resolveSequence('', KEY({ key: 'g' }), isWin);
assert('B1 单独按 g → 进入待命态、吃掉这次按键（否则 g 会被当普通字符打出）',
  s1.pending === 'g' && s1.consumed === true && s1.hit === null);

const s2 = hk.resolveSequence('g', KEY({ key: 'b' }), isWin);
assert('B2 待命态按 b → 命中 goBriefing 并清空前缀',
  s2.hit === 'goBriefing' && s2.pending === '' && s2.consumed === true);

const s3 = hk.resolveSequence('g', KEY({ key: 'x' }), isWin);
assert('B3 待命态按无关键 → 不命中，但前缀仍被消费（g 后面的键不能再留给下一次）',
  s3.hit === null && s3.pending === '' && s3.consumed === true);

const s4 = hk.resolveSequence('', KEY({ key: 'b' }), isWin);
assert('B4 没有前缀时按 b → 完全不消费，页面照常处理这个字符',
  s4.consumed === false && s4.pending === '' && s4.hit === null);

const s5 = hk.resolveSequence('g', KEY({ key: 'b', ctrlKey: true }), isWin);
assert('B5 前缀之后带修饰键 → 不命中（Ctrl+B 不是 g 手势的第二段）',
  s5.hit === null && s5.consumed === true);

const s6 = hk.resolveSequence('', KEY({ key: 'g', ctrlKey: true }), isWin);
assert('B6 Ctrl+G 不进入待命态（Ctrl 组合属于浏览器/系统）',
  s6.consumed === false && s6.pending === '');

/* ================================================================== */
/* C. 输入法 / 保留键 / 键帽格式化                                       */
/* ================================================================== */
section('C. isComposing / isReservedChord / 键帽格式化');

assert('C1 isComposing 认 isComposing 标记',
  hk.isComposing(KEY({ key: 'g', isComposing: true })) === true);
assert('C2 isComposing 认 keyCode 229（部分浏览器的组字写法）',
  hk.isComposing(KEY({ key: 'g', keyCode: 229 })) === true);
assert('C3 isComposing 认 key=Process',
  hk.isComposing(KEY({ key: 'Process' })) === true);
assert('C4 普通按键不算组字中',
  hk.isComposing(KEY({ key: 'g' })) === false);

assert('C5 浏览器保留键 mod+w / mod+t / f5 必须被识别出来',
  hk.isReservedChord('mod+w') === true
  && hk.isReservedChord('mod+t') === true
  && hk.isReservedChord('f5') === true);
assert('C6 本项目用到的键都不是保留键（mod+enter / ? / / / escape / g b 的第一段）',
  hk.isReservedChord('mod+enter') === false
  && hk.isReservedChord('?') === false
  && hk.isReservedChord('/') === false
  && hk.isReservedChord('escape') === false
  && hk.isReservedChord('g') === false);

const macCaps = hk.formatChord('mod+enter', true);
const winCaps = hk.formatChord('mod+enter', false);
assert('C7 Mac 显示 ⌘、其它平台显示 Ctrl',
  macCaps[0] === '⌘' && winCaps[0] === 'Ctrl' && macCaps[1] === 'Enter' && winCaps[1] === 'Enter');
const seqCaps = hk.formatSequence('g b', false);
assert('C8 序列手势拆成两组键帽（帮助面板要能显示「G 然后 B」）',
  seqCaps.length === 2 && seqCaps[0][0] === 'G' && seqCaps[1][0] === 'B');

/* ================================================================== */
/* D. 快捷键表自洽                                                      */
/* ================================================================== */
section('D. HOTKEYS 表自洽（路由真实存在 / 文案齐全 / 不劫持保留键）');

const ids = hk.HOTKEYS.map((h) => h.id);
const chords = hk.HOTKEYS.map((h) => h.chord);
assert('D1 id 无重复', new Set(ids).size === ids.length);
assert('D2 chord 无重复（否则后一条永远不会触发）', new Set(chords).size === chords.length);

const appConfig = read('src/app.config.ts');
const declaredPages = new Set([...appConfig.matchAll(/'(pages\/[^']+\/index)'/g)].map((m) => m[1]));
const tabPages = new Set([...appConfig.matchAll(/pagePath:\s*'([^']+)'/g)].map((m) => m[1]));

const navDefs = hk.HOTKEYS.filter((h) => h.group === 'navigate');
assert('D3 跳转键全部带 route', navDefs.length > 0 && navDefs.every((h) => typeof h.route === 'string' && h.route));
const badPage = navDefs.filter((h) => !declaredPages.has(h.route.replace(/^\//, '')));
assert(`D4 每个跳转目标都真实存在（不在 app.config 的页面清单里：${badPage.map((h) => h.route).join(',') || '无'}）`,
  badPage.length === 0);
/* switchTab 只能跳 tabBar 页：指向普通页会在运行时失败（Taro 直接 reject），
   而且这个失败只会在用户真的按下 g 的时候出现 —— 静态上先拦掉。 */
const notTab = navDefs.filter((h) => !tabPages.has(h.route.replace(/^\//, '')));
assert(`D5 跳转目标必须是 tabBar 页（switchTab 打不开非 tab 页：${notTab.map((h) => h.route).join(',') || '无'}）`,
  notTab.length === 0);

const nonNavWithRoute = hk.HOTKEYS.filter((h) => h.group !== 'navigate' && h.route);
assert('D6 非跳转键不许带 route（带了说明表写错了组）', nonNavWithRoute.length === 0);

const langSrc = read('src/store/language.ts');
const enStart = langSrc.indexOf('const en: Record<keyof typeof zh, string> = {');
const langKeyEnd = langSrc.indexOf('export type LangKey');
const zhKeys = new Set([...langSrc.slice(0, enStart).matchAll(/'([a-zA-Z0-9_.]+)':/g)].map((m) => m[1]));
const enKeys = new Set([...langSrc.slice(enStart, langKeyEnd).matchAll(/'([a-zA-Z0-9_.]+)':/g)].map((m) => m[1]));
const missingZh = hk.HOTKEYS.filter((h) => !zhKeys.has(h.labelKey)).map((h) => h.labelKey);
const missingEn = hk.HOTKEYS.filter((h) => !enKeys.has(h.labelKey)).map((h) => h.labelKey);
assert(`D7 每条 labelKey 中文文案都有（缺：${missingZh.join(',') || '无'}）`, missingZh.length === 0);
assert(`D8 每条 labelKey 英文文案都有（缺：${missingEn.join(',') || '无'}）`, missingEn.length === 0);
assert('D9 面板/入口自己的文案 key 也在（hotkeys.title / entryDesc / group* / then / hint）',
  ['hotkeys.title', 'hotkeys.entryDesc', 'hotkeys.groupGeneral', 'hotkeys.groupNavigate',
    'hotkeys.groupInput', 'hotkeys.then', 'hotkeys.hint'].every((k) => zhKeys.has(k) && enKeys.has(k)));

const reserved = hk.HOTKEYS.filter((h) => hk.isReservedChord(h.chord));
assert(`D10 没有任何一条绑到浏览器保留键（命中：${reserved.map((h) => h.chord).join(',') || '无'}）`,
  reserved.length === 0);

const escapeDef = hk.HOTKEYS.find((h) => h.id === 'escape');
const submitDef = hk.HOTKEYS.find((h) => h.id === 'submit');
assert('D11 Esc 与 ⌘Enter 允许在输入框里生效（whenTyping）',
  escapeDef?.whenTyping === true && submitDef?.whenTyping === true);
const typingLeak = hk.HOTKEYS.filter((h) => h.whenTyping && h.id !== 'escape' && h.id !== 'submit');
assert(`D12 只有 Esc / ⌘Enter 能在输入态生效（多于这两个会「打字打到一半页面跳走」：${typingLeak.map((h) => h.id).join(',') || '无'}）`,
  typingLeak.length === 0);

/* ================================================================== */
/* E. 接线（框到函数体，不看整份文件）                                   */
/* ================================================================== */
section('E. 接线：全局层 / 面板 / 入口 / ⌘Enter');

const appSrc = read('src/app.tsx');
const hookSrc = read('src/hooks/useHotkeys.ts');

assert('E1 app.tsx 只挂一次全局快捷键层',
  (appSrc.match(/useGlobalHotkeys\(/g) || []).length === 1);
assert('E2 全局层受三道门禁控制：非登录页 + 已同意合规 + 开屏已消失',
  /enabled:\s*!isLoginPage\s*&&\s*consentAgreed\s*&&\s*shellReady/.test(appSrc));
assert('E3 开屏消失后才放行快捷键（Splash 是不透明全屏层，否则面板会在它下面打开）',
  /<Splash\s+onGone=\{handleSplashGone\}/.test(appSrc)
  && /const\s+handleSplashGone\s*=\s*useCallback\(/.test(appSrc));
assert('E4 面板由 App 统一渲染（全局单例，不在各页重复挂）',
  /<HotkeyHelp\s+open=\{helpOpen\}/.test(appSrc));
assert('E5 跳转不自己抄一份路由表，统一从 HOTKEYS 表取',
  region(appSrc, 'const handleNavigateKey', 'useGlobalHotkeys({').includes('hotkeyRoute(id)'));

const hasKb = region(hookSrc, 'export function hasKeyboard', 'export interface HotkeyHandlers');
assert('E6 只有 H5 + 精细指针设备才启用（小程序/触屏不挂）',
  hasKb.includes("'(pointer: fine)'") && hasKb.includes('if (!isH5'));

const globalLayer = region(hookSrc, 'export function useGlobalHotkeys', 'export const HELP_EVENT');
assert('E7 全局层在冒泡阶段监听（捕获阶段留给 Esc 层栈）',
  globalLayer.includes("document.addEventListener('keydown', onKeyDown, false)"));
assert('E8 全局层先看 defaultPrevented（弹层处理过的键不再重复处理）',
  globalLayer.includes('if (e.defaultPrevented) return;'));
assert('E9 输入法组字中一律让路（中文用户按 g 是在打拼音）',
  globalLayer.includes('if (isComposing('));
assert('E10 输入态下除 whenTyping 外一律不响应',
  globalLayer.includes('if (typing && !def.whenTyping) return;'));
assert('E11 输入态里不进入序列待命（否则在输入框里打 g 会丢字符）',
  /if \(typing\) return;\s*\n\s*e\.preventDefault\(\);\s*\n\s*setPendingBoth\(seq\.pending\)/.test(globalLayer));
assert('E12 全局层不抢 ⌘Enter（提交由具体输入区决定发到哪里）',
  /if \(def\.id === 'submit'\)/.test(globalLayer));

const escLayer = region(hookSrc, 'export function useEscapeKey', '');
assert('E13 Esc 走捕获阶段（保证最上层先拿到）',
  escLayer.includes("document.addEventListener('keydown', onKeyDown, true)"));
assert('E14 只有层栈最上层响应 Esc',
  escLayer.includes('layers[layers.length - 1] !== id'));
assert('E15 Esc 处理完 stopPropagation（否则全局层还会再处理一次）',
  escLayer.includes('e.stopPropagation()'));

const focusFn = region(hookSrc, 'export function focusSearchBox', 'export function useSubmitHotkey');
assert('E16 聚焦搜索框时要跳过隐藏的旧页残留（Taro H5 会把上一页留在 DOM 里）',
  focusFn.includes('rect.width === 0'));
assert('E17 搜索框取的是 taro-input-core 内部的原生 input',
  focusFn.includes("host.querySelector('input')"));

const submitFn = region(hookSrc, 'export function useSubmitHotkey', 'const layers: string[]');
assert('E18 ⌘Enter 只在焦点位于可编辑控件时生效',
  submitFn.includes('editableInPath(path, e.target)'));

const aiSrc = read('src/components/AiAssistant/index.tsx');
assert('E19 AI 助手的输入框接上了 ⌘Enter 发送，且面板收起时关闭监听',
  /useSubmitHotkey\(handleSend, open\)/.test(aiSrc));

const inboxSrc = read('src/pages/inbox/index.tsx');
assert('E20 收件箱接上了 ⌘Enter（提取模式→AI 提取，工作模式→当前动作）',
  /useSubmitHotkey\(\(\) => \{/.test(inboxSrc)
  && /if \(mode === 'extract'\) void handleExtract\(\);/.test(inboxSrc));

const mineSrc = read('src/pages/mine/index.tsx');
assert('E21 「我的 → 键盘快捷键」入口受 hasKeyboard() 门禁（手机上不列按不了的键）',
  mineSrc.includes('{hasKeyboard() ? (') && mineSrc.includes('requestHotkeyHelp()'));

const helpSrc = read('src/components/HotkeyHelp/index.tsx');
assert('E22 帮助面板的键位来自 HOTKEYS 表，不是手抄一份',
  helpSrc.includes('HOTKEYS.filter') && !/['"]g b['"]/.test(helpSrc));
assert('E23 面板可被 Esc 关闭（走层栈，不自己再写一套监听）',
  /useEscapeKey\(onClose, open\)/.test(helpSrc));

/* ================================================================== */
console.log(`\n${'='.repeat(52)}`);
console.log(`键盘快捷键门禁：${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log('有断言失败 —— 快捷键要么按不出来，要么按了干别的事。');
  process.exit(1);
}
console.log('全部通过。');
process.exit(0);
