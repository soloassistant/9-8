/** getUsage —— 用量真记账：语音=本月真实使用次数（utils/usage.ts 计数），
 *  收藏=收藏库真实条数（collectionStore）；额度为免费档产品配置；
 *  促销码兑换后（2026-10-25）按订阅档给 -1（不限），与云函数 getUsage 同口径。 */
import type { Usage } from '../types';
import { readVoiceUsed } from '../utils/usage';
import { listCollections } from './collectionStore';
import { readH5Subscription } from '../utils/promo';

export default function getUsage(): Usage {
  const sub = readH5Subscription();
  return {
    voiceUsed: readVoiceUsed(),
    voiceQuota: sub ? -1 : 20,
    collectionCount: listCollections().length,
    collectionQuota: sub ? -1 : 50
  };
}
