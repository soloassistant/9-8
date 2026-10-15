/**
 * 记账数据层（H5）—— 条目 + 分类 + 预算，读写本地 storage。
 *
 * 为什么照 shopping.ts 的范式写（而不是走 callFunction）：
 *   H5 的 RPC 白名单（services/dataSource.ts:40）只放行 webSearch/chat/extract，
 *   shopping 这类 action 一律 invoke 必败 → 落到本文件。记账是纯用户本地数据，
 *   **返回的就是用户自己的真实记录，不是演示数据**，所以按 cloud.ts 的
 *   REAL_LOCAL_ACTIONS 处理：不登记降级（标成「演示数据」是反向不诚实）。
 *
 * 三个 storage key（都要进 cloudSync.SYNC_KEYS，见 services/cloudSync.ts）：
 *   ledgerEntries    一笔记账（LedgerEntry[]）
 *   ledgerCategories 自定义分类（LedgerCategory[]，含用户改动）
 *   ledgerBudget     预算（LedgerBudget）
 *   —— 刻意**分三个 key**而不是塞一个对象：分类/预算的写入频率远低于条目，
 *   分开才能让 cloudSync 的 per-key「新者赢」互不干扰
 *   （否则在别的设备加一笔账，会把另一端的预算设置一起覆盖掉）。
 *
 * 所有读��写都 try/catch + console.warn，**失败降级为默认值而不抛错** ——
 * 与 shopping.ts 一致：记账失败不该把用户从记账页踢走。
 */
import Taro from '@tarojs/taro';
import type { LedgerCategory, LedgerEntry, LedgerKind, LedgerBudget } from '../types';

export const LEDGER_KEYS = {
  entries: 'ledgerEntries',
  categories: 'ledger-categories',
  budget: 'ledgerBudget'
} as const;

/**
 * 内置分类（首次进入时落库，之后以用户改动后的为准）。
 *
 * 为什么内置 6+2 个而不是让用户从零建：记账最怕的是「第一次记账要填 8 个字段」，
 * 那会让功能在第一次用就被放弃。内置分类让首笔账只需「金额+分类」两步。
 *
 * ⚠️ 覆盖式写入的取舍：`ensureCategories` 只在 storage 为空时写入，
 *   所以用户删掉某分类后重启 App **不会**被重新塞回来 —— 这个行为是对的。
 */
export const DEFAULT_CATEGORIES: LedgerCategory[] = [
  // 支出
  { id: 'cat_food', name: '餐饮', icon: '🍜', kind: 'expense' },
  { id: 'cat_transport', name: '交通', icon: '🚇', kind: 'expense' },
  { id: 'cat_shopping', name: '购物', icon: '🛍️', kind: 'expense' },
  { id: 'cat_home', name: '居住', icon: '🏠', kind: 'expense' },
  { id: 'cat_fun', name: '娱乐', icon: '🎮', kind: 'expense' },
  { id: 'cat_other_exp', name: '其他支出', icon: '📦', kind: 'expense' },
  // 收入
  { id: 'cat_salary', name: '工资', icon: '💰', kind: 'income' },
  { id: 'cat_bonus', name: '奖金', icon: '🎁', kind: 'income' },
  { id: 'cat_other_inc', name: '其他收入', icon: '📥', kind: 'income' }
];

function readRaw<T>(key: string, fallback: T): T {
  try {
    const v = Taro.getStorageSync(key);
    if (v === '' || v === null || v === undefined) return fallback;
    return v as T;
  } catch (err) {
    console.warn('[ledger] read failed:', key, err);
    return fallback;
  }
}

function writeRaw(key: string, value: unknown): boolean {
  try {
    Taro.setStorageSync(key, value);
    return true;
  } catch (err) {
    console.warn('[ledger] write failed:', key, err);
    return false;
  }
}

/** 日期校验：只接受 'YYYY-MM-DD'，且必须是真实存在的日期。
 *  理由：date 是日/月聚合的唯一依据，放进 '2026-1-5' 或 'abc' 会静默算错账。 */
export function isValidLedgerDate(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  // 用 Date 复核「日历上真的存在这一天」——挡掉 2026-02-30 这类
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** 首次进入时写入内置分类（storage 为空才写，不覆盖用户改动） */
export function ensureCategories(): LedgerCategory[] {
  const existing = readRaw<LedgerCategory[]>(LEDGER_KEYS.categories, []);
  if (existing.length > 0) return existing;
  writeRaw(LEDGER_KEYS.categories, DEFAULT_CATEGORIES);
  return DEFAULT_CATEGORIES;
}

export function loadCategories(): LedgerCategory[] {
  const list = readRaw<LedgerCategory[]>(LEDGER_KEYS.categories, []);
  // 存储损坏（不是数组）时回落到内置分类，而不是返回空数组 ——
  // 空数组会让分类选择器变成空白，用户以为功能坏了。
  return Array.isArray(list) && list.length > 0 ? list : DEFAULT_CATEGORIES;
}

export function loadEntries(): LedgerEntry[] {
  const list = readRaw<LedgerEntry[]>(LEDGER_KEYS.entries, []);
  return Array.isArray(list) ? list.filter(isValidEntry) : [];
}

/** 条目结构校验：老数据/手改storage/云同步回来的脏数据都要挡掉，
 *  否则渲染时会因缺字段崩（LedgerEntry 全字段都是必需的）。 */
export function isValidEntry(e: unknown): e is LedgerEntry {
  if (!e || typeof e !== 'object') return false;
  const o = e as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id) return false;
  if (typeof o.amount !== 'number' || !Number.isFinite(o.amount) || o.amount <= 0) return false;
  if (o.kind !== 'expense' && o.kind !== 'income') return false;
  if (typeof o.categoryId !== 'string' || !o.categoryId) return false;
  if (!isValidLedgerDate(o.date)) return false;
  if (typeof o.createdAt !== 'string') return false;
  if (o.note !== undefined && typeof o.note !== 'string') return false;
  return true;
}

