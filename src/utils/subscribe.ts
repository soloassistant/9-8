/**
 * 一次性订阅消息授权（个人主体下**唯一**能把用户拉回来的触达通道）。
 *
 * 背景：PM 小程序竞品分析（2026-09-24）指出，个人主体拿不到长期订阅（仅政务/医疗/交通/金融/教育），
 * 也开不了服务号（个人只能注册订阅号且无法微信认证 → 模板消息不可用）。所以**一次性订阅的授权率，
 * 就是这款产品留存能力的上限**，且用户勾「拒绝并记住」后永久触达不到、不可逆。
 *
 * 设计要点：
 * - **只自动弹一次**：用户给出任何终态（accept/reject/ban）后不再自动弹，避免骚扰；
 *   但页面常驻的「订阅」按钮始终可手动触发（force=true）。
 * - **ban/filter（= 次数用尽或勾选「拒绝并记住」）→ 永久不再弹**，并且单独标记，便于排查触达率。
 * - 记录 attempts/accepts 计数 + 最近终态，用于评估授权率（当前是完全盲区）。
 * - 模板 id 若仍是占位符（TODO_*）则直接 noop 且**不计入统计**，避免污染授权率数据。
 * - storage 读写全 try/catch，失败只 warn，**绝不 throw**、绝不阻断晨报渲染。
 */
import Taro from '@tarojs/taro';

const DENY_KEY = 'subscribeDeny';
const STAT_KEY = 'subscribeStat';
/** 最近一次成功授权的时间戳（X4 订阅到期管理基础设施） */
const AUTH_AT_KEY = 'mb-sub-auth-at';

/**
 * X4 有效期口径：微信订阅消息**一次授权 ≈ 一条下发机会**，无长期订阅可用（个人主体），
 * 故按「一次授权的合理有效期 = 7 天」滚动看待：授权满 7 天即视同这条推送机会已耗尽，
 * 需要引导用户重新授权。常量集中在此，避免散落魔法数字。
 */
const SUBSCRIPTION_VALIDITY_DAYS = 7;
/** 临期阈值：授权龄 > 6 天（即进入第 7 天）视为临期，可触发续订提醒（由有效期口径推导：7-1=6） */
const SUBSCRIPTION_NEAR_EXPIRY_DAYS = SUBSCRIPTION_VALIDITY_DAYS - 1;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 记录最近一次成功授权时间（仅 accept 时调用；storage 失败只 warn，绝不 throw） */
function writeAuthAt() {
  try {
    Taro.setStorageSync(AUTH_AT_KEY, Date.now());
  } catch (e) {
    console.warn('[subscribe] writeAuthAt failed:', e);
  }
}

/** 读取最近一次成功授权时间；从未授权或数据异常返回 0 */
function readAuthAt(): number {
  try {
    const v = Taro.getStorageSync(AUTH_AT_KEY);
    return typeof v === 'number' && v > 0 ? v : 0;
  } catch {
    return 0;
  }
}

interface SubscribeDeny {
  /** 已自动弹过且用户给出过任何终态，不再自动弹 */
  prompted: boolean;
  /** 用户点过「拒绝」 */
  rejected: boolean;
  /** 微信返回 ban / filter（次数用尽或「拒绝并记住」，永久触达不到） */
  banned: boolean;
}

interface SubscribeStat {
  attempts: number;
  accepts: number;
  /** 最近一次终态，排查触达率用 */
  last: string;
}

const EMPTY_DENY: SubscribeDeny = { prompted: false, rejected: false, banned: false };
const EMPTY_STAT: SubscribeStat = { attempts: 0, accepts: 0, last: '' };

function readDeny(): SubscribeDeny {
  try {
    return { ...EMPTY_DENY, ...(Taro.getStorageSync(DENY_KEY) || {}) };
  } catch {
    return { ...EMPTY_DENY };
  }
}
function writeDeny(d: SubscribeDeny) {
  try {
    Taro.setStorageSync(DENY_KEY, d);
  } catch (e) {
    console.warn('[subscribe] writeDeny failed:', e);
  }
}
function readStat(): SubscribeStat {
  try {
    return { ...EMPTY_STAT, ...(Taro.getStorageSync(STAT_KEY) || {}) };
  } catch {
    return { ...EMPTY_STAT };
  }
}
function writeStat(s: SubscribeStat) {
  try {
    Taro.setStorageSync(STAT_KEY, s);
  } catch (e) {
    console.warn('[subscribe] writeStat failed:', e);
  }
}

