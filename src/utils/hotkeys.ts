/**
 * hotkeys.ts —— 桌面端键盘快捷键的**唯一事实源**（纯逻辑，无副作用）。
 *
 * 为什么自己写一个匹配器，而不是装 hotkeys-js / react-hotkeys-hook / tinykeys：
 *   1. 绑定只有十来个，库的体积与依赖收益抵不过「weapp 目标会白打进去」的成本
 *      —— 小程序端压根没有物理键盘，这些代码只该出现在 H5 产物里。
 *   2. 本仓有三条**库不默认提供**的规则，且都必须能离线验证：
 *      · 中文输入法组字中（`isComposing`）一律让路 —— 拼音打「g」不能跳页面；
 *      · 输入框聚焦时除 Esc / ⌘Enter 外全部让路；
 *      · 弹层打开时全局键让路（只留 Esc）。
 *   3. 匹配逻辑做成纯函数后可以在 Node 里直接跑真值表（`verify:hotkeys`），
 *      比「装库 + 起浏览器点一遍」更可验证、更快、也更容易配变异用例。
 *   搜过的方案与结论写在 docs/键盘快捷键-2026-10-27.md。
 *
 * 设计铁律：**绝不劫持浏览器/系统已占用的组合**（见 RESERVED）。
 *   自作聪明绑 mod+T / mod+W 的结果是「用户想开新标签页，结果跳到了别的页面」——
 *   这种冒犯比没有快捷键更糟。
 */

import type { LangKey } from '@/store/language';

/** 快捷键作用域：通用 / 跳转 / 输入态 */
export type HotkeyGroup = 'general' | 'navigate' | 'input';

export interface HotkeyDef {
  id: HotkeyId;
  group: HotkeyGroup;
  /**
   * 键组合。`mod` = Mac 的 ⌘ / 其它平台的 Ctrl（由 isMacPlatform 归一）。
   * 含空格表示**序列**：`'g b'` = 先按 g 再按 b（GitHub 式跳转手势）。
   */
  chord: string;
  /** 帮助面板里的说明文案 key（中英都在 language.ts） */
  labelKey: LangKey;
  /** 输入框聚焦时是否仍然生效。
   * 默认 false —— 在输入框里还能触发全局跳转是最典型的「打字打着打着页面跳走了」。
   */
  whenTyping?: boolean;
  /**
   * 跳转目标（仅 navigate 组）。路由字符串放在这张表里而不是散在 app.tsx 的 switch 中：
   * 改页面路径时只有一处要改，而且 verify:hotkeys 能直接断言「每个跳转键都有真实存在的页面」。
   */
  route?: string;
}

export type HotkeyId =
  | 'help'
  | 'escape'
  | 'search'
  | 'goBriefing'
  | 'goInbox'
  | 'goHotspot'
  | 'goCalendar'
  | 'goMine'
  | 'submit';

/**
 * 快捷键表。**帮助面板、全局层、门禁都读这一份**，不许各写一版
 * （历史上「文案说支持 ⌘K，代码里其实绑的是 ⌘/」这类漂移，都是复制出来的）。
 *
 * 选键依据（对齐桌面端既有习惯，不自创）：
 *   · `?` 打开帮助 —— GitHub / Gmail / Linear / Notion 的通用约定
 *   · `/` 聚焦搜索 —— GitHub / X / YouTube 的通用约定（且不占浏览器任何组合键）
 *   · `g` + 字母 跳转 —— GitHub 的序列手势，裸字母只在按过 g 之后短时间生效
 *   · `Esc` 关闭最上层 —— 系统级约定
 *   · `⌘/Ctrl + Enter` 提交 —— 聊天/邮件客户端的通用约定
 */
export const HOTKEYS: HotkeyDef[] = [
  { id: 'help', group: 'general', chord: '?', labelKey: 'hotkeys.help' },
  { id: 'search', group: 'general', chord: '/', labelKey: 'hotkeys.search' },
  { id: 'escape', group: 'general', chord: 'escape', labelKey: 'hotkeys.escape', whenTyping: true },
  // id 用列表里用户看得到的名字（热点），不用目录名（pages/library）——
  // 否则帮助面板与 onNavigate 的 switch 会各叫一个名字，改路由时容易漏改一处。
  { id: 'goBriefing', group: 'navigate', chord: 'g b', labelKey: 'hotkeys.goBriefing', route: '/pages/briefing/index' },
  { id: 'goInbox', group: 'navigate', chord: 'g i', labelKey: 'hotkeys.goInbox', route: '/pages/inbox/index' },
  { id: 'goHotspot', group: 'navigate', chord: 'g h', labelKey: 'hotkeys.goHotspot', route: '/pages/library/index' },
  { id: 'goCalendar', group: 'navigate', chord: 'g c', labelKey: 'hotkeys.goCalendar', route: '/pages/calendar/index' },
  { id: 'goMine', group: 'navigate', chord: 'g m', labelKey: 'hotkeys.goMine', route: '/pages/mine/index' },
  { id: 'submit', group: 'input', chord: 'mod+enter', labelKey: 'hotkeys.submit', whenTyping: true }
];

