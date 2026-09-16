/**
 * 宿主摘要：只把展示所需的轻量信息暴露给主产品。
 * 计算逻辑留在 learning-core，宿主与 Web 展示版共用同一实现。
 */
import { getLearningSummary as coreSummary } from '@learning/core';
import type { LearningSummary } from '@learning/core';
import { getLearningRepository } from '../repository';

export type { LearningSummary };

export function getLearningSummary(): LearningSummary {
  return coreSummary(getLearningRepository());
}