/** 自动弹窗是否允许：仅当用户从未被问过、且未拒绝/未被封禁 */
export function canPromptSubscribe(): boolean {
  const d = readDeny();
  return !d.prompted && !d.rejected && !d.banned;
}

/** 诊断用：返回当前订阅授权画像（触达率排查） */
export function getSubscribeProfile(): SubscribeDeny & SubscribeStat {
  return { ...readDeny(), ...readStat() };
}

/**
 * X4：距最近一次成功授权的天数。
 * 从未成功授权过返回 -1（区分「未授权」与「第 0 天」）。
 */
export function getSubscriptionAgeDays(): number {
  const at = readAuthAt();
  if (!at) return -1;
  return Math.floor((Date.now() - at) / DAY_MS);
}

/**
 * X4：订阅是否临期（授权龄 > SUBSCRIPTION_NEAR_EXPIRY_DAYS 天，即进入第 7 天）。
 * 从未授权过（age=-1）不算临期——首次弹窗由 canPromptSubscribe 的自动逻辑负责，
 * 临期判定只服务于「已授权但订阅机会已耗尽/将耗尽」的续订提醒。
 *
 * 建议接线点（UI 工单，不在本轮范围）：晨报页加载时若 isSubscriptionStale() 为 true，
 * 提示用户续订（i18n 键 subscribe.renew 已预置），用户点击后调 promptSubscribe(templateId, true)。
 */
export function isSubscriptionStale(): boolean {
  const age = getSubscriptionAgeDays();
  return age >= 0 && age > SUBSCRIPTION_NEAR_EXPIRY_DAYS;
}

export type SubscribeStatus = 'accept' | 'reject' | 'ban' | 'noop';

/**
 * 弹出订阅授权。
 * @param templateId 微信订阅消息模板 id（未配置为 TODO_* 时直接 noop，不污染统计）
 * @param force 为 true 时忽略「已弹过」限制（页面常驻按钮的手动触发用）
 * @returns 标准化终态
 */
export async function promptSubscribe(templateId: string, force = false): Promise<SubscribeStatus> {
  if (!force && !canPromptSubscribe()) return 'noop';
  if (!templateId || templateId.startsWith('TODO')) {
    console.warn('[subscribe] 模板 id 未配置（仍是占位符），跳过弹窗，不计入统计');
    return 'noop';
  }

  let res: Record<string, string> | undefined;
  try {
    // Taro 类型把仅支付宝的 entityIds 标为必填（weapp 运行时只需 tmplIds），双段断言屏蔽该类型缺陷
    res = (await Taro.requestSubscribeMessage({ tmplIds: [templateId] } as unknown as Taro.requestSubscribeMessage.Option)) as Record<string, string>;
  } catch {
    // 用户取消授权弹窗或系统失败：视为暂不订阅，不计入黑名单（下次可再问）
    return 'reject';
  }

  const code = res?.[templateId];
  const stat = readStat();
  stat.attempts += 1;
  const deny = readDeny();
  deny.prompted = true; // 任何终态后都不再自动弹

  if (code === 'accept') {
    stat.accepts += 1;
    stat.last = 'accept';
    writeAuthAt(); // X4：记录成功授权时间，供 getSubscriptionAgeDays/isSubscriptionStale 到期提醒使用
    writeStat(stat);
    writeDeny(deny);
    return 'accept';
  }
  if (code === 'ban' || code === 'filter') {
    deny.banned = true;
    stat.last = code;
    writeStat(stat);
    writeDeny(deny);
    return 'ban';
  }
  // reject 或其它值：记入 rejected，避免短时间内重复弹
  deny.rejected = true;
  stat.last = String(code || 'reject');
  writeStat(stat);
  writeDeny(deny);
  return 'reject';
}
