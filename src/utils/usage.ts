/** 真实用量记账：语音助手本月已用次数（getUsage 展示 + 免费额度校验共用同一份计数）。
 *  H5 本地 storage 记账（key 已加入云同步）；weapp 真机由云函数 getUsage 按 openid 记账，本地计数仅作冗余。 */
import Taro from '@tarojs/taro';

const KEY = 'usage-voice';

interface VoiceUsage {
  /** 月份 'YYYY-MM'，跨月自动清零 */
  ym: string;
  n: number;
}

function monthKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 本月已用语音次数（非本月数据视为 0） */
export function readVoiceUsed(): number {
  try {
    const v = Taro.getStorageSync(KEY) as VoiceUsage | '';
    if (v && typeof v === 'object' && v.ym === monthKey()) return Number(v.n) || 0;
  } catch (err) {
    console.warn('[usage] read failed:', err);
  }
  return 0;
}

/** 语音消息确认发送后 +1，返回累计值 */
export function bumpVoiceUsage(): number {
  const n = readVoiceUsed() + 1;
  try {
    Taro.setStorageSync(KEY, { ym: monthKey(), n });
  } catch (err) {
    console.warn('[usage] bump failed:', err);
  }
  return n;
}
