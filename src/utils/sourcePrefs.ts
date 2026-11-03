/**
 * 资讯来源开关（2026-11-02，产品评估 §P0-2）—— 用户自己决定「看谁的」。
 *
 * 为什么要有：41-48 个源写死在抓取清单里，前端一个开关都没有。对 Feedly / Digest 这类
 * 产品，源自管理是标配；对我们的场景还有一个额外意义 —— **用户自己留的源，信任度更高**，
 * 也是「防茧房」的前置（先能关掉噪音源，再谈掺入探索位）。
 *
 * 存储口径：**只存"关掉了谁"**（disabled 列表），不存"开着谁"。
 * 理由：抓取侧随时会新增源（注册表在 .tools/boards-core.js），存白名单的话新源默认不可见，
 * 用户会莫名其妙"少了一堆内容"；存黑名单则新源默认可见，行为符合直觉。
 *
 * 下限保护：至少保留 MIN_ENABLED_SOURCES 个。全关 = 晨报变空页，那是故障不是偏好。
 */
import Taro from '@tarojs/taro';

const STORAGE_KEY = 'hotspot-disabled-sources';

/** 至少留几个源（全关会让热点页空掉，用户会以为坏了） */
export const MIN_ENABLED_SOURCES = 3;

/** 读用户关掉的源名（去重、去空、去噪） */
export function readDisabledSources(): string[] {
  try {
    const raw = Taro.getStorageSync(STORAGE_KEY);
    // Taro storage 缺键返回空串（不是 undefined），必须两种都兜住
    const parsed = typeof raw === 'string' && raw ? JSON.parse(raw) : raw;
    const list = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.data) ? parsed.data : [];
    const out: string[] = [];
    for (const item of list) {
      if (typeof item !== 'string') continue;
      const name = item.trim();
      if (name && !out.includes(name)) out.push(name);
    }
    return out;
  } catch (err) {
    console.warn('[sourcePrefs] read failed:', err);
    return [];
  }
}

function writeDisabledSources(list: string[]): void {
  try {
    Taro.setStorageSync(STORAGE_KEY, list);
  } catch (err) {
    console.warn('[sourcePrefs] write failed:', err);
  }
}

export function isSourceEnabled(name: string, disabled = readDisabledSources()): boolean {
  return !disabled.includes(name);
}

/**
 * 切换某个源。`allSources` 是当前**全部**可用源名（用于算下限），
 * 不传就只能做乐观写入 —— 所以调用方务必传。
 * 返回 ok:false 时不做任何写入（保持原状），由调用方提示。
 */
export function setSourceEnabled(name: string, enabled: boolean, allSources: string[]): { ok: boolean; reason?: 'min_keep' } {
  const src = String(name || '').trim();
  if (!src) return { ok: true };
  const disabled = readDisabledSources();
  const next = enabled ? disabled.filter((n) => n !== src) : disabled.includes(src) ? disabled : disabled.concat(src);

  const total = Array.isArray(allSources) ? allSources.filter((s) => typeof s === 'string' && s.trim()).length : 0;
  if (total > 0) {
    const enabledCount = total - next.filter((n) => allSources.includes(n)).length;
    if (enabledCount < MIN_ENABLED_SOURCES) return { ok: false, reason: 'min_keep' };
  }
  writeDisabledSources(next);
  return { ok: true };
}

/**
 * 过滤管线（**全应用一处收口**）：热点条目进 UI 之前都走它。
 * 关掉的源整条丢弃，其余保持原顺序 —— 顺序是偏好选择的排序结果，这里不许重排。
 */
export function filterBySourcePrefs<T extends { source?: string }>(items: T[]): T[] {
  if (!Array.isArray(items) || items.length === 0) return items;
  const disabled = readDisabledSources();
  if (disabled.length === 0) return items;
  return items.filter((it) => !(it && typeof it.source === 'string' && disabled.includes(it.source)));
}

/** 观测用：当前被关掉的源数（UI 摘要行用） */
export function disabledSourceCount(): number {
  return readDisabledSources().length;
}
