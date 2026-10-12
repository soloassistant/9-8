/**
 * 「每日读晨报」连续打卡（streak 改挂晨报，增量 1）。
 *
 * 设计要点（与 learn.ts 的 streak 完全解耦）：
 * - 独立 storage key `readStreakStore`，绝不与 `learnStore` 混用；
 * - 旧 learn streak **冻结保留、天数不迁移**（诚实性优先），靠 `migrateFromLearnStreak()` 幂等标记；
 * - 纯函数架构：业务逻辑全部可单测，页面层只做事件翻译（useDidShow/useDidHide）；
 * - storage 读写全 try/catch，失败只 warn，**绝不 throw**、绝不阻断晨报渲染。
 */
import Taro from '@tarojs/taro';
import dayjs from 'dayjs';

/** 独立 storage key（与 learnStore 严格隔离） */
export const READ_STORE_KEY = 'readStreakStore';
/** 达成「有效阅读」所需的最短前台停留时长（毫秒）。产品拍板：30 秒 */
export const READ_MIN_MS = 30000;
/** 达成「有效阅读」所需曝光的最少不同区块数。产品拍板：2 个 */
export const READ_MIN_SECTIONS = 2;
/** 会话中断容忍间隔（毫秒）：两次心跳间隔小于该值视为同一段连续阅读 */
export const READ_SESSION_GAP_MS = 5000;
/** 视为「已切后台」的心跳间隔上限（毫秒）：超过则不补计该段，避免锁屏挂机刷时长 */
export const READ_BACKGROUND_GAP_MS = 60000;
/** 打卡日保留上限（天），与 learn 口径一致 */
export const READ_DAY_LIMIT = 180;
/** 连续天数每满该值发 1 张冻结卡（结构复用 learn 语义） */
export const READ_FREEZE_INTERVAL_DAYS = 7;
/** 冻结卡持有上限 */
export const READ_FREEZE_MAX_CARDS = 2;

/** 晨报区块类型：今日日程 / 待办 / 昨日收藏精选 / 今日情报 */
export type ReadSectionKind = 'schedule' | 'todo' | 'fav' | 'intel';

/** 打卡日：与 learn.StreakDay 结构对齐，便于未来统一云同步 */
export interface ReadStreakDay {
  /** 'YYYY-MM-DD' */
  date: string;
  /** true = 由冻结卡补入 */
  frozen?: boolean;
  /** true = 由补签补入 */
  makeup?: boolean;
  /** 当次结算的实际停留秒数（用于分析，不参与判定） */
  seconds?: number;
  /** 当次曝光的区块数（用于分析，不参与判定） */
  sections?: number;
}

/** 冻结卡：结构复用 learn 语义，但数据独立 */
export interface ReadStreakFreeze {
  /** 当前持有张数（0~2） */
  cards: number;
  /** 累计已发放张数（用于按连续天数幂等发卡） */
  granted: number;
  /** 已消耗冻结卡覆盖的日期 */
  usedDates: string[];
}

/** 补签：自然月 1 次 */
export interface ReadMakeupRecord {
  /** 'YYYY-MM' */
  month: string;
  used: number;
  dates: string[];
}

/** 阅读会话：页面存活期间的内存态，**不落盘** */
export interface ReadSession {
  /** 'YYYY-MM-DD' */
  date: string;
  /** 累计前台秒数（切后台暂停） */
  activeSeconds: number;
  /** 已曝光区块 kind 去重 */
  sections: Set<string>;
  /** 上次心跳时间戳（毫秒），用于暂停补偿与后台段剔除 */
  lastTick: number;
}

/** 结算结果：供页面做 toast */
export interface ReadSettleResult {
  /** 本次是否新打卡成功 */
  checkedIn: boolean;
  /** 本次会话累计前台秒数 */
  seconds: number;
  /** 本次会话曝光的区块数 */
  sections: number;
}

