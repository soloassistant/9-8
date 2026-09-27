/**
 * 权限底座（T00 前置批次，A/B/C/D 四批公共依赖）
 *
 * 职责：
 * 1. 麦克风 / 位置两类敏感权限的「本地同意态 + 拒绝计数 + 系统授权双向校验」；
 * 2. 通用权限说明弹窗所需的文案 key 常量（只存 key，实际文案由 i18n 提供）；
 * 3. 个性化推荐开关（C-03）持久化。
 *
 * 约定：
 * - 所有 storage 读写统一 Taro.getStorageSync / setStorageSync + try/catch，失败只 console.warn；
 * - storage key 统一 `mb_` 前缀：`mb_perm_<name>`、`mb_personalization`；
 * - 所有对外函数**绝不 throw**，异常一律 catch 后返回降级值。
 */
import Taro from '@tarojs/taro';
import type { LangKey } from '../store/language';

/** 受管控的敏感权限类型 */
export type PermissionName = 'microphone' | 'location';

/** 权限状态：未询问 / 已同意 / 已拒绝（含本地拒绝过与系统侧拒绝） */
export type PermissionState = 'unknown' | 'granted' | 'denied';

/** 权限在本地的持久化记录 */
export interface PermissionRecord {
  agreed: boolean;
  /** 连续拒绝次数：达到 PERMISSION_DENY_LIMIT 后不再弹窗，降级为轻量提示条 */
  deniedCount: number;
  updatedAt: number;
}

/** 弹窗 / 提示条所需文案 key（只存 key 字符串，实际文案由 useT() 取） */
export interface PermissionText {
  /** 弹窗标题：perm.micTitle / perm.locTitle */
  titleKey: LangKey;
  /** 弹窗正文：perm.micBody / perm.locBody */
  descKey: LangKey;
  /** 拒绝后的轻量提示条：perm.micDeniedBar / perm.locDeniedBar */
  denyGuideKey: LangKey;
  /** 多次拒绝后的提示条：perm.repeatDenied / perm.repeatDeniedLoc */
  repeatDeniedKey: LangKey;
  /** 同意按钮：perm.agree */
  agreeKey: LangKey;
  /** 拒绝按钮：perm.decline */
  declineKey: LangKey;
  /** 去设置按钮：perm.goSettings */
  settingsKey: LangKey;
}

/** 权限 → 文案 key 映射表 */
export const PERMISSION_TEXT: Record<PermissionName, PermissionText> = {
  microphone: {
    titleKey: 'perm.micTitle',
    descKey: 'perm.micBody',
    denyGuideKey: 'perm.micDeniedBar',
    repeatDeniedKey: 'perm.repeatDenied',
    agreeKey: 'perm.agree',
    declineKey: 'perm.decline',
    settingsKey: 'perm.goSettings'
  },
  location: {
    titleKey: 'perm.locTitle',
    descKey: 'perm.locBody',
    denyGuideKey: 'perm.locDeniedBar',
    repeatDeniedKey: 'perm.repeatDeniedLoc',
    agreeKey: 'perm.agree',
    declineKey: 'perm.decline',
    settingsKey: 'perm.goSettings'
  }
};

/** 微信 scope 映射（仅 weapp 分支使用） */
const SCOPE_MAP: Record<PermissionName, 'scope.record' | 'scope.userLocation'> = {
  microphone: 'scope.record',
  location: 'scope.userLocation'
};

const STORAGE_PREFIX = 'mb_perm_';
const PERSONALIZATION_KEY = 'mb_personalization';

/** 连续拒绝达到该次数后不再弹窗，改由调用方展示轻量提示条 +「去设置」按钮 */
export const PERMISSION_DENY_LIMIT = 3;

const isWeapp = process.env.TARO_ENV === 'weapp';

/* ------------------------------------------------------------------ */
/* storage 读写（统一 try/catch，失败只 warn）                          */
/* ------------------------------------------------------------------ */

function storageKey(name: PermissionName): string {
  return `${STORAGE_PREFIX}${name}`;
}

function emptyRecord(): PermissionRecord {
  return { agreed: false, deniedCount: 0, updatedAt: 0 };
}

