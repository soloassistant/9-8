/**
 * useHotkeys.ts —— 全局键盘层的副作用壳（逻辑全在 utils/hotkeys.ts，这里只负责接线）。
 *
 * 分层规则（三条，都有门禁守着）：
 *   1. **只在 H5 + 有物理指针设备时启用**。小程序端与手机浏览器没有物理键盘，
 *      挂上去只会白占内存；`(pointer: fine)` 是判断「能点得准」的标准信号。
 *   2. **输入态让路**：焦点在 input/textarea/contenteditable 里时，除 `whenTyping` 的
 *      少数几个（Esc / ⌘Enter）外一律不响应。否则用户打拼音打到一半页面跳走了。
 *   3. **弹层优先**：Esc 由 `useEscapeKey` 在**捕获阶段**处理并 stopPropagation，
 *      全局层看到 `defaultPrevented` 就直接退出 —— 所以 Esc 永远先关最上层那一层。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Taro from '@tarojs/taro';
import {
  HOTKEYS,
  SEQUENCE_TIMEOUT_MS,
  editableInPath,
  isComposing,
  isMacPlatform,
  matchChord,
  resolveSequence,
  singleKeyHotkeys
} from '@/utils/hotkeys';
import type { HotkeyId, KeyLike } from '@/utils/hotkeys';

const isH5 = process.env.TARO_ENV === 'h5';

/** 有物理键盘的桌面环境。触屏笔记本（pointer: coarse 主指针）走触摸路径，不启用。 */
export function hasKeyboard(): boolean {
  if (!isH5 || typeof window === 'undefined' || !window.matchMedia) return false;
  try {
    return window.matchMedia('(pointer: fine)').matches;
  } catch {
    return false;
  }
}

export interface HotkeyHandlers {
  onHelp: () => void;
  onSearch: () => void;
  onNavigate: (id: HotkeyId) => void;
}

interface Options extends HotkeyHandlers {
  /** 登录页等不该响应快捷键的场景 */
  enabled?: boolean;
}

/**
 * 全局快捷键层。只该在 app.tsx 挂一次。
 *
 * 返回当前的序列前缀（'g' 或 ''），供调试与门禁观察；
 * 正常 UI 不需要它 —— 前缀是即时状态，不做视觉提示（GitHub 也不提示）。
 */
export function useGlobalHotkeys({ onHelp, onSearch, onNavigate, enabled = true }: Options): string {
  const [pending, setPending] = useState('');
  const pendingRef = useRef('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMac = useRef(false);

  // ref 里保存最新的回调，避免因为回调身份变化反复重绑监听
  const handlersRef = useRef({ onHelp, onSearch, onNavigate });
  handlersRef.current = { onHelp, onSearch, onNavigate };

  const setPendingBoth = useCallback((v: string) => {
    pendingRef.current = v;
    setPending(v);
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!isH5 || !enabled || !hasKeyboard()) return;
    isMac.current = isMacPlatform();

    const onKeyDown = (e: KeyboardEvent) => {
      // 弹层已经处理过这一击（useEscapeKey 在捕获阶段拦下并 preventDefault）
      if (e.defaultPrevented) return;
      // 输入法组字中：拼音打「g」不是跳转手势
      if (isComposing(e as unknown as KeyLike)) return;
      if (!e.key) return;

      const typing = editableInPath(
        typeof e.composedPath === 'function' ? e.composedPath() : undefined,
        e.target
      );

      // 序列前缀优先：处于待命态时，下一击只用于完成/取消手势
      if (pendingRef.current) {
        const r = resolveSequence(pendingRef.current, e as unknown as KeyLike, isMac.current);
        clearTimer();
        setPendingBoth('');
        if (r.hit) {
          e.preventDefault();
          const def = HOTKEYS.find((h) => h.id === r.hit);
          if (def && typing && !def.whenTyping) return;
          handlersRef.current.onNavigate(r.hit);
          return;
        }
        if (r.consumed) {
          e.preventDefault();
          return;
        }
        return;
      }

      for (const def of singleKeyHotkeys()) {
        if (!matchChord(e as unknown as KeyLike, def.chord, isMac.current)) continue;
        // 输入态：只有明确允许的键（Esc / ⌘Enter）才继续
        if (typing && !def.whenTyping) return;

        if (def.id === 'escape') {
          // 没有弹层处理过的 Esc：把焦点从输入框里放出来，交还给页面
          const active = document.activeElement as HTMLElement | null;
          if (active && typeof active.blur === 'function') active.blur();
          return;
        }
        if (def.id === 'submit') {
          // ⌘Enter 交给具体输入区自己处理（它知道提交到哪），全局层不插手
          return;
        }

        e.preventDefault();
        if (def.id === 'help') handlersRef.current.onHelp();
        else if (def.id === 'search') handlersRef.current.onSearch();
        return;
      }

      // 没命中任何单键手势：看看是不是序列前缀（g）
      const seq = resolveSequence('', e as unknown as KeyLike, isMac.current);
      if (seq.pending) {
        // 输入态里不进入待命（否则在输入框里打 g 会被吃掉一个字符）
        if (typing) return;
        e.preventDefault();
        setPendingBoth(seq.pending);
        clearTimer();
        timerRef.current = setTimeout(() => setPendingBoth(''), SEQUENCE_TIMEOUT_MS);
      }
    };

    document.addEventListener('keydown', onKeyDown, false);
    return () => {
      document.removeEventListener('keydown', onKeyDown, false);
      clearTimer();
    };
  }, [enabled, setPendingBoth, clearTimer]);

  // 路由变化时清掉待命前缀：切页后按 b 不该接着上一个 g
  useEffect(() => {
    const reset = () => {
      clearTimer();
      setPendingBoth('');
    };
    // Taro 的 eventCenter.on 类型签名返回 void（不是取消订阅函数），
    // 所以只能用 off 解绑 —— 别照抄 React 里「on 返回 unsub」的写法。
    Taro.eventCenter.on('__taroRouterChange', reset);
    return () => {
      Taro.eventCenter.off('__taroRouterChange', reset);
    };
  }, [clearTimer, setPendingBoth]);

  return pending;
}

