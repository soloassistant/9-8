// ============================================
// 数据保险箱（2026-10-31）：全量导出/导入的用户数据信封。
// 产品评估 §7.2 F + 设置缺口②——日程/待办/收藏/学习/记忆都是用户资产，
// 此前只有记账能导 CSV；换设备/清缓存前没有一个「把我的数据带走」的入口。
//
// 纯函数、零运行时依赖：键值的收集与写回在调用页（Taro storage 只能出现在那）。
// 这里只负责信封的**构造与校验** —— 导入是唯一会覆盖用户数据的路径，校验必须严格：
// 结构不对、版本不认识、keys 不是对象，一律拒绝，绝不「尽量恢复」。
// ============================================

export const VAULT_APP = 'morning-brief';
export const VAULT_VERSION = 1;

export interface VaultPayload {
  app: typeof VAULT_APP;
  version: typeof VAULT_VERSION;
  /** ISO 时间串 */
  exportedAt: string;
  /** 存储键 → 值（值已做 JSON 安全化：不可序列化的会被 collectVault 丢进 dropped） */
  keys: Record<string, unknown>;
}

export interface CollectVaultResult {
  payload: VaultPayload | null;
  /** 无法 JSON 安全化的键（调用页应如实提示，不能静默吞） */
  dropped: string[];
}

/** 导入校验结果：ok=false 时 error 是给用户看的人类可读原因（调用页直接展示） */
export type VaultValidateResult =
  | { ok: true; payload: VaultPayload }
  | { ok: false; error: string };

/**
 * 构造导出信封。每个值先过一遍 JSON 序列化（String/number/对象/数组都安全；
 * 含函数/循环引用的值进 dropped，**不写进信封**——导出一个会让导入端炸掉的值是埋雷）。
 * entries 为空（用户啥都没有）时 payload 仍合法，keys 是空对象。
 */
export function collectVault(
  entries: Record<string, unknown>,
  now: Date = new Date()
): CollectVaultResult {
  const keys: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(entries || {})) {
    try {
      keys[k] = JSON.parse(JSON.stringify(v ?? null));
    } catch {
      dropped.push(k);
    }
  }
  return {
    payload: {
      app: VAULT_APP,
      version: VAULT_VERSION,
      exportedAt: now.toISOString(),
      keys,
    },
    dropped,
  };
}

/**
 * 导入校验（**不落盘**——写回由调用页在校验通过后逐键执行）：
 *   · 必须是 JSON 对象，app 字段必须是 'morning-brief'（别人的备份别当我们的收）
 *   · version 只认 1（更高版本 = 更新的应用导出的，老代码解析不动，如实拒绝并提示升级）
 *   · keys 必须是普通对象；每个值再做一次 JSON 安全化（防手工编辑塞进函数/循环引用）
 * 校验通过返回整份 payload，调用页按自己的白名单决定写哪些键（**不必全收**）。
 */
export function validateVault(raw: unknown): VaultValidateResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'not-object' };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.app !== VAULT_APP) return { ok: false, error: 'not-our-app' };
  if (obj.version !== VAULT_VERSION) return { ok: false, error: 'version-unsupported' };
  const ts = typeof obj.exportedAt === 'string' ? Date.parse(obj.exportedAt) : NaN;
  if (!Number.isFinite(ts)) return { ok: false, error: 'bad-exportedAt' };
  if (!obj.keys || typeof obj.keys !== 'object' || Array.isArray(obj.keys)) {
    return { ok: false, error: 'bad-keys' };
  }
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj.keys as Record<string, unknown>)) {
    try {
      safe[k] = JSON.parse(JSON.stringify(v ?? null));
    } catch {
      return { ok: false, error: `bad-value:${k}` };
    }
  }
  return {
    ok: true,
    payload: { app: VAULT_APP, version: VAULT_VERSION, exportedAt: obj.exportedAt as string, keys: safe },
  };
}

/** 导出文件名：晨报数据备份-YYYYMMDD-HHmm.json（与记账导出同款中文命名习惯） */
export function buildVaultFilename(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `晨报数据备份-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.json`;
}
