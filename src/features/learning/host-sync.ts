/**
 * 宿主同步适配器：只暴露需要同步的学习 storage key 名，不暴露学习存储实现。
 * key 定义的唯一来源是 adapters/taro-storage，避免两处硬编码漂移。
 */
import { LEARNING_STORAGE_KEYS } from './adapters/taro-storage';

export const LEARNING_SYNC_KEYS = [LEARNING_STORAGE_KEYS.store];