/** 惰性结算结果（进页面补算昨日漏打卡 + 发冻结卡），与 learn.SettleResult 同构 */
export interface ReadSettleOnOpenResult {
  /** 本次自动消耗冻结卡覆盖的日期 */
  frozenDates: string[];
  /** 本次发放的冻结卡数 */
  grantedCards: number;
  /** 是否发生状态变化 */
  changed: boolean;
}

/** 持久化结构 */
export interface ReadStreakStore {
  /** 打卡日：兼容 string（旧）/ ReadStreakDay（新），读取时统一归一化 */
  days: Array<string | ReadStreakDay>;
  freeze?: ReadStreakFreeze;
  makeup?: ReadMakeupRecord;
  /** 迁移标记：true 表示已执行过 learn streak 冻结处理（幂等，见 migrateFromLearnStreak） */
  migratedFromLearn?: boolean;
}

/** 归一化为 'YYYY-MM-DD'；非法值返回 null（调用方丢弃） */
function normalizeDateStr(d: unknown): string | null {
  if (typeof d === 'string') {
    // 严格校验：只接受 'YYYY-MM-DD'，杜绝脏数据混入导致连续计算异常
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
  }
  if (d && typeof d === 'object' && typeof (d as ReadStreakDay).date === 'string') {
    const date = (d as ReadStreakDay).date;
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
  }
  return null;
}

/**
 * 归一化为日期字符串（用于 Set 去重比较）。
 *
 * ⚠️ 与 learn 既有实现**同语义、不加强校验**：不做合法性判断、不吞 null。
 * 学习侧 read 不过滤脏数据（保持既有行为不变），阅读侧 readReadStore 已在读入时
 * 过滤非法项，故此处拿到的一律合法。
 */
export function toStreakDateStr(d: string | StreakDayLike): string {
  return typeof d === 'string' ? d : d.date;
}

/* ------------------------------------------------------------------ */
/* 共享 streak 引擎                                                    */
/*                                                                    */
/* 把「学习连续(learn.ts)」与「阅读连续(readStreak.ts)」两套几乎镜像的  */
/* 实现合并为一个工厂。业务差异（storage key / 天数上限 / 冻结卡上限与  */
/* 发卡间隔）全部由适配器注入；**读侧脏数据归一化仍留在各模块自己的 read */
/* 里**——两套 read 口径本就不同（learn 宽松保留、read 严格过滤），不得抹平。*/
/*                                                                    */
/* 选址说明：受「只允许改动指定文件」约束，未新建模块；工厂落在本文件      */
/* （仅依赖 dayjs + Taro，是两套里更轻的一侧），由 learn.ts 单向 import。 */
/* ------------------------------------------------------------------ */

/** 打卡日结构约束：兼容 string（旧）与带标记对象（新）；learn.StreakDay / ReadStreakDay 都满足 */
export interface StreakDayLike {
  /** 'YYYY-MM-DD' */
  date: string;
  /** true = 由冻结卡补入 */
  frozen?: boolean;
  /** true = 由补签补入 */
  makeup?: boolean;
}

/** 冻结卡结构（learn / readStreak 同构） */
export interface StreakFreezeLike {
  /** 当前持有张数 */
  cards: number;
  /** 累计已发放张数 */
  granted: number;
  /** 已消耗冻结卡覆盖的日期 */
  usedDates: string[];
}

/** 惰性结算结果（learn.SettleResult / readStreak.ReadSettleOnOpenResult 同构） */
export interface StreakSettleResult {
  /** 本次自动消耗冻结卡覆盖的日期 */
  frozenDates: string[];
  /** 本次发放的冻结卡数 */
  grantedCards: number;
  /** 是否发生状态变化 */
  changed: boolean;
}

