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
 *   · 撤回 = 不再写入新数据；**已生成的记录保留**（不静默删除用户数据），
 *     用户可在运动页记录列表里逐条删除。
 */
import Taro from '@tarojs/taro';
import { dict, useLanguageStore } from '@/store/language';

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
  return true;
}

/**
 * 撤回单独同意：只清同意标记，**不删任何已有运动记录**。
 * 撤回后 hasHealthConsent() 为 false → 所有写入路径重新拦截。
 */
export function withdrawHealthConsent(): void {
  try {
    Taro.removeStorageSync(HEALTH_CONSENT_KEY);
  } catch (err) {
    console.warn('[healthConsent] 撤回写入失败:', err);
  }
}

/** 撤回确认弹窗（统一文案，避免各页面自己抄一份） */
export async function confirmWithdrawHealthConsent(): Promise<boolean> {
  try {
    const res = await Taro.showModal({
      title: t('health.withdrawTitle'),
      content: t('health.withdrawBody'),
      confirmText: t('health.withdrawConfirm'),
      cancelText: t('common.cancel')
    });
    if (!res.confirm) return false;
  } catch {
    return false;
  }
  withdrawHealthConsent();
  return true;
}