/** 序列手势前缀按完后，等待第二个键的时长（毫秒）。超过就当作普通按键，不跳页。 */
export const SEQUENCE_TIMEOUT_MS = 1200;

/**
 * 浏览器与操作系统保留的组合。绑了也收不到，或者收到也不该拦 ——
 * 这里额外列出来是为了让「有人想绑 mod+w」这种事在 `verify:hotkeys` 里直接红。
 */
export const RESERVED = [
  'mod+t',
  'mod+n',
  'mod+w',
  'mod+shift+t',
  'mod+shift+n',
  'mod+l',
  'mod+r',
  'mod+shift+r',
  'mod+f',
  'mod+p',
  'mod+s',
  'mod+c',
  'mod+v',
  'mod+x',
  'mod+a',
  'mod+z',
  'mod+shift+z',
  'mod+y',
  'f5',
  'f11',
  'f12'
];

/** 只取判断需要的字段，便于在 Node 里用普通对象造事件（不必 new KeyboardEvent）。 */
export interface KeyLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  /** 输入法组字中（拼音/五笔正在候选） */
  isComposing?: boolean;
  /** 部分浏览器在组字期间给 'Process' */
  keyCode?: number;
}

/** Mac / iOS 用 ⌘，Windows / Linux 用 Ctrl。SSR 与 Node 环境下退回「非 Mac」。 */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const p = nav.userAgentData?.platform || nav.platform || '';
  // iPadOS 的 platform 是 'MacIntel'，但它没有物理键盘场景，误判成 Mac 也无害
  return /mac/i.test(p);
}

/** 输入法正在组字：此时任何快捷键都不该触发（中文用户按 g 是在打拼音）。 */
export function isComposing(e: KeyLike): boolean {
  return e.isComposing === true || e.keyCode === 229 || e.key === 'Process';
}

/** 焦点是否在可编辑控件里。用 composedPath 兼容 Taro 自定义元素内部的原生 input。 */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as (HTMLElement & { tagName?: string }) | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return false;
}

/**
 * 把事件里的 tagName 挖出来 —— Taro H5 的 Input 是 `<taro-input-core>`，
 * 真实 `<input>` 在它内部；事件 target 可能是任一层的自定义元素，
 * 所以沿 composedPath 找第一个可编辑节点。
 */
export function editableInPath(path: EventTarget[] | undefined, target: EventTarget | null): boolean {
  if (path && path.length > 0) {
    for (const node of path) {
      if (isEditableTarget(node)) return true;
    }
  }
  return isEditableTarget(target);
}

const NAMED_KEYS: Record<string, string> = {
  Esc: 'escape',
  Escape: 'escape',
  Enter: 'enter',
  ' ': 'space',
  Spacebar: 'space',
  ArrowUp: 'arrowup',
  ArrowDown: 'arrowdown',
  ArrowLeft: 'arrowleft',
  ArrowRight: 'arrowright',
  Tab: 'tab'
};

/** 归一化 `event.key`：单字符转小写，命名键转小写全名。 */
export function normalizeKey(key: string): string {
  if (!key) return '';
  if (NAMED_KEYS[key]) return NAMED_KEYS[key];
  return key.length === 1 ? key.toLowerCase() : key.toLowerCase();
}