/** 业务侧 store 适配器：注入各自的 storage 结构与常量 */
export interface StreakEngineAdapter<S> {
  /** 读取（已归一化的）store */
  read(): S;
  /** 写回 store */
  write(store: S): void;
  /** 取打卡日数组 */
  getDays(store: S): Array<string | StreakDayLike>;
  /** 设置打卡日数组，返回新 store */
  setDays(store: S, days: Array<string | StreakDayLike>): S;
  /** 取冻结卡（缺省给出空卡） */
  getFreeze(store: S): StreakFreezeLike;
  /** 设置冻结卡，返回新 store */
  setFreeze(store: S, freeze: StreakFreezeLike): S;
  /** 打卡日保留上限（天） */
  readonly dayLimit: number;
  /** 冻结卡持有上限（张） */
  readonly cardLimit: number;
  /** 连续天数每满该值发 1 张 */
  readonly cardIntervalDays: number;
}

/** 共享引擎对外能力 */
export interface StreakEngine {
  /** 连续天数（frozen / makeup 日计入） */
  getStreak(): number;
  /** 今日是否已打卡 */
  isTodayCheckedIn(): boolean;
  /** 当前持有冻结卡张数 */
  getFreezeCards(): number;
  /** 惰性结算：补算漏打卡日 + 按连续天数发卡（幂等） */
  settleOnOpen(): StreakSettleResult;
}

/**
 * 构造共享 streak 引擎。行为与既有两套实现逐字节等价，关键语义：
 * - 连续天数：以今天（今天未打卡则从昨天）为锚点向前连续计数；
 * - 结算 ①：有历史 + 昨日未打卡 + 有冻结卡 → 消耗 1 张并补入 frozen 日；
 * - 结算 ②：`entitled = min(cardLimit, floor(streak / cardIntervalDays))`，补齐到 entitled（受 cardLimit 约束）；
 * - 幂等：granted / usedDates 去重，同日重复调用不重复发卡 / 消耗；
 * - 结算 ② 的 streak 必须**重新从 storage 读取**（补入的 frozen 日尚未写盘，与既有实现一致）。
 */
export function createStreakEngine<S>(adapter: StreakEngineAdapter<S>): StreakEngine {
  const getStreak = (): number => {
    const days = new Set(adapter.getDays(adapter.read()).map(toStreakDateStr));
    let cursor = dayjs();
    if (!days.has(cursor.format('YYYY-MM-DD'))) cursor = cursor.subtract(1, 'day');
    let streak = 0;
    while (days.has(cursor.format('YYYY-MM-DD'))) {
      streak++;
      cursor = cursor.subtract(1, 'day');
    }
    return streak;
  };

  const isTodayCheckedIn = (): boolean => {
    const today = dayjs().format('YYYY-MM-DD');
    return adapter.getDays(adapter.read()).some((d) => toStreakDateStr(d) === today);
  };

  const getFreezeCards = (): number => adapter.getFreeze(adapter.read()).cards ?? 0;

  const settleOnOpen = (): StreakSettleResult => {
    let store = adapter.read();
    const freeze = adapter.getFreeze(store);
    const result: StreakSettleResult = { frozenDates: [], grantedCards: 0, changed: false };

    // ① 漏打卡日：昨日未打卡且有冻结卡 → 消耗 1 张保住连续记录
    const days = new Set(adapter.getDays(store).map(toStreakDateStr));
    const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
    const hasAnyStreak = adapter.getDays(store).length > 0;
    if (hasAnyStreak && !days.has(yesterday) && freeze.cards > 0) {
      store = adapter.setDays(
        store,
        [...adapter.getDays(store), { date: yesterday, frozen: true }].slice(-adapter.dayLimit)
      );
      freeze.cards -= 1;
      freeze.usedDates = [...freeze.usedDates, yesterday];
      result.frozenDates.push(yesterday);
      result.changed = true;
    }

    // ② 每连续满 cardIntervalDays 天发 1 张（上限 cardLimit）
    const streak = getStreak();
    const entitled = Math.min(adapter.cardLimit, Math.floor(streak / adapter.cardIntervalDays));
    while (freeze.granted < entitled && freeze.cards < adapter.cardLimit) {
      freeze.granted += 1;
      freeze.cards += 1;
      result.grantedCards += 1;
      result.changed = true;
    }

    store = adapter.setFreeze(store, freeze);
    if (result.changed) adapter.write(store);
    return result;
  };

  return { getStreak, isTodayCheckedIn, getFreezeCards, settleOnOpen };
}