export function loadBudget(): LedgerBudget {
  const b = readRaw<LedgerBudget>(LEDGER_KEYS.budget, {});
  if (!b || typeof b !== 'object') return {};
  const out: LedgerBudget = {};
  // 只接受正数上限；0/负数/NaN 一律当作「未设置」——
  // 把 0 当上限会让任何一笔支出都立刻超支，是明显错误的语义。
  if (typeof b.monthly === 'number' && Number.isFinite(b.monthly) && b.monthly > 0) out.monthly = b.monthly;
  if (typeof b.daily === 'number' && Number.isFinite(b.daily) && b.daily > 0) out.daily = b.daily;
  return out;
}

/** 生成条目 id。与 shopping.ts 同款形状（时间戳+随机），本机唯一即可。 */
function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface AddEntryPayload {
  amount: number;
  kind: LedgerKind;
  categoryId: string;
  note?: string;
  date?: string;
}

/** 新增一笔。返回落库后的条目，校验不过返回 null（调用方负责提示）。 */
export function addEntry(payload: AddEntryPayload): LedgerEntry | null {
  const amount = Number(payload.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (payload.kind !== 'expense' && payload.kind !== 'income') return null;
  const cats = loadCategories();
  const cat = cats.find((c) => c.id === payload.categoryId);
  // 分类必须存在**且方向一致** —— 把「工资」记成支出会让月度汇总出现荒谬的抵消。
  if (!cat || cat.kind !== payload.kind) return null;
  const date = payload.date ?? new Date().toISOString().slice(0, 10);
  if (!isValidLedgerDate(date)) return null;
  const note = typeof payload.note === 'string' ? payload.note.trim().slice(0, 100) : '';
  const entry: LedgerEntry = {
    id: newId('lg'),
    amount: Math.round(amount * 100) / 100,
    kind: payload.kind,
    categoryId: cat.id,
    ...(note ? { note } : {}),
    date,
    createdAt: new Date().toISOString()
  };
  const list = loadEntries();
  writeRaw(LEDGER_KEYS.entries, [entry, ...list]);
  return entry;
}

export function updateEntry(
  id: string,
  patch: Partial<Pick<LedgerEntry, 'amount' | 'categoryId' | 'note' | 'date'>>
): LedgerEntry | null {
  const list = loadEntries();
  const idx = list.findIndex((e) => e.id === id);
  if (idx < 0) return null;
  const prev = list[idx];
  const amount = patch.amount === undefined ? prev.amount : Number(patch.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (patch.date !== undefined && !isValidLedgerDate(patch.date)) return null;
  let categoryId = patch.categoryId === undefined ? prev.categoryId : patch.categoryId;
  if (patch.categoryId !== undefined) {
    // 换分类时同样要校验方向，避免改着改着把支出改成收入
    const cat = loadCategories().find((c) => c.id === categoryId);
    if (!cat || cat.kind !== prev.kind) return null;
  }
  const note =
    patch.note === undefined ? prev.note : String(patch.note).trim().slice(0, 100) || undefined;
  const next: LedgerEntry = {
    ...prev,
    amount: Math.round(amount * 100) / 100,
    categoryId,
    date: patch.date === undefined ? prev.date : patch.date,
    ...(note ? { note } : {})
  };
  const out = [...list];
  out[idx] = next;
  writeRaw(LEDGER_KEYS.entries, out);
  return next;
}

export function removeEntry(id: string): boolean {
  const list = loadEntries();
  if (!list.some((e) => e.id === id)) return false;
  writeRaw(LEDGER_KEYS.entries, list.filter((e) => e.id !== id));
  return true;
}

export function saveBudget(budget: LedgerBudget): LedgerBudget {
  const out: LedgerBudget = {};
  if (typeof budget.monthly === 'number' && Number.isFinite(budget.monthly) && budget.monthly > 0) {
    out.monthly = Math.round(budget.monthly * 100) / 100;
  }
  if (typeof budget.daily === 'number' && Number.isFinite(budget.daily) && budget.daily > 0) {
    out.daily = Math.round(budget.daily * 100) / 100;
  }
  writeRaw(LEDGER_KEYS.budget, out);
  return out;
}

/** 新增自定义分类。id 自动生成；同名同向重复则拒绝（防手滑建出两个「餐饮」）。 */
export function addCategory(name: string, kind: LedgerKind, icon?: string): LedgerCategory | null {
  const trimmed = String(name || '').trim().slice(0, 8);
  if (!trimmed) return null;
  if (kind !== 'expense' && kind !== 'income') return null;
  const list = loadCategories();
  if (list.some((c) => c.name === trimmed && c.kind === kind)) return null;
  const cat: LedgerCategory = {
    id: newId('cat'),
    name: trimmed,
    // 默认图标按方向给一个中性的，省得让用户选emoji（记账不该有这一步）
    icon: String(icon || (kind === 'expense' ? '📦' : '📥')).trim().slice(0, 4) || '📦',
    kind
  };
  writeRaw(LEDGER_KEYS.categories, [...list, cat]);
  return cat;
}

export function removeCategory(id: string): boolean {
  const list = loadCategories();
  if (!list.some((c) => c.id === id)) return false;
  const used = loadEntries().some((e) => e.categoryId === id);
  // 有条目在用就不让删：删掉会让历史账目挂在一个不存在的分类上，
  // 统计时按「其他」兜底会让用户以为金额算错了。
  if (used) return false;
  writeRaw(LEDGER_KEYS.categories, list.filter((c) => c.id !== id));
  return true;
}