/**
 * 云数据库访问层（H5）—— user_kv 同步键 + llm_events 用量记账。
 *
 * 为什么需要它（2026-10-13 H5 迁移）：产品从微信小程序迁到 H5 + WorkBuddy 云后端。
 * 此前 H5 的用户数据只有 localStorage，`/api/user/data` 与 `/api/user/sync` 两个同步端点
 * 在静态托管下恒 404/501 —— **跨设备同步从未真正工作过**。本层把同步落到云数据库：
 * `user_kv`（一行一个 localStorage 同步键）+ `llm_events`（只增不改的用量事件）。
 *
 * 安全边界（平台硬规则，code-generation.md 原文）：
 *   · 身份由 `cloud.auth` 会话在请求层自动附带，**客户端绝不传 token / user id / owner_id**；
 *   · 表的 owner 列由 `DEFAULT auth.uid()` 服务端填充，RLS（owner_id = auth.uid()）兜底；
 *   · 不手写任何 `/.cloud/**` fetch —— 一律走 SDK 的 `from()` / `rpc()`。
 *
 * 失败语义：所有函数失败返回 null（不抛），调用方决定降级；
 * 但**「没登录」与「后端不可用」是两回事** —— 前者由调用方先用 getSession() 判掉，
 * 本层的 null 一律意味着真故障，值得 console.warn 留痕。
 */

import { getCloudDatabase } from './cloudAuth';
import type { DbResponse } from './cloudAuth';

/** user_kv 一行（同步键） */
export interface KvRow {
  key: string;
  value: unknown;
  /** 客户端写入时间戳（epoch ms），跨设备「新者赢」用 */
  clientTs: number;
}

/** llm_events.kind 的合法值 */
export type LlmEventKind = 'chat' | 'voice';

/** 把 SDK 信封归一：error 非空即失败（返回 null），顺带留痕 */
function unwrap<T>(res: DbResponse<T>, what: string): T | null {
  if (res.error) {
    console.warn(`[cloudDb] ${what} failed:`, res.error.code || '', res.error.message || '');
    return null;
  }
  return res.data;
}

/**
 * 读当前用户全部同步键。
 * RLS 保证只返回自己的行；未登录时数据库侧直接拒绝（返回 null）。
 * signal 供调用方做拉取超时（SDK 构建器原生支持 abortSignal）。
 */
export async function kvGetAll(signal?: AbortSignal): Promise<KvRow[] | null> {
  const db = await getCloudDatabase();
  if (!db) return null;
  let q = db.from('user_kv').select('key, value, client_ts').order('key');
  if (signal) q = q.abortSignal(signal);
  const res = await q;
  const rows = unwrap(res, 'kvGetAll');
  if (!rows) return null;
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      key: String(row.key || ''),
      value: row.value,
      clientTs: Number(row.client_ts) || 0
    };
  });
}

/**
 * 批量 upsert 同步键（一次推送一条 RPC，避免 N 次往返）。
 * 服务端「新者赢」：仅当 incoming ts > 已存 ts 才覆盖 —— 旧设备离线后的陈旧推送
 * 不会盖掉新设备已写入的新值。返回实际写入行数；0 = 全部被更新的远端版本挡住（正常）。
 */
export async function kvSetMany(items: Array<{ key: string; value: unknown; ts: number }>): Promise<number | null> {
  if (items.length === 0) return 0;
  const db = await getCloudDatabase();
  if (!db) return null;
  const payload = items.map((it) => ({ key: it.key, value: it.value, ts: it.ts }));
  const res = await db.rpc<number>('kv_set_many', { p_items: payload });
  const n = unwrap(res, 'kv_set_many');
  return typeof n === 'number' ? n : null;
}

/** 清空当前用户全部同步键（注销账号 / 清除云端数据）。返回删除行数。 */
export async function kvClear(): Promise<number | null> {
  const db = await getCloudDatabase();
  if (!db) return null;
  const res = await db.rpc<number>('kv_clear', {});
  const n = unwrap(res, 'kv_clear');
  return typeof n === 'number' ? n : null;
}

/** 记一条 LLM 用量事件（chat / voice）。只增不改，配额无法被抹掉。 */
export async function llmEventInsert(kind: LlmEventKind): Promise<boolean> {
  const db = await getCloudDatabase();
  if (!db) return false;
  const res = await db.from('llm_events').insert({ kind });
  return unwrap(res, 'llm_events insert') !== null;
}

/** 本月该类用量计数（sinceISO = 当月第一天 ISO）。count 查询不取行。 */
export async function llmEventCount(kind: LlmEventKind, sinceISO: string): Promise<number | null> {
  const db = await getCloudDatabase();
  if (!db) return null;
  const res = await db
    .from('llm_events')
    .select('*', { count: 'exact', head: true })
    .eq('kind', kind)
    .gte('created_at', sinceISO);
  if (res.error) {
    console.warn('[cloudDb] llm_events count failed:', res.error.code || '', res.error.message || '');
    return null;
  }
  return typeof res.count === 'number' ? res.count : null;
}