/** 空 store 工厂：所有分支统一构造，避免多处字面量漂移 */
function emptyStore(): ReadStreakStore {
  return {
    days: [],
    freeze: { cards: 0, granted: 0, usedDates: [] },
    makeup: { month: '', used: 0, dates: [] },
    migratedFromLearn: false
  };
}

/**
 * 读取并归一化 store。
 * 向后兼容：结构缺失 / 脏数据一律降级为安全默认值，绝不抛错。
 */
export function readReadStore(): ReadStreakStore {
  try {
    const raw = Taro.getStorageSync(READ_STORE_KEY);
    if (raw && typeof raw === 'object') {
      const days = Array.isArray(raw.days) ? raw.days : [];
      // 脏数据降级：非 'YYYY-MM-DD' 的打卡日直接丢弃，保证连续计算不受污染
      const cleanDays = days.filter((d: unknown) => normalizeDateStr(d) !== null);
      const freeze =
        raw.freeze && typeof raw.freeze === 'object'
          ? {
              cards: typeof raw.freeze.cards === 'number' ? raw.freeze.cards : 0,
              granted: typeof raw.freeze.granted === 'number' ? raw.freeze.granted : 0,
              usedDates: Array.isArray(raw.freeze.usedDates) ? raw.freeze.usedDates : []
            }
          : { cards: 0, granted: 0, usedDates: [] };
      const makeup =
        raw.makeup && typeof raw.makeup === 'object'
          ? {
              month: typeof raw.makeup.month === 'string' ? raw.makeup.month : '',
              used: typeof raw.makeup.used === 'number' ? raw.makeup.used : 0,
              dates: Array.isArray(raw.makeup.dates) ? raw.makeup.dates : []
            }
          : { month: '', used: 0, dates: [] };
      return {
        days: cleanDays,
        freeze,
        makeup,
        migratedFromLearn: raw.migratedFromLearn === true
      };
    }
  } catch (err) {
    console.warn('[readStreak] read store failed:', err);
  }
  return emptyStore();
}

/** 写盘：失败只 warn，绝不阻断主流程 */
function writeReadStore(store: ReadStreakStore): void {
  try {
    Taro.setStorageSync(READ_STORE_KEY, store);
  } catch (err) {
    console.warn('[readStreak] write store failed:', err);
  }
}

/**
 * 页面 useDidShow 调用：新建阅读会话（内存态，不落盘）。
 * 每次进前台都重置计时，配合 settleReadOnHide 在离开时结算。
 */
export function beginReadSession(date?: string): ReadSession {
  const now = Date.now();
  return {
    date: date || dayjs().format('YYYY-MM-DD'),
    activeSeconds: 0,
    sections: new Set<string>(),
    lastTick: now
  };
}

/**
 * 心跳：累加前台停留时长。
 * - 间隔 < READ_BACKGROUND_GAP_MS：视为连续前台，正常累加（含 <READ_SESSION_GAP_MS 的抖动，一并累计，避免阈值永远够不到）；
 * - 间隔 ≥ READ_BACKGROUND_GAP_MS：视为发生了后台/锁屏，**不补计**该段（防挂机刷时长）；
 * - 无论哪种情况都推进 lastTick，保证下次从当前时刻起算。
 * 返回新的 session 对象（纯函数风格，不修改入参）。
 */
export function tickReadSession(session: ReadSession, now: number = Date.now()): ReadSession {
  const delta = now - session.lastTick;
  const nextActive = delta > 0 && delta < READ_BACKGROUND_GAP_MS ? session.activeSeconds + delta / 1000 : session.activeSeconds;
  return {
    ...session,
    activeSeconds: nextActive,
    lastTick: now
  };
}

/** 区块曝光上报（去重）：同一区块重复曝光不计 */
export function markSectionSeen(session: ReadSession, kind: ReadSectionKind): ReadSession {
  if (session.sections.has(kind)) return session;
  const next = new Set(session.sections);
  next.add(kind);
  return { ...session, sections: next };
}

