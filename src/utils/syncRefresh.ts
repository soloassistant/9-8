/**
 * 远端变更到达时，当前页面该不该立刻重读（2026-11-05，SY-03）。
 *
 * 抽成纯函数是为了能跑断言（不需要 React / 真机）：`utils/syncRefresh.ts` 无任何运行时依赖，
 * 可以被门禁脚本直接打包调用。判定口径：
 *   · 本页不关心的 key → ignore（避免全站每次拉取后都重读）
 *   · 命中且用户正在编辑既有数据 → defer（storage 已更新，退出编辑后由页面自身/useDidShow 补上）
 *   · 命中且不在编辑 → refresh
 *
 * 注意 `editing` 指的是「正在编辑既有条目」，不是「输入框里有字」：
 * 新建输入态允许刷新，因为刷新只重读列表，不碰表单 state，输入内容不会丢。
 */
export type SyncRefreshDecision = 'refresh' | 'defer' | 'ignore';

export function decideSyncRefresh(input: {
  changed: readonly string[];
  watched: readonly string[];
  editing: boolean;
}): SyncRefreshDecision {
  if (!input.changed.some((k) => input.watched.includes(k))) return 'ignore';
  if (input.editing) return 'defer';
  return 'refresh';
}
