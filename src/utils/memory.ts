/**
 * AI 记忆模块（M-01~M-04）
 *
 * 设计要点：
 * - **纯逻辑下沉**：Storage 读写只在本模块内，页面组件（AiAssistant / mine）只调这里导出的函数。
 * - **向后兼容**：既有 key `ai-memory` 保持不变，旧结构为 `string[]`，`readMemory()` 读到即自动迁移为 `MemoryStore`。
 * - **全局开关**：关闭后不读不写（PRD M-02），但已有条目保留。
 * - **撤销 + 抑制**：撤销时把内容写入 `mb_memory_suppress`，本轮对话内 `isSuppressed()` 命中即不再写入（PRD M-04）。
 * - 所有 Storage 读写一律 try/catch，失败只 console.warn，不阻塞调用方。
 */
import Taro from '@tarojs/taro';

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

/** 记忆主存储 key（沿用旧 key，结构由 string[] 迁移为 MemoryStore） */
export const MEMORY_STORAGE_KEY = 'ai-memory';
/** 短期抑制列表 key（本轮对话内） */
export const MEMORY_SUPPRESS_KEY = 'mb_memory_suppress';
/** 写入摘要上限（PRD M-03：≤20 字） */
export const MEMORY_SUMMARY_LIMIT = 20;
/** 撤销窗口（ms，PRD M-03：5 秒） */
export const MEMORY_UNDO_WINDOW_MS = 5000;
/** 记忆条目上限（超出丢弃最旧的，防止无限增长） */
export const MEMORY_MAX_ITEMS = 200;
/** 摘要截断时追加的省略符 */
export const MEMORY_ELLIPSIS = '…';
/** 溯源短语上限（改进点清单 E：来源对话 message 截 12 字） */
export const MEMORY_SOURCE_SNIPPET_LIMIT = 12;

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

export interface MemoryItem {
  id: string;
  content: string;
  /** ISO 8601 */
  createdAt: string;
  /** 来源：'chat' | 'seed' */
  source?: string;
  /** 溯源短语：触发写入的那句话截前 12 字（P1-E 透明记忆）；旧数据/种子数据缺省，展示层兜底「—」 */
  sourceSnippet?: string;
}

export interface MemoryStore {
  /** 全局开关：关闭后 AI 不再读写，已有条目保留（PRD M-02） */
  enabled: boolean;
  items: MemoryItem[];
}

/** 摘要结果：单条时 text 为 ≤20 字摘要；多条时 text 为空串，调用方用 count 套 i18n */
export interface MemorySummary {
  text: string;
  count: number;
}

/** toast 文案契约：交给调用方用 useT() 取值，避免本模块硬编码中文 */
export type MemoryToastKey = 'memory.toastOne' | 'memory.toastMulti';

export interface MemoryToast {
  key: MemoryToastKey;
  params: { text?: string; n?: number };
}

/* ------------------------------------------------------------------ */
/* 内部：Storage 读写与归一化                                            */
/* ------------------------------------------------------------------ */

let memorySeq = 0;

/** 生成单调递增的记忆 id */
function makeMemoryId(): string {
  memorySeq += 1;
  return `m_${Date.now().toString(36)}_${memorySeq}`;
}

/** 读 Storage：失败返回 null 且不抛错 */
function readRaw<T>(key: string): T | null {
  try {
    const raw = Taro.getStorageSync(key);
    if (raw === undefined || raw === null || raw === '') return null;
    return raw as T;
  } catch {
    console.warn(`[memory] read failed: ${key}`);
    return null;
  }
}

/** 写 Storage：失败返回 false 且不抛错 */
function writeRaw(key: string, value: unknown): boolean {
  try {
    Taro.setStorageSync(key, value);
    return true;
  } catch {
    console.warn(`[memory] write failed: ${key}`);
    return false;
  }
}

/** 归一化比对键：去首尾空格 + 折叠内部空白 */
function normalizeContent(content: string): string {
  return String(content || '').trim().replace(/\s+/g, ' ');
}

/** 把任意形态（string / MemoryItem / 脏数据）归一为 MemoryItem[] */
function normalizeItems(raw: unknown): MemoryItem[] {
  const list = Array.isArray(raw) ? raw : [];
  const items: MemoryItem[] = [];
  list.forEach((entry) => {
    if (typeof entry === 'string') {
      const content = normalizeContent(entry);
      if (!content) return;
      items.push({ id: makeMemoryId(), content, createdAt: new Date().toISOString(), source: 'seed' });
      return;
    }
    if (entry && typeof entry === 'object') {
      const obj = entry as Partial<MemoryItem>;
      const content = normalizeContent(String(obj.content || ''));
      if (!content) return;
      items.push({
        id: typeof obj.id === 'string' && obj.id ? obj.id : makeMemoryId(),
        content,
        createdAt: typeof obj.createdAt === 'string' && obj.createdAt ? obj.createdAt : new Date().toISOString(),
        source: typeof obj.source === 'string' ? obj.source : 'chat',
        sourceSnippet: typeof obj.sourceSnippet === 'string' && obj.sourceSnippet ? obj.sourceSnippet : undefined
      });
    }
  });
  return items;
}

