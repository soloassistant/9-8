/**
 * 用户偏好模块（竞品分析 P0-L2 / P1-X3 / P1-X6 / P2-X11 的统一契约）
 *
 * 设计要点：
 * - 单 Storage key `mb-prefs`，对象整体读写；字段级更新走 updatePrefs()
 * - 读取永远 merge DEFAULT_PREFS（新字段对旧数据向后兼容）
 * - 所有 Storage 读写 try/catch，失败返回默认值，不阻塞调用方
 * - key 契约对全项目固定，各页面只 import 本模块，不允许自行拼 storage key
 */
import Taro from '@tarojs/taro';

export const PREFS_STORAGE_KEY = 'mb-prefs';

export type PushFreq = 'low' | 'mid' | 'high';

export interface UserPrefs {
  /** L2：AI 精选总开关（false = 资讯按时间排序，不使用 AI 筛选——算法推荐关闭入口） */
  aiFilterEnabled: boolean;
  /** X3：推送数量偏好（较少/适中/较多） */
  pushFreq: PushFreq;
  /** X3：免打扰时段起止（'HH:mm'，默认 22:00–07:00） */
  dndStart: string;
  dndEnd: string;
  /** X3：按模块开关推送 */
  modules: {
    weather: boolean;
    events: boolean;
    news: boolean;
    review: boolean;
  };
  /** X3/墨迹式：周末免打扰（周末不发推送提醒） */
  weekendQuiet: boolean;
  /** X6：周末轻量版（周末晨报资讯减量+周复盘置顶） */
  weekendEdition: boolean;
  /** X11：未成年人模式（开启后热点页隐藏财经/社会类条目并显示时长提醒） */
  minorMode: boolean;
  /** X11：家长密码（4 位数字；仅本机家长控制用途，非安全凭据） */
  parentPin: string;
}

export const DEFAULT_PREFS: UserPrefs = {
  aiFilterEnabled: true,
  pushFreq: 'mid',
  dndStart: '22:00',
  dndEnd: '07:00',
  modules: { weather: true, events: true, news: true, review: true },
  weekendQuiet: false,
  weekendEdition: true,
  minorMode: false,
  parentPin: ''
};

function readRaw(): Partial<UserPrefs> | null {
  try {
    const raw = Taro.getStorageSync(PREFS_STORAGE_KEY);
    if (!raw || typeof raw !== 'object') return null;
    return raw as Partial<UserPrefs>;
  } catch {
    console.warn('[prefs] read failed');
    return null;
  }
}

/** 读取偏好（永远返回完整对象，缺省字段用默认值补齐） */
export function readPrefs(): UserPrefs {
  const raw = readRaw();
  const d = DEFAULT_PREFS;
  if (!raw) return { ...d, modules: { ...d.modules } };
  return {
    aiFilterEnabled: raw.aiFilterEnabled !== false,
    pushFreq: raw.pushFreq === 'low' || raw.pushFreq === 'high' ? raw.pushFreq : 'mid',
    dndStart: typeof raw.dndStart === 'string' ? raw.dndStart : d.dndStart,
    dndEnd: typeof raw.dndEnd === 'string' ? raw.dndEnd : d.dndEnd,
    modules: {
      weather: raw.modules?.weather !== false,
      events: raw.modules?.events !== false,
      news: raw.modules?.news !== false,
      review: raw.modules?.review !== false
    },
    weekendQuiet: raw.weekendQuiet === true,
    weekendEdition: raw.weekendEdition !== false,
    minorMode: raw.minorMode === true,
    parentPin: typeof raw.parentPin === 'string' ? raw.parentPin : ''
  };
}

/** 字段级更新并落盘；返回更新后的完整偏好 */
export function updatePrefs(patch: Partial<UserPrefs>): UserPrefs {
  const next = { ...readPrefs(), ...patch };
  try {
    Taro.setStorageSync(PREFS_STORAGE_KEY, next);
  } catch {
    console.warn('[prefs] write failed');
  }
  return next;
}

/** 是否处于免打扰时段（跨零点区间如 22:00–07:00 也正确处理） */
export function isInDnd(now = new Date()): boolean {
  const p = readPrefs();
  const cur = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = p.dndStart.split(':').map((n) => parseInt(n, 10) || 0);
  const [eh, em] = p.dndEnd.split(':').map((n) => parseInt(n, 10) || 0);
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  if (start === end) return false;
  return start > end ? cur >= start || cur < end : cur >= start && cur < end;
}