/** 判定给定时长与区块数是否达成「有效阅读」 */
export function isReadQualified(activeSeconds: number, sections: number): boolean {
  return activeSeconds * 1000 >= READ_MIN_MS && sections >= READ_MIN_SECTIONS;
}

/** 阅读连续引擎：注入 readStreakStore 适配器与阅读版常量 */
const readEngine = createStreakEngine<ReadStreakStore>({
  read: readReadStore,
  write: writeReadStore,
  getDays: (store) => store.days,
  setDays: (store, days) => ({ ...store, days }),
  getFreeze: (store) => store.freeze ?? { cards: 0, granted: 0, usedDates: [] },
  setFreeze: (store, freeze) => ({ ...store, freeze }),
  dayLimit: READ_DAY_LIMIT,
  cardLimit: READ_FREEZE_MAX_CARDS,
  cardIntervalDays: READ_FREEZE_INTERVAL_DAYS
});

/** 今日是否已打卡 */
export function isTodayRead(): boolean {
  return readEngine.isTodayCheckedIn();
}

/**
 * 离开页面/后台时结算：满足阈值则打卡（**同日幂等**）。
 * - 时长：结算前先把最近一段前台时间补入（lastTick → now），避免漏计最后一次心跳到离开的间隔；
 * - 幂等：同一天已出现过打卡日则直接返回 checkedIn=false。
 */
export function settleReadOnHide(session: ReadSession, now: number = Date.now()): ReadSettleResult {
  const settled = tickReadSession(session, now);
  const seconds = Math.round(settled.activeSeconds);
  const sections = settled.sections.size;
  const store = readReadStore();
  const daySet = new Set(store.days.map(toStreakDateStr));
  if (daySet.has(settled.date)) {
    // 同日已打卡（可能由更早的会话完成），幂等返回
    return { checkedIn: false, seconds, sections };
  }
  if (!isReadQualified(settled.activeSeconds, sections)) {
    return { checkedIn: false, seconds, sections };
  }
  const record: ReadStreakDay = { date: settled.date, seconds, sections };
  store.days = [...store.days, record].slice(-READ_DAY_LIMIT);
  writeReadStore(store);
  return { checkedIn: true, seconds, sections };
}

/**
 * 连续打卡天数：以今天（今天未读则从昨天）为锚点向前连续计数。
 * 冻结日 / 补签日同样计入连续。（实现见 createStreakEngine）
 */
export function getReadStreak(): number {
  return readEngine.getStreak();
}

/** 当前持有冻结卡张数 */
export function getReadFreezeCards(): number {
  return readEngine.getFreezeCards();
}

/**
 * 惰性结算（进页面调用，与 learn.settleStreakOnOpen 同构）：
 * ① 补算漏打卡日：有连续记录且昨日未读 + 有冻结卡 → 消耗 1 张并标记 frozen，保住连续记录；
 * ② 连续天数每满 READ_FREEZE_INTERVAL_DAYS 发 1 张（上限 2）。
 * 幂等：同一天多次调用不重复发卡 / 消耗（granted / usedDates 去重）。
 */
export function settleReadStreakOnOpen(): ReadSettleOnOpenResult {
  return readEngine.settleOnOpen();
}

/**
 * 一次性迁移：冻结旧 learn streak（幂等）。
 * **只做标记，不搬运天数** —— 靠学单词挣来的连续天数不冒充读晨报天数（诚实性优先）。
 * 返回是否本次执行（首次执行返回 true，重复调用返回 false）。
 */
export function migrateFromLearnStreak(): boolean {
  const store = readReadStore();
  if (store.migratedFromLearn) return false;
  store.migratedFromLearn = true;
  writeReadStore(store);
  return true;
}

/** 清空阅读连续记录（「我的」页清空入口用，二次确认由页面负责） */
export function clearReadStreak(): void {
  writeReadStore(emptyStore());
}