/** 读抑制列表（已归一化） */
function readSuppress(): string[] {
  const raw = readRaw<string[]>(MEMORY_SUPPRESS_KEY);
  const list = Array.isArray(raw) ? raw : [];
  return list.map((item) => normalizeContent(String(item || ''))).filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* 对外：读写                                                          */
/* ------------------------------------------------------------------ */

/**
 * 读取记忆。旧结构 `string[]` 自动迁移为 `MemoryStore`；
 * 无任何数据（或读取失败）时返回 `{ enabled: true, items: [] }`。
 */
export function readMemory(): MemoryStore {
  const raw = readRaw<unknown>(MEMORY_STORAGE_KEY);
  if (Array.isArray(raw)) {
    // 旧格式：直接是 string[]
    return { enabled: true, items: normalizeItems(raw) };
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Partial<MemoryStore>;
    return {
      enabled: obj.enabled !== false,
      items: normalizeItems(obj.items)
    };
  }
  return { enabled: true, items: [] };
}

/** 落盘（内部统一入口） */
function persist(store: MemoryStore): boolean {
  return writeRaw(MEMORY_STORAGE_KEY, store);
}

/**
 * 写入记忆（可一次多条）。
 * - 全局开关关闭时直接返回空数组，不写盘（PRD M-02）
 * - 已存在（内容归一化后相同）或被抑制的内容跳过，不重复写入
 * - 返回**本次新增**的条目，供调用方做 toast 与撤销
 * @param contents 待写入内容（会自动 trim + 折叠空白，空串跳过）
 * @param source 条目来源，默认 'chat'；初始化种子数据建议传 'seed'
 * @param sourceSnippet 溯源短语：触发写入的用户原话（内部截 12 字，P1-E）
 */
export function writeMemory(contents: string[], source: string = 'chat', sourceSnippet?: string): MemoryItem[] {
  const store = readMemory();
  if (!store.enabled) return [];
  const list = Array.isArray(contents) ? contents : [];
  if (list.length === 0) return [];

  const suppress = readSuppress();
  const seen = new Set<string>();
  store.items.forEach((item) => seen.add(normalizeContent(item.content)));

  // 溯源短语在入口处一次性截断归一（一处收口，展示层不再各自处理）
  const snippet = sourceSnippet ? truncateSummary(String(sourceSnippet), MEMORY_SOURCE_SNIPPET_LIMIT) : undefined;

  const added: MemoryItem[] = [];
  list.forEach((raw) => {
    const content = normalizeContent(String(raw || ''));
    if (!content) return;
    if (seen.has(content)) return;
    if (suppress.indexOf(content) >= 0) return;
    const item: MemoryItem = {
      id: makeMemoryId(),
      content,
      createdAt: new Date().toISOString(),
      source
    };
    if (snippet) item.sourceSnippet = snippet;
    seen.add(content);
    store.items.push(item);
    added.push(item);
  });

  if (added.length === 0) return [];
  store.items = store.items.slice(-MEMORY_MAX_ITEMS);
  persist(store);
  return added;
}

/** 逐条删除 */
export function deleteMemory(id: string): void {
  if (!id) return;
  const store = readMemory();
  const next = store.items.filter((item) => item.id !== id);
  if (next.length === store.items.length) return;
  store.items = next;
  persist(store);
}

/** 清空全部条目（保留开关状态） */
export function clearMemory(): void {
  const store = readMemory();
  store.items = [];
  persist(store);
}

/** 全局开关：关闭后不读写，已有条目保留 */
export function setMemoryEnabled(enabled: boolean): void {
  const store = readMemory();
  store.enabled = !!enabled;
  persist(store);
}

/**
 * 撤销：删除指定条目，并把内容写入短期抑制列表（PRD M-04）。
 * 抑制在 `clearSuppress()`（新一轮对话开始）前一直生效。
 */
export function undoMemory(ids: string[]): void {
  const list = Array.isArray(ids) ? ids : [];
  if (list.length === 0) return;
  const store = readMemory();
  const removed: string[] = [];
  const next = store.items.filter((item) => {
    if (list.indexOf(item.id) < 0) return true;
    removed.push(normalizeContent(item.content));
    return false;
  });
  if (removed.length === 0) return;
  store.items = next;
  persist(store);

  const suppress = readSuppress();
  removed.forEach((content) => {
    if (content && suppress.indexOf(content) < 0) suppress.push(content);
  });
  writeRaw(MEMORY_SUPPRESS_KEY, suppress);
}

/** 该内容是否在抑制列表中（本轮对话内不再重复写入） */
export function isSuppressed(content: string): boolean {
  const key = normalizeContent(content);
  if (!key) return false;
  return readSuppress().indexOf(key) >= 0;
}

/** 新一轮对话开始时清空抑制列表 */
export function clearSuppress(): void {
  writeRaw(MEMORY_SUPPRESS_KEY, []);
}

/* ------------------------------------------------------------------ */
/* 对外：摘要与 toast 契约                                              */
/* ------------------------------------------------------------------ */

/** 截断为 ≤ limit 字的摘要，超出部分用 MEMORY_ELLIPSIS */
export function truncateSummary(content: string, limit: number = MEMORY_SUMMARY_LIMIT): string {
  const text = normalizeContent(content);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}${MEMORY_ELLIPSIS}`;
}

/**
 * 摘要：单条时为 ≤20 字摘要；多条时 text 为空串（由调用方用 count 套 `memory.toastMulti`）。
 * 注意：本模块不产出中文文案，文案一律由 i18n key `memory.toastOne` / `memory.toastMulti` 提供。
 */
export function summarize(items: MemoryItem[]): MemorySummary {
  const list = Array.isArray(items) ? items.filter((item) => !!item && !!item.content) : [];
  const count = list.length;
  if (count === 0) return { text: '', count: 0 };
  return { text: count === 1 ? truncateSummary(list[0].content) : '', count };
}

/** toast 契约：返回 i18n key 与参数，调用方 `t(toast.key, toast.params)` */
export function memoryToast(items: MemoryItem[]): MemoryToast {
  const summary = summarize(items);
  if (summary.count <= 1) {
    return { key: 'memory.toastOne', params: { text: summary.text } };
  }
  return { key: 'memory.toastMulti', params: { n: summary.count } };
}