/* ================================================================== */
/* 页面级动作：聚焦搜索 / ⌘Enter 提交                                     */
/* ================================================================== */

/**
 * 「打开快捷键面板」的应用级事件。
 * 面板状态在 App 里（它是全局单例），二级页只能通过事件请求 ——
 * 不把面板提到 zustand 里，是因为它没有跨页共享的状态，只有「开/关」这一下。
 */
export const HELP_EVENT = 'hotkey:help';

export function requestHotkeyHelp(): void {
  if (!isH5) return;
  Taro.eventCenter.trigger(HELP_EVENT);
}

/**
 * 聚焦页面上**当前可见**的搜索框，成功返回 true。
 *
 * 两个必须处理的坑：
 *   1. Taro H5 的 `<Input>` 外层是自定义元素 `<taro-input-core>`，className 落在它身上，
 *      真正的 `<input>` 在内部 —— 所以要先找外壳再往里取。
 *   2. Taro H5 会把**上一个页面留在 DOM 里**（stationed），直接 querySelector 可能抓到
 *      已经看不见的旧搜索框，focus 上去毫无反应。所以要求元素有非零尺寸。
 */
export function focusSearchBox(): boolean {
  if (typeof document === 'undefined') return false;
  const boxes = document.querySelectorAll('[class*="searchInput"], input[type="search"]');
  for (const node of Array.from(boxes)) {
    const host = node as HTMLElement;
    const input = (host.tagName === 'INPUT' ? host : host.querySelector('input')) as HTMLInputElement | null;
    if (!input) continue;
    const rect = input.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue; // 隐藏的旧页残留
    input.focus();
    input.select();
    return true;
  }
  return false;
}

/**
 * ⌘/Ctrl + Enter 提交（输入区自己挂，全局层对 `submit` 直接 return，不抢）。
 *
 * 只在**焦点位于可编辑控件**时生效：与聊天客户端的直觉一致，
 * 而「焦点在别处按 ⌘Enter 就把内容发出去」是危险的（用户以为在翻页）。
 */
export function useSubmitHotkey(onSubmit: () => void, enabled = true): void {
  const cbRef = useRef(onSubmit);
  cbRef.current = onSubmit;

  useEffect(() => {
    if (!isH5 || !enabled) return;
    const isMac = isMacPlatform();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (isComposing(e as unknown as KeyLike)) return;
      if (!matchChord(e as unknown as KeyLike, 'mod+enter', isMac)) return;
      const path = typeof e.composedPath === 'function' ? e.composedPath() : undefined;
      if (!editableInPath(path, e.target)) return;
      e.preventDefault();
      cbRef.current();
    };
    document.addEventListener('keydown', onKeyDown, false);
    return () => document.removeEventListener('keydown', onKeyDown, false);
  }, [enabled]);
}

/* ================================================================== */
/* Esc 层栈：只关最上面那一层                                            */
/* ================================================================== */

/**
 * 层的登记表。用模块级数组而不是 React context：
 *   · Esc 是**全局**手势，与组件树位置无关（弹层可能被 portal 到别处）；
 *   · 只有「谁在最上面」这一个信息，context 的收益抵不过它的样板代码。
 * 数组末尾 = 最上层。
 */
const layers: string[] = [];
let layerSeq = 0;

/** 仅供门禁/测试观察层栈状态，业务代码不要用。 */
export function __layerSnapshot(): string[] {
  return [...layers];
}

/**
 * Esc 关闭最上层弹层。
 *
 * 为什么用**捕获阶段**：多个弹层可能同时挂载（弹窗里再开弹窗），
 * 捕获阶段 + stopPropagation 能保证只有一个处理者，且是最后挂载的那个（= 最上层）。
 */
export function useEscapeKey(onClose: () => void, active = true): void {
  const idRef = useRef(`esc-layer-${++layerSeq}`);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!isH5 || !active) return;
    const id = idRef.current;
    layers.push(id);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'Esc') return;
      if (isComposing(e as unknown as KeyLike)) return;
      if (layers[layers.length - 1] !== id) return; // 不是最上层：让下面的层去处理
      e.preventDefault();
      e.stopPropagation();
      closeRef.current();
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      const i = layers.lastIndexOf(id);
      if (i >= 0) layers.splice(i, 1);
    };
  }, [active]);
}