/** 拆解 chord：`'mod+shift+k'` → { mod, shift, alt, key: 'k' }；序列只拆第一段。 */
export function parseChord(chord: string): { mod: boolean; shift: boolean; alt: boolean; key: string } {
  const first = chord.trim().split(/\s+/)[0] || '';
  const parts = first.toLowerCase().split('+');
  const key = parts[parts.length - 1];
  return {
    mod: parts.includes('mod'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt'),
    key: normalizeKey(key)
  };
}

/**
 * 这个按键是否**精确**命中该 chord（单段）。
 *
 * 三条容易写错的地方，这里都钉住：
 *   1. 平台归一：Mac 认 metaKey，其它平台认 ctrlKey，另一个必须**没按** ——
 *      否则 Mac 上按 Ctrl+K 也会触发 ⌘K 的行为。
 *   2. 字符键不校验 shift：`?` 本身就是 shift+/ 打出来的（`e.key` 已经是 '?'），
 *      再去要求 shiftKey 会把唯一的触发条件排除掉。字母键则必须校验。
 *   3. 多余的修饰键视为不匹配：⌘K 与 ⌘⇧K 是两件事。
 */
export function matchChord(e: KeyLike, chord: string, isMac: boolean): boolean {
  const want = parseChord(chord);
  const key = normalizeKey(e.key);
  if (key !== want.key) return false;

  const primary = isMac ? e.metaKey === true : e.ctrlKey === true;
  const secondary = isMac ? e.ctrlKey === true : e.metaKey === true;
  if (want.mod !== primary) return false;
  if (secondary) return false; // 另一个平台的修饰键按着 → 不是给我们的
  if (want.alt !== (e.altKey === true)) return false;

  // 字符键（? / / 之类）的 shift 状态由 e.key 自己体现，不再校验
  const isChar = want.key.length === 1 && !/[a-z0-9]/.test(want.key);
  if (!isChar && want.shift !== (e.shiftKey === true)) return false;

  return true;
}

/** 是否踩了浏览器保留键（同样的 resolve 口径，避免两处判断漂移）。 */
export function isReservedChord(chord: string): boolean {
  const want = parseChord(chord);
  return RESERVED.some((r) => {
    const p = parseChord(r);
    return p.key === want.key && p.mod === want.mod && p.shift === want.shift && p.alt === want.alt;
  });
}

/** 表里所有单段手势（用于全局层直接匹配）与序列手势（用于前缀状态机）。 */
export function singleKeyHotkeys(): HotkeyDef[] {
  return HOTKEYS.filter((h) => !h.chord.includes(' '));
}
export function sequencePrefixes(): string[] {
  const set = new Set<string>();
  for (const h of HOTKEYS) {
    if (h.chord.includes(' ')) set.add(h.chord.split(/\s+/)[0]);
  }
  return [...set];
}

export interface SequenceHit {
  /** 命中的快捷键 id；没命中为 null */
  hit: HotkeyId | null;
  /** 下一轮的待命前缀（'' 表示清空） */
  pending: string;
  /** 是否吃掉了这次按键（前缀或命中都算吃掉，需 preventDefault） */
  consumed: boolean;
}

/**
 * 序列手势状态机（纯函数，状态由调用方持有，便于单测）。
 *
 * `pending` 是上一轮按下的前缀（如 'g'）；本次 key 若与 `g b` 的第二段匹配就返回 hit。
 * 前缀本身也「吃掉」这次按键 —— 否则按 g 会被页面当成普通字符处理。
 */
export function resolveSequence(pending: string, e: KeyLike, isMac: boolean): SequenceHit {
  const key = normalizeKey(e.key);

  if (pending) {
    const target = HOTKEYS.find((h) => {
      const seg = h.chord.split(/\s+/);
      return seg.length === 2 && seg[0] === pending && matchChord(e, seg[1], isMac);
    });
    // 无论命中与否，前缀都在这一击后被消费掉：`g` 后面跟了别的键 = 用户没打算跳转
    return { hit: target?.id ?? null, pending: '', consumed: true };
  }

  const isPrefix = sequencePrefixes().some((p) => matchChord(e, p, isMac) && key === normalizeKey(p));
  if (isPrefix) return { hit: null, pending: key, consumed: true };

  return { hit: null, pending: '', consumed: false };
}

/** 帮助面板用的键帽拆解：`mod+k` → ['⌘','K']（Mac）或 ['Ctrl','K']。 */
export function formatChord(chord: string, isMac: boolean): string[] {
  const c = chord.trim();
  if (!c.includes(' ') && c.includes('+')) {
    const parts = c.toLowerCase().split('+');
    return parts.map((p) => {
      if (p === 'mod') return isMac ? '⌘' : 'Ctrl';
      if (p === 'shift') return isMac ? '⇧' : 'Shift';
      if (p === 'alt') return isMac ? '⌥' : 'Alt';
      if (p === 'enter') return 'Enter';
      if (p === 'escape') return 'Esc';
      return p.toUpperCase();
    });
  }
  if (c === 'escape') return ['Esc'];
  if (c === 'enter') return ['Enter'];
  if (c === 'space') return ['Space'];
  return [c.toUpperCase()];
}

/** 跳转键对应的 tabBar 路由；非跳转键返回 null。 */
export function hotkeyRoute(id: HotkeyId): string | null {
  const def = HOTKEYS.find((h) => h.id === id);
  return def?.route ?? null;
}

/** 序列手势拆成两组键帽，帮助面板按「G 然后 B」渲染。 */
export function formatSequence(chord: string, isMac: boolean): string[][] {
  if (!chord.includes(' ')) return [formatChord(chord, isMac)];
  return chord
    .trim()
    .split(/\s+/)
    .map((seg) => formatChord(seg, isMac));
}
