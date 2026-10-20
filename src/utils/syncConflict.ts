/**
 * 跨设备同步冲突判定（纯函数，2026-10-19）。
 *
 * 背景：cloudSync 的策略是 per-key「新者赢」—— 服务端只保留 clientTs 最新的版本，
 * 拉取时远端较新就覆盖本地。此前的盲区：**本机有尚未推送的修改**时，一次拉取会
 * 把它静默覆盖掉（用户在 A 设备改完没同步，在 B 设备登录一拉，A 的修改凭空消失，
 * 且没有任何提示）。本模块把「该不该覆盖」的判定抽成纯函数，供 cloudSync 调用。
 *
 * 核心概念：
 * - `confirmedHash`：某个 key **上次成功推送的值**的哈希（cloudSync 持久化在
 *   `cloud-sync-confirm`）。它回答唯一一个问题：「本地现在的值，相对上次推上去的变了没有」。
 * - 判定矩阵（remoteTs > metaTs，即远端确实更新时）：
 *   · 本地没有这个键                     → `restore`   直接落地，没什么可丢的
 *   · 本地值 == 上次推送的值（无新修改）  → `overwrite` 安全覆盖（旧版车上掉的那份已推走）
 *   · 本地值 != 上次推送的值（有新修改）  → `conflict`  **不覆盖任何一端**，交用户裁决
 *
 * 为什么哈希而不是直接比较值：确认表要落 localStorage，存整份值会让元数据与数据等量；
 * 且 JSONB 回包的对象键序与本地写入序不一定一致，故用**规范化序列化**后再哈希，
 * 「内容相同、键序不同」视为未修改，避免把正常同步误报成冲突。
 */

/** 待裁决的同步冲突（持久化在 localStorage，刷新页面不丢提示） */
export interface SyncConflict {
  /** 同步键（SYNC_KEYS 之一） */
  key: string;
  /** 云端版本的写入时间（另一台设备的写入） */
  remoteTs: number;
  /** 云端版本的值快照（「采用云端」时落地用） */
  remoteValue: unknown;
  /** 发现冲突时本机版本的写入时间 */
  localTs: number;
  /** 冲突记录时间（epoch ms） */
  at: number;
}

/**
 * 规范化 JSON 序列化：对象键按字典序输出。
 * 只服务于哈希（值相等判定），不要求可读性；循环引用会抛错，由调用方的 try 兜底。
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/**
 * 值哈希：FNV-1a 32 位 + 输入长度前缀。
 * 长度前缀让「不同内容但同哈希串长」这类碰撞面再降一档；纯变更检测用途，
 * 不承担安全对抗，故不用 SHA 之类重算法（每次写入都要算，值可能上百条）。
 */
export function valueHash(value: unknown): string {
  let s: string;
  try {
    s = stableStringify(value);
  } catch {
    s = String(value); // 循环引用等极端情况：退化成 toString，至少不会抛
  }
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${s.length}:${(h >>> 0).toString(36)}`;
}

/** 拉取判定结果 */
export type PullOutcome =
  /** 远端不比本机已确认的新，跳过 */
  | 'skip'
  /** 本地没有这个键（或为空），直接采用远端 */
  | 'restore'
  /** 本地相对上次推送无新修改，安全覆盖 */
  | 'overwrite'
  /** 本地有未推送的新修改，双端冲突——不覆盖任何一端，交用户裁决 */
  | 'conflict';

export interface PullInput {
  /** 云端版本的 clientTs */
  remoteTs: number;
  /** 本机 meta 记录的该键时间（本地写入时间 / 上次同步确认时间） */
  metaTs: number;
  /** 解信封后的本地值；undefined = 本机没有这个键 */
  localValue: unknown;
  /** 该键上次成功推送的值哈希；undefined = 这个键从未推送过 */
  confirmedHash: string | undefined;
}

/** 拉取判定（纯函数，矩阵见文件头注释） */
export function classifyPull(input: PullInput): PullOutcome {
  const remoteTs = Number(input.remoteTs) || 0;
  const metaTs = Number(input.metaTs) || 0;
  if (remoteTs <= metaTs) return 'skip';
  if (input.localValue === undefined) return 'restore';
  if (input.confirmedHash !== undefined && valueHash(input.localValue) === input.confirmedHash) {
    return 'overwrite';
  }
  return 'conflict';
}

/** 冲突列表合并：同 key 只保留**新记录**的一条（后到的本地写入时间更大） */
export function mergeConflicts(existing: SyncConflict[], incoming: SyncConflict[]): SyncConflict[] {
  const byKey = new Map(existing.map((c) => [c.key, c]));
  for (const c of incoming) {
    const prev = byKey.get(c.key);
    if (!prev || (Number(c.localTs) || 0) >= (Number(prev.localTs) || 0)) byKey.set(c.key, c);
  }
  return Array.from(byKey.values());
}

/** 从冲突列表移除指定 key（裁决完成后调用） */
export function withoutConflicts(list: SyncConflict[], keys: string[]): SyncConflict[] {
  const drop = new Set(keys);
  return list.filter((c) => !drop.has(c.key));
}
