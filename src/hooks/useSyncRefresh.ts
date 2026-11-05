import { useEffect, useRef } from 'react';
import { subscribeSyncApplied } from '@/services/cloudSync';
import { decideSyncRefresh } from '@/utils/syncRefresh';

/**
 * 订阅「远端变更已写入本机」，按 key 白名单触发页面重读（2026-11-05，SY-03）。
 *
 * 解决的问题：轮询补上拉取后，`applyRemoteData` 只写 localStorage，已打开的页面仍显示旧内存值。
 * 这里不做 `location.reload()`：只调用页面自己的 load/reload，保留滚动位置与输入 state。
 *
 * - `watched` 传页面真正关心的 key；其它键的变化不触发，避免每次拉取都全站重读。
 * - `options.editing` 返回 true 时延后（defer）：不把用户正在编辑的那一行从眼前抽走。
 * - 回调与白名单都放在 ref 里：hook 只订阅一次，页面重渲染不会反复解绑重绑。
 */
export function useSyncRefresh(
  watched: readonly string[],
  refresh: () => void,
  options?: { editing?: () => boolean }
): void {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const editingRef = useRef(options?.editing);
  editingRef.current = options?.editing;
  const watchedRef = useRef(watched);
  watchedRef.current = watched;

  useEffect(
    () =>
      subscribeSyncApplied((keys) => {
        const outcome = decideSyncRefresh({
          changed: keys,
          watched: watchedRef.current,
          editing: !!editingRef.current?.()
        });
        if (outcome === 'refresh') refreshRef.current();
      }),
    []
  );
}