/** 读取本地权限记录（无记录 / 读失败返回空记录） */
export function readPermission(name: PermissionName): PermissionRecord {
  try {
    const raw = Taro.getStorageSync(storageKey(name));
    if (raw && typeof raw === 'object') {
      return {
        agreed: raw.agreed === true,
        deniedCount: typeof raw.deniedCount === 'number' ? raw.deniedCount : 0,
        updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0
      };
    }
  } catch (err) {
    console.warn('[permission] read failed:', name, err);
  }
  return emptyRecord();
}

function writePermission(name: PermissionName, record: PermissionRecord): PermissionRecord {
  try {
    Taro.setStorageSync(storageKey(name), record);
  } catch (err) {
    console.warn('[permission] write failed:', name, err);
  }
  return record;
}

/* ------------------------------------------------------------------ */
/* 状态判定与写入                                                       */
/* ------------------------------------------------------------------ */

/** 记录一次授权结果：同意即清零拒绝计数，拒绝则连续计数 +1 */
export function recordPermissionResult(name: PermissionName, granted: boolean): PermissionRecord {
  const prev = readPermission(name);
  const next: PermissionRecord = granted
    ? { agreed: true, deniedCount: 0, updatedAt: Date.now() }
    : { agreed: false, deniedCount: prev.deniedCount + 1, updatedAt: Date.now() };
  return writePermission(name, next);
}

/**
 * 是否还应弹权限说明弹窗（降级判定出口）：
 * 已同意不弹；连续拒绝达到 PERMISSION_DENY_LIMIT 次不再弹（调用方改渲染轻量提示条 +「去设置」）。
 */
export function shouldShowDialog(name: PermissionName): boolean {
  const record = readPermission(name);
  if (record.agreed) return false;
  return record.deniedCount < PERMISSION_DENY_LIMIT;
}

/** 是否已进入降级态（≥3 次拒绝），供调用方决定渲染弹窗还是提示条 */
export function isDeniedDegraded(name: PermissionName): boolean {
  return !shouldShowDialog(name) && !readPermission(name).agreed;
}

/* ------------------------------------------------------------------ */
/* 与系统授权的双向校验                                                 */
/* ------------------------------------------------------------------ */

const inflightSync: Partial<Record<PermissionName, boolean>> = {};

/** weapp：读 Taro.getSetting() 与本地记录对账并回写；H5：no-op */
export async function syncWithSystemSetting(name: PermissionName): Promise<PermissionState> {
  if (!isWeapp || inflightSync[name]) return getLocalState(name);
  inflightSync[name] = true;
  try {
    const res = await Taro.getSetting();
    const scope = SCOPE_MAP[name];
    const granted = !!(res && res.authSetting && res.authSetting[scope] === true);
    const record = readPermission(name);
    if (granted && !record.agreed) {
      writePermission(name, { agreed: true, deniedCount: 0, updatedAt: Date.now() });
    } else if (!granted && record.agreed) {
      // 系统侧已撤销：降级为已拒绝，但不累加计数（用户并非主动拒绝弹窗）
      writePermission(name, { agreed: false, deniedCount: record.deniedCount, updatedAt: Date.now() });
    }
    return granted ? 'granted' : record.deniedCount > 0 ? 'denied' : 'unknown';
  } catch (err) {
    console.warn('[permission] getSetting failed:', name, err);
    return getLocalState(name);
  } finally {
    inflightSync[name] = false;
  }
}

function getLocalState(name: PermissionName): PermissionState {
  const record = readPermission(name);
  if (record.agreed) return 'granted';
  if (record.deniedCount > 0) return 'denied';
  return 'unknown';
}

/* ------------------------------------------------------------------ */
/* 打开系统设置                                                         */
/* ------------------------------------------------------------------ */

/**
 * 打开系统授权设置页：
 * - weapp：Taro.openSetting()，返回后自动与本地记录对账，成功返回 true；
 * - H5：无此能力，no-op 并返回 false（调用方改提示「请在浏览器设置中开启」）。
 */
export async function openAppSetting(name?: PermissionName): Promise<boolean> {
  if (!isWeapp) return false;
  try {
    await Taro.openSetting();
    if (name) await syncWithSystemSetting(name);
    return true;
  } catch (err) {
    console.warn('[permission] openSetting failed:', err);
    return false;
  }
}

