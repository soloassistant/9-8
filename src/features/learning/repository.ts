/**
 * 学习平台在 Taro 宿主中的唯一数据入口。
 *
 * 页面与宿主摘要都通过这里取 repository，不再直接读写学习 storage，
 * 保证 Web 展示版与 Taro 过渡入口共用同一份领业务逻辑（learning-core）。
 */
import { LocalLearningRepository } from '@learning/core';
import { LEARNING_STORAGE_KEYS, createTaroStorage } from './adapters/taro-storage';

let repository: LocalLearningRepository | null = null;

export function getLearningRepository(): LocalLearningRepository {
  if (!repository) {
    repository = new LocalLearningRepository(createTaroStorage(), LEARNING_STORAGE_KEYS);
  }
  return repository;
}
