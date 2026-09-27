/** getUsage —— 用量真记账：语音=本月真实使用次数（utils/usage.ts 计数），
 *  收藏=收藏库真实条数（collectionStore）；额度为免费档产品配置。 */
import type { Usage } from '../types';
import { readVoiceUsed } from '../utils/usage';
import { listCollections } from './collectionStore';

export default function getUsage(): Usage {
  return {
    voiceUsed: readVoiceUsed(),
    voiceQuota: 20,
    collectionCount: listCollections().length,
    collectionQuota: 50
  };
}
