/**
 * 运动/健康数据的**单独同意**（PIPL 第 29 条：处理敏感个人信息须取得单独同意）。
 *
 * 为什么不能只靠首启那份「服务协议与隐私政策」：
 *   首启同意是一揽子告知，法律上不构成对敏感个人信息的单独同意。
 *   运动记录含时间、时长、距离与轨迹采样，属于敏感个人信息，必须单独取得、单独可撤回。
 *
 * 与 location.ts 的坐标出境同意同一套口径：
 *   · 版本化（条款变化 → 旧同意失效，重新征求）；
 *   · 取不到文案 / 弹窗失败 → 按「不同意」处理（宁可不记录，也不静默采集）；
 *   · 撤回 = 不再写入新数据 + **不再上传**（2026-11-04 修复：sportRuns 曾留在同步白名单，
 *     撤回后仍被 30s 轮询把 GPS 轨迹整包外传，与告知不符）；
 *     **已生成的本地记录保留**（不静默删除用户数据），云端副本默认删除（失败自动重试）。
 */
import Taro from '@tarojs/taro';
import { dict, useLanguageStore } from '@/store/language';
import {
  cancelPendingPush,
  isSyncKeyExcluded,
  purgeSyncKeysFromCloud,
  setSyncKeyExcluded,
  waitForPushIdle
} from './cloudSync';

/** 健康数据同意的 storage key（设备级，与云端同步白名单无关） */
export const HEALTH_CONSENT_KEY = 'health-data-consent';

/** 同意版本：用途 / 字段范围变化时递增 */
export const HEALTH_CONSENT_VERSION = 'v1-20261103';

export interface HealthConsentRecord {
  agreed: boolean;
  version: string;
  time: number;
  /** 采集端：h5 / weapp（审计时能区分同意发生在哪个端） */
  device: string;
}

type HealthDictKey =
  | 'health.consentTitle'
  | 'health.consentBody'
  | 'health.consentAgree'
  | 'health.consentDecline'
  | 'health.consentDenied'
  | 'health.statusGranted'
  | 'health.statusPrompt'
  | 'health.withdrawTitle'
  | 'health.withdrawBody'
  | 'health.withdrawConfirm'
  | 'health.withdrawn'
  | 'common.cancel';

function t(key: HealthDictKey): string {
  try {
    const lang = useLanguageStore.getState().lang;
    return dict[lang][key] ?? dict.zh[key] ?? '';
  } catch {
    return '';
  }
}

/** 是否已就「运动/健康数据处理」单独同意过 */
export function hasHealthConsent(): boolean {
  try {
    const rec = Taro.getStorageSync(HEALTH_CONSENT_KEY) as Partial<HealthConsentRecord> | '';
    return !!(rec && rec.agreed === true && rec.version === HEALTH_CONSENT_VERSION);
  } catch {
    return false;
  }
}

/**
 * 单独同意闸门：**未取得同意就不写入任何运动记录**。
 * 返回 false 时调用方负责给用户明确反馈（不能静默什么都不发生）。
 */
export async function ensureHealthConsent(): Promise<boolean> {
  if (hasHealthConsent()) return true;
  const title = t('health.consentTitle');
  const body = t('health.consentBody');
  // 文案缺失时不能弹空框让人点同意（等于没有告知）——按不同意处理
  if (!title || !body) {
    console.warn('[healthConsent] 同意文案缺失，已拒绝写入运动数据');
    return false;
  }
  try {
    const res = await Taro.showModal({
      title,
      content: body,
      confirmText: t('health.consentAgree'),
      cancelText: t('health.consentDecline')
    });
    if (!res.confirm) return false;
  } catch (err) {
    console.warn('[healthConsent] 同意弹窗失败，已拒绝写入运动数据:', err);
    return false;
  }
  try {
    Taro.setStorageSync(HEALTH_CONSENT_KEY, {
      agreed: true,
      version: HEALTH_CONSENT_VERSION,
      time: Date.now(),
      device: process.env.TARO_ENV || 'unknown'
    } as HealthConsentRecord);
  } catch (err) {
    // 记录失败不阻断本次（用户已明确同意），但下次会重新征求
    console.warn('[healthConsent] 同意记录写入失败（下次会重新征求）:', err);
  }
  // 重新授权 → 恢复跨设备备份（撤回期间被排除的运动记录重新进入同步范围）
  setSyncKeyExcluded('sportRuns', false);
  return true;
}

/** 同步范围里的运动记录键（与 cloudSync 的 SYNC_KEYS 同名；由 verify:health-consent 钉住） */
const SPORT_SYNC_KEY = 'sportRuns';

/** 撤回结果：删成功 / 删失败（已排队重试）/ 未登录（本机就没有云端副本） */
export type HealthWithdrawResult = 'deleted' | 'failed' | 'no-session';

/**
 * 撤回单独同意：清同意标记 + **把运动记录摘出同步范围** + 删除云端副本。
 *
 * 顺序是刻意的，每一步都对应一个真实的出网路径（顺序错了就等于没修）：
 *   ① 先摘同步范围：这是同步执行的，之后的任何 push 都不会再打包 sportRuns；
 *   ② 取消尚未发出的防抖推送：否则 1.5s 后还会按旧计划发一次带轨迹的请求；
 *   ③ 等在途推送落地：不能在「正在上传」时去删云端（删完又被追加一行）；
 *   ④ 再清同意标记：标记是「不再记录」的依据，不影响上面的上传闸；
 *   ⑤ 最后删云端副本：失败不清场，排队给下一轮推送重试（30s 一次）。
 *
 * **不删任何本机记录**（撤回 ≠ 删用户数据），用户可在记录列表里逐条删除。
 */
export async function withdrawHealthConsent(): Promise<HealthWithdrawResult> {
  setSyncKeyExcluded(SPORT_SYNC_KEY, true);
  cancelPendingPush();
  await waitForPushIdle();
  try {
    Taro.removeStorageSync(HEALTH_CONSENT_KEY);
  } catch (err) {
    console.warn('[healthConsent] 撤回写入失败:', err);
  }
  return purgeSyncKeysFromCloud([SPORT_SYNC_KEY]);
}

/** 撤回确认弹窗（统一文案，避免各页面自己抄一份）。返回 'cancelled' = 用户取消 */
export async function confirmWithdrawHealthConsent(): Promise<'cancelled' | HealthWithdrawResult> {
  try {
    const res = await Taro.showModal({
      title: t('health.withdrawTitle'),
      content: t('health.withdrawBody'),
      confirmText: t('health.withdrawConfirm'),
      cancelText: t('common.cancel')
    });
    if (!res.confirm) return 'cancelled';
  } catch {
    return 'cancelled';
  }
  return withdrawHealthConsent();
}

/** 启动时按已持久化的同意状态恢复排除表（刷新后仍生效，避免「一刷新又开始传」） */
export function syncHealthSyncExclusion(): void {
  // 没同意（含从未同意/已撤回/版本过期）→ 运动记录不参与同步
  setSyncKeyExcluded(SPORT_SYNC_KEY, !hasHealthConsent());
}

/** 供 UI / 门禁只读：运动记录当前是否被排除出同步 */
export function isSportRunsSyncExcluded(): boolean {
  return isSyncKeyExcluded(SPORT_SYNC_KEY);
}