/** 设计文档别名：openSystemSettings */
export function openSystemSettings(name?: PermissionName): Promise<boolean> {
  return openAppSetting(name);
}

/* ------------------------------------------------------------------ */
/* 统一授权入口（双端双轨，绝不 throw）                                  */
/* ------------------------------------------------------------------ */

/** weapp：Taro.authorize 拉起授权；已授权直接返回 true */
async function authorizeWeapp(name: PermissionName): Promise<boolean> {
  const scope = SCOPE_MAP[name];
  try {
    const setting = await Taro.getSetting();
    if (setting && setting.authSetting && setting.authSetting[scope] === true) {
      recordPermissionResult(name, true);
      return true;
    }
  } catch (err) {
    console.warn('[permission] getSetting before authorize failed:', name, err);
  }
  try {
    await Taro.authorize({ scope });
    recordPermissionResult(name, true);
    return true;
  } catch (err) {
    console.warn('[permission] authorize denied:', name, err);
    recordPermissionResult(name, false);
    return false;
  }
}

/** H5：麦克风走 getUserMedia（取到流立即释放），失败即视为拒绝 */
async function requestH5Microphone(): Promise<boolean> {
  if (typeof navigator === 'undefined') return false;
  const media = navigator.mediaDevices;
  if (!media || typeof media.getUserMedia !== 'function') return false;
  try {
    const stream = await media.getUserMedia({ audio: true });
    // 只为探测授权状态，拿到流立即释放，避免占用麦克风指示灯
    if (stream && typeof stream.getTracks === 'function') {
      stream.getTracks().forEach((track) => track.stop());
    }
    return true;
  } catch {
    return false;
  }
}

/** H5：位置走 navigator.geolocation，失败即视为拒绝（不阻断） */
async function requestH5Location(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return false;
  return new Promise<boolean>((resolve) => {
    try {
      navigator.geolocation.getCurrentPosition(
        () => resolve(true),
        () => resolve(false),
        { timeout: 10000, maximumAge: 60000 }
      );
    } catch {
      resolve(false);
    }
  });
}

/**
 * 统一授权入口（双端双轨）：
 * - 本地已同意 → 直接 true（weapp 顺带做一次系统侧对账）；
 * - 已进入降级态（≥3 次连续拒绝）→ 不再拉起系统弹窗，返回 false；
 * - weapp：Taro.getSetting → Taro.authorize；
 * - H5：麦克风 getUserMedia / 位置 geolocation，失败视为拒绝。
 * 任何异常都 catch 并 return false，绝不 throw。
 */
export async function ensurePermission(name: PermissionName): Promise<boolean> {
  try {
    const record = readPermission(name);
    if (record.agreed) {
      if (isWeapp) void syncWithSystemSetting(name);
      return true;
    }
    // 降级态：不再反复申请，由调用方展示提示条 + 去设置
    if (record.deniedCount >= PERMISSION_DENY_LIMIT) return false;

    const ok = isWeapp
      ? await authorizeWeapp(name)
      : name === 'microphone'
        ? await requestH5Microphone()
        : await requestH5Location();
    recordPermissionResult(name, ok);
    return ok;
  } catch (err) {
    console.warn('[permission] ensurePermission failed:', name, err);
    recordPermissionResult(name, false);
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 个性化推荐开关（C-03）                                               */
/* ------------------------------------------------------------------ */

/** 个性化推荐开关，默认开启；读失败同样返回 true */
export function getPersonalization(): boolean {
  try {
    const raw = Taro.getStorageSync(PERSONALIZATION_KEY);
    if (raw === undefined || raw === null || raw === '') return true;
    if (typeof raw === 'string') return raw !== 'false';
    return raw !== false;
  } catch (err) {
    console.warn('[permission] read personalization failed:', err);
    return true;
  }
}

/** 写入个性化推荐开关 */
export function setPersonalization(on: boolean): void {
  try {
    Taro.setStorageSync(PERSONALIZATION_KEY, on);
  } catch (err) {
    console.warn('[permission] write personalization failed:', err);
  }
}

/** 设计文档别名：readPersonalization */
export function readPersonalization(): boolean {
  return getPersonalization();
}
