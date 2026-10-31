/**
 * 云数据库访问层（H5）—— user_kv 同步键 + llm_events 用量记账 + feedback 用户反馈。
 *
 * 为什么需要它（2026-10-13 H5 迁移）：产品从微信小程序迁到 H5 + WorkBuddy 云后端。
 * 此前 H5 的用户数据只有 localStorage，`/api/user/data` 与 `/api/user/sync` 两个同步端点
 * 在静态托管下恒 404/501 —— **跨设备同步从未真正工作过**。本层把同步落到云数据库：
 * `user_kv`（一行一个 localStorage 同步键）+ `llm_events`（只增不改的用量事件）；
 * 2026-10-24 起新增 `feedback` 表直插（用户反馈此前在 H5 只能走邮件兜底）。
 *
 * 安全边界（平台硬规则，code-generation.md 原文）：
 *   · 身份由 `cloud.auth` 会话在请求层自动附带，**客户端绝不传 token / user id / owner_id**；
 *   · 表的 owner 列由 `DEFAULT auth.uid()` 服务端填充，RLS（owner_id = auth.uid()）兜底；
 *   · 不手写任何 `/.cloud/**` fetch —— 一律走 SDK 的 `from()` / `rpc()`。
 *
 * 失败语义：所有函数失败返回 null（不抛），调用方决定降级；
 * 但**「没登录」与「后端不可用」是两回事** —— 前者由调用方先用 getSession() 判掉，
 * 本层的 null 一律意味着真故障，值得 console.error 留痕（铁律：console.warn 会被
 * 生产构建剔除，留痕必须用 console.error）。
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
    // console.error 而非 console.warn：后者会被生产构建剔除，线上零痕迹（铁律）
    console.error(`[cloudDb] ${what} failed:`, res.error.code || '', res.error.message || '');
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

/**
 * 清偿当前用户在 H5 自有三表的注销残留（llm_events / feedback / client_errors，I3b）。
 *
 * 走 SECURITY DEFINER 的 `purge_my_h5_data`（上线 SQL：.tools/sql/v3-h5-purge.sql，
 * 由主理人在平台控制台执行后才存在）。**灰度顺序是刻意的**：先发客户端、再执行 SQL——
 * 函数未部署时 PostgREST 返回 PGRST202，本函数如实返回 'not-deployed'，调用方静默跳过，
 * 线上行为与未接此函数时完全一致（零破坏）；只有真实错误才 console.error 留痕。
 * 返回值是状态不是布尔——什么时候都不能把「没删成」说成「已清除」。
 */
export async function purgeMyH5Data(): Promise<'ok' | 'not-deployed' | 'failed' | 'no-db'> {
  const db = await getCloudDatabase();
  if (!db) return 'no-db';
  const res = await db.rpc<{ purged?: boolean }>('purge_my_h5_data', {});
  if (res.error) {
    if (res.error.code === 'PGRST202') return 'not-deployed';
    console.error('[cloudDb] purge_my_h5_data failed:', res.error.code || '', res.error.message || '');
    return 'failed';
  }
  return 'ok';
}

/** 记一条 LLM 用量事件（chat / voice）。只增不改，配额无法被抹掉。 */
export async function llmEventInsert(kind: LlmEventKind): Promise<boolean> {
  const db = await getCloudDatabase();
  if (!db) return false;
  const res = await db.from('llm_events').insert({ kind });
  return unwrap(res, 'llm_events insert') !== null;
}

/** feedback 提交输入（与 apiSubmitFeedback 入参一致） */
export interface FeedbackInput {
  type: 'suggestion' | 'data' | 'account' | 'other';
  content: string;
  contact?: string;
  page?: string;
}

/**
 * 落一条用户反馈（H5 通道，2026-10-24 接通）。
 *
 * 直接 insert `feedback` 表（平台 code-generation.md 的 INSERT 范式），**不是** RPC：
 *   · owner_id 不传 —— `DEFAULT auth.uid()` 服务端填充；RLS 两条策略（insert-own /
 *     select-own）都只 TO authenticated；匿名访客对表无 GRANT，实测 42501 拒绝
 *     （2026-10-24 探针），不存在 client_errors 那种「匿名共主 'anon' 互读」问题；
 *   · 类型白名单 / 长度上限由表级 CHECK 约束强制（对齐微信云函数 feedback 的校验，
 *     客户端被绕过也写不进脏数据）；
 *   · H5 强制登录（needsAuthGate），走到这里的都是真实会话。
 *
 * 失败返回 false（不抛）—— 调用方（apiSubmitFeedback）据此走「复制内容 + 邮件」的诚实降级。
 */
export async function feedbackInsert(input: FeedbackInput): Promise<boolean> {
  const db = await getCloudDatabase();
  if (!db) return false;
  const res = await db.from('feedback').insert({
    type: input.type,
    content: input.content,
    contact: input.contact || '',
    page: input.page || ''
  });
  return unwrap(res, 'feedback insert') !== null;
}

/** 客户端崩溃上报的一条内容（字段与 `log_client_error` 入参一一对应） */
export interface ClientErrorInput {
  message: string;
  stack?: string;
  page?: string;
  channel?: string;
  ua?: string;
}

/**
 * 写一条客户端崩溃日志（H5 通道）。
 *
 * 走 `log_client_error` 这个 `SECURITY DEFINER` 函数，**不是**直接 insert 表 ——
 * 原因（2026-10-23 实测，别改回去）：
 *   · 未登录访客的 `auth.uid()` 返回字面量 `'anon'`，所有匿名访客**共用同一个 owner**。
 *     若给表上 `owner_id = auth.uid()` 的 SELECT 策略，任何匿名访客都能读到**全部匿名用户的
 *     崩溃日志**（实测确实读到了），这是真实的隐私泄露。
 *   · 所以 `client_errors` 对 authenticated/anon **已 REVOKE 全部表权限**、RLS 下无任何策略，
 *     客户端只能通过这个只写不读、返回 void 的函数落库，读只能由管理端做。
 *   · 因此这里**不能**改成 `db.from('client_errors').insert(...)`，那样会 42501。
 *
 * 失败返回 false（不抛）—— 崩溃上报失败绝不能反过来影响主流程。
 */
export async function clientErrorInsert(input: ClientErrorInput): Promise<boolean> {
  const db = await getCloudDatabase();
  if (!db) return false;
  const res = await db.rpc<void>('log_client_error', {
    p_message: input.message,
    p_stack: input.stack ?? '',
    p_page: input.page ?? '',
    p_channel: input.channel ?? 'h5',
    p_ua: input.ua ?? ''
  });
  // 函数返回 void → data 恒为 null，所以**不能**用 unwrap（它会把它当成失败）。只认 error。
  if (res.error) {
    // 用 console.error：生产构建会剔除 console.warn（见 src/app.tsx 既有约定）
    console.error('[cloudDb] log_client_error failed:', res.error.code || '', res.error.message || '');
    return false;
  }
  return true;
}
