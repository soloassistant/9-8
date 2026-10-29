/**
 * AI 对话额度的**纯规则**（无 IO、无 Taro、无云端）。
 *
 * 为什么单独拆出来（2026-10-29）：额度是"扣钱"的逻辑，必须能被反复验证，
 * 而 `aiQuota.ts` 里混着 Taro storage 与云端 count 查询，跑行为测试得先造一堆桩。
 * 拆出来后：规则在这里（可被 esbuild 编成 CJS 直接跑），IO 在 aiQuota.ts。
 */

/** 免费档每天可用条数（会员页/弹窗文案以此为源） */
export const FREE_CHAT_PER_DAY = 20;

export interface QuotaInput {
  /** 是否订阅中（订阅 → 不限） */
  subscribed: boolean;
  /** 云端今日成功条数；null = 取不到（未登录/断网/表不可用） */
  cloudCount: number | null;
  /** 本地镜像今日条数 */
  localUsed: number;
  /** 免费档上限，默认 FREE_CHAT_PER_DAY（测试可覆盖） */
  limit?: number;
}

export interface QuotaDecision {
  unlimited: boolean;
  /** 免费档上限；订阅时为 -1（与项目里 voiceQuota 的约定一致） */
  limit: number;
  used: number;
  /** 免费档剩余；订阅时 -1 */
  remaining: number;
  /** 计数来源：cloud=云端权威，local=降级 */
  source: 'cloud' | 'local';
}

/**
 * 判定今日额度。三条不变量：
 *   ① **取大**：云端与本地镜像取较大值 —— 本地刚 +1 但云端还没落库时不会低估；
 *      清 localStorage 也绕不过云端计数。
 *   ② **云端取不到不等于 0**：降级到本地镜像（source=local），仍然拦人。
 *      把 null 当 0 等于静默放开闸门，是最不能接受的失败方式。
 *   ③ 订阅 → unlimited，且 remaining 记为 -1（沿用 voiceQuota 的 -1 约定，UI 直接认）。
 */
export function decideQuota(input: QuotaInput): QuotaDecision {
  const limit = typeof input.limit === 'number' && input.limit > 0 ? input.limit : FREE_CHAT_PER_DAY;
  const localUsed = Number.isFinite(input.localUsed) ? Math.max(0, Math.floor(input.localUsed)) : 0;
  const cloud = typeof input.cloudCount === 'number' && Number.isFinite(input.cloudCount)
    ? Math.max(0, Math.floor(input.cloudCount))
    : null;
  const used = cloud === null ? localUsed : Math.max(cloud, localUsed);
  const source: 'cloud' | 'local' = cloud === null ? 'local' : 'cloud';
  if (input.subscribed) return { unlimited: true, limit: -1, used, remaining: -1, source };
  return { unlimited: false, limit, used, remaining: Math.max(0, limit - used), source };
}

/** 还能不能再发一条 */
export function canChat(decision: QuotaDecision): boolean {
  return decision.unlimited || decision.remaining > 0;
}

/** 本地日期键 YYYY-MM-DD（本地时区，与用户对"今天"的直觉一致） */
export function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 本地镜像是否属于"今天"（跨天自动归零，不做累计） */
export function isSameDay(stored: { day?: string; used?: number } | null | undefined, now: Date): boolean {
  return !!stored && stored.day === dayKey(now);
}
