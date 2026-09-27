import { useEffect, useState } from 'react';
import { View, Text, ScrollView } from '@tarojs/components';
import classnames from 'classnames';
import { useT } from '@/store/language';
import type { ScheduleEvent } from '@/types';
import {
  type PlanProposal,
  type PlanApplyEvent,
  type SlotCandidate,
  toggleItemChecked,
  setAllChecked,
  toggleCandidatesOpen,
  selectCandidate,
  applyProposal,
  canApprove,
  checkedCount
} from '@/utils/schedule';
import styles from './index.module.scss';

export interface PlanProposalCardProps {
  /** 方案（由 buildPlanProposal 产出） */
  proposal: PlanProposal;
  /** 现有日程：换时段后重跑冲突检测用（缺省时空数组，仅不刷新冲突标记） */
  existing?: ScheduleEvent[];
  /** 批准：回调选中的 events（已按勾选 + 时间过滤） */
  onApprove: (events: PlanApplyEvent[], proposal: PlanProposal) => void;
  /** 放弃本次方案（不写库） */
  onAbandon: () => void;
  /** 是否显示「放弃」按钮（inbox 内可隐藏） */
  showAbandon?: boolean;
}

/** 排班方案卡片：逐项勾选 + 就地候选面板 + 全部/选中批准 */
function PlanProposalCard({
  proposal,
  existing = [],
  onApprove,
  onAbandon,
  showAbandon = true
}: PlanProposalCardProps) {
  const t = useT();
  const [p, setP] = useState<PlanProposal>(proposal);

  // 父级传入新方案时同步（如再次对话产生新 proposal）
  useEffect(() => {
    setP(proposal);
  }, [proposal]);

  const total = p.items.length;
  const checked = checkedCount(p);
  const approvable = canApprove(p);

  const handleToggle = (key: string) => setP((prev) => toggleItemChecked(prev, key));
  const handleOpen = (key: string) => setP((prev) => toggleCandidatesOpen(prev, key));
  // 换时段后必须带上 existing 重跑冲突检测，否则 ⚠️/✅ 标记不会刷新
  const handlePick = (key: string, candidate: SlotCandidate) =>
    setP((prev) => selectCandidate(prev, key, candidate, existing));

  const approve = (all: boolean) => {
    const src = all ? setAllChecked(p, true) : p;
    const { events } = applyProposal(src);
    onApprove(events, src);
  };

  return (
    <View className={styles.card}>
      <View className={styles.header}>
        <Text className={styles.title}>{t('plan.cardTitle', { n: total })}</Text>
      </View>
      <Text className={styles.hint}>{t('plan.cardHint')}</Text>
      {p.noBufferFallback ? (
        <Text className={styles.noBufferNote}>{t('plan.noBufferNote')}</Text>
      ) : null}

      <ScrollView scrollY className={styles.list}>
        {p.items.map((item) => (
          <View key={item.key} className={styles.item}>
            <View className={styles.itemMain}>
              <View
                className={classnames(styles.check, item.checked && styles.checked)}
                onClick={() => handleToggle(item.key)}
              >
                {item.checked ? <Text className={styles.checkIcon}>✓</Text> : null}
              </View>
              <View className={styles.itemBody}>
                <Text className={styles.itemTitle}>{item.title}</Text>
                <View className={styles.timeRow}>
                  {item.fromTime ? (
                    <Text className={styles.timeOld}>{item.fromTime}</Text>
                  ) : (
                    <Text className={styles.timeNewAdd}>{t('plan.reasonEarliest')}</Text>
                  )}
                  <Text className={styles.arrow}>→</Text>
                  <Text className={styles.timeNew}>{item.toTime}</Text>
                  {item.conflict ? (
                    <Text className={styles.conflictBadge}>
                      ⚠️ {t('plan.busyClash', { title: item.conflict.clashTitle })}
                    </Text>
                  ) : (
                    <Text className={styles.okBadge}>✅</Text>
                  )}
                </View>

                {item.candidates.length > 0 ? (
                  <View className={styles.candWrap}>
                    <Text className={styles.candToggle} onClick={() => handleOpen(item.key)}>
                      {item.candidatesOpen ? `${t('plan.candidateTitle')} ▲` : `${t('plan.changeTime')} ▼`}
                    </Text>
                    {item.candidatesOpen ? (
                      <View className={styles.candList}>
                        {item.candidates.map((c, i) => (
                          <View
                            key={`${c.startTime}-${i}`}
                            className={classnames(
                              styles.cand,
                              c.startTime === item.toTime && styles.candActive
                            )}
                            onClick={() => handlePick(item.key, c)}
                          >
                            <Text className={styles.candTime}>{c.startTime}</Text>
                            <Text
                              className={classnames(
                                styles.candTag,
                                c.busyness === 'free' && styles.tagFree,
                                c.busyness === 'clash' && styles.tagClash,
                                c.busyness === 'crowded' && styles.tagCrowded
                              )}
                            >
                              {c.busyness === 'free'
                                ? t('plan.busyFree')
                                : c.busyness === 'clash'
                                ? t('plan.busyClash', { title: c.clashTitle || '' })
                                : t('plan.busyCrowded', { n: c.dayCount || 0 })}
                            </Text>
                            <Text className={styles.candReason}>
                              {c.reason === 'habit'
                                ? t('plan.reasonHabit', {
                                    period:
                                      c.habitPeriod === 'am' ? t('plan.periodAm') : t('plan.periodPm')
                                  })
                                : c.reason === 'buffer'
                                ? t('plan.reasonBuffer')
                                : t('plan.reasonEarliest')}
                            </Text>
                          </View>
                        ))}
                      </View>
                    ) : null}
                  </View>
                ) : null}
              </View>
            </View>
          </View>
        ))}
      </ScrollView>

      <View className={styles.actions}>
        {showAbandon ? (
          <View className={styles.abandonBtn} onClick={onAbandon}>
            <Text className={styles.abandonText}>{t('plan.abandonTitle')}</Text>
          </View>
        ) : null}
        <View className={styles.approveBtns}>
          <View
            className={classnames(styles.approveBtn, !approvable && styles.approveDisabled)}
            onClick={() => approvable && approve(true)}
          >
            <Text className={styles.approveText}>{t('plan.approveAll', { n: total })}</Text>
          </View>
          <View
            className={classnames(styles.approveBtn, styles.approveSec, !approvable && styles.approveDisabled)}
            onClick={() => approvable && approve(false)}
          >
            <Text className={styles.approveText}>{t('plan.approveChecked', { n: checked })}</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

export default PlanProposalCard;
