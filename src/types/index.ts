// ============================================
// 领域类型定义 —— 私人晨报助理
// ============================================

/** 日程事件 */
export interface ScheduleEvent {
  id: string;
  title: string;
  /** ISO 日期时间或 'YYYY-MM-DD HH:mm' */
  startTime: string;
  endTime?: string;
  location?: string;
  /** 来源消息摘要 */
  source?: string;
  /** confirmed: 已确认入库 / pending: 待确认 */
  status: 'confirmed' | 'pending';
  createTime?: string;
}

/** 待办事项 */
export interface TodoItem {
  id: string;
  title: string;
  /** 截止日期，可选 */
  dueDate?: string;
  /** 来源消息摘要 */
  source?: string;
  status: 'confirmed' | 'pending' | 'done';
  createTime?: string;
}

/** 收藏条目（转发文章/链接/内容的摘要归档） */
export interface CollectionItem {
  id: string;
  title: string;
  summary: string;
  tags: string[];
  /** 原文链接（若有） */
  url?: string;
  /** 原文类型：article 文章 / message 消息 / link 链接 */
  sourceType: 'article' | 'message' | 'link';
  createTime: string;
}

/** 今日情报（F15）：天气 + 偏好资讯。
 *  免费档：RSS 原始 3 条（零 LLM，不做 AI 提炼）；订阅档：LLM 摘要 + 主题分组（日限额 10 次）。
 *  任一步失败均降级，绝不阻塞晨报。 */
export interface BriefingIntel {
  /** 是否订阅用户（决定档位；非订阅用户同样会拿到 intelItems，只是为 RSS 原始条目） */
  subscribed: boolean;
  /** 今日限额已满（10 次/日），此时 intelItems 为原始资讯降级 */
  limited?: boolean;
  /** 天气一句话（和风天气未配置/失败时为 null） */
  weather: { text: string; updateTime: string } | null;
  /** 情报条目，每条标注来源（合规要求） */
  intelItems: Array<{ text: string; source: string }>;
  /** true = 未经 LLM 提炼的降级内容（原始资讯或空） */
  degraded?: boolean;
}

/** 晨报自适应信号（F21） */
export interface BriefingAdaptive {
  /** 日程爆满（≥4 项或总时长 ≥5h） */
  busyDay: boolean;
  /** 次日外地行程目的地城市 */
  tripCity: string | null;
  /** 高优待办标题 */
  focusTodo: string | null;
  /** 当日日程总分钟数（负载条用；endTime 缺省按 1h 估算。旧数据缺失时负载条不渲染） */
  busyMinutes?: number;
  /** 当日日程数 */
  todayCount?: number;
}

/** 本周复盘统计（P1-G：过去 7 天含今天的确定性统计，不调 LLM） */
export interface WeeklyReview {
  /** 窗口内 done 状态的待办数 */
  todosDone: number;
  /** 窗口内日程数 */
  eventCount: number;
  /** 标题高频关键词 top5（出现 ≥2 次才保留，可为空数组） */
  keywords: string[];
}

/** 晨报 */
export interface Briefing {
  /** 'YYYY-MM-DD' */
  date: string;
  greeting: string;
  events: ScheduleEvent[];
  todos: TodoItem[];
  /** 昨日收藏精选摘要 */
  digest: string[];
  /** 今日情报（订阅专属；未订阅/生成失败为 null 或缺失，兼容旧数据） */
  intel?: BriefingIntel | null;
  /** 自适应信号（F21；旧数据缺失时前端可按 events/todos 现算） */
  adaptive?: BriefingAdaptive;
  /** 本周复盘（P1-G；旧缓存/云函数降级缺失时整卡不渲染） */
  weeklyReview?: WeeklyReview;
  /** 收尾冷知识（P2-X7；缺失不渲染） */
  trivia?: string;
  /** 周末轻量版标记（P1-X6；周末生成时置 true，资讯减量） */
  weekendEdition?: boolean;
  /** 已读标记 */
  read: boolean;
}

/** AI 提取结果（收件箱处理产物） */
export interface ExtractResult {
  events: Array<Omit<ScheduleEvent, 'id' | 'status' | 'createTime'>>;
  todos: Array<Omit<TodoItem, 'id' | 'status' | 'createTime'>>;
  collection?: Omit<CollectionItem, 'id' | 'createTime'>;
  /** 无法归类时的原文备注 */
  note?: string;
}

/** 用户资料与设置 */
export interface UserProfile {
  openid: string;
  nickname: string;
  /** 晨报推送时间 'HH:mm' */
  briefingTime: string;
  /** 内容偏好标签 */
  preferences: string[];
  subscribed: boolean;
  /** 订阅到期时间，null 为未订阅 */
  expiredAt: string | null;
  isEarlyBird: boolean;
}

/** 用量（免费额度） */
export interface Usage {
  /** 本月已用语音次数 */
  voiceUsed: number;
  /** 语音月额度（-1 表示无限） */
  voiceQuota: number;
  /** 当前收藏数量 */
  collectionCount: number;
  /** 收藏额度（-1 表示无限） */
  collectionQuota: number;
}

/** 对话消息 */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  type: 'text' | 'voice';
  content: string;
  /** 语音消息时长（秒） */
  duration?: number;
  /** 是否由深度思考模式生成 */
  deep?: boolean;
  /** AI 附带图片（真实内容图：资讯封面/商品图等） */
  image?: string;
  createTime: string;
}

/** 热点资讯（今日热点页，v2.0） */
export interface HotspotNews {
  id: string;
  title: string;
  summary: string;
  /** 来源媒体名（合规要求：必须标注） */
  source: string;
  /** 原文链接（若有） */
  url?: string;
  /** 同事件的其他来源媒体名（跨源合并时才有；不含本条自身 source，按出现顺序去重，上限 8） */
  alsoFrom?: string[];
  /** 真实配图（RSS media/enclosure/正文首图；AI 发图来源） */
  image?: string;
  tags: string[];
  createTime: string;
  /** AI 精选筛选理由（仅 AI 精选结果携带；合规要求标注 AI 生成） */
  aiReason?: string;
  /** Why it matters（P1-X1：为什么值得看，AI 过滤时生成，≤30 字；缺失不显示） */
  whyItMatters?: string;
}

/** 浏览历史条目（v2.0） */
export interface HistoryEntry {
  id: string;
  /** 资讯标题 */
  title: string;
  /** 来源 */
  source?: string;
  /** 浏览时间 ISO */
  viewedAt: string;
}

/** 支付订单 */
export interface PayOrder {
  orderId: string;
  planId: 'earlybird_monthly' | 'monthly' | 'yearly';
  price: number;
  status: 'created' | 'paid' | 'expired';
}
