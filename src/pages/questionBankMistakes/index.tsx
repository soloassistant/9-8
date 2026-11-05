/**
 * pages/questionBankMistakes —— 错题本（接入批次 5/6）。
 * 数据来自「本机题库 + 答题记录」两处：任一读取失败都渲染失败态 + 重试，
 * 不许把「记录读不出来」显示成「没有错题」。已删除题目不会出现在列表里。
 */
import { useCallback, useEffect, useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useT } from '@/store/language';
import { brandVars, useThemeStore } from '@/store/theme';
import type { Question } from '@/types/questionBank';
import type { ProgressEntry } from '@/data/questionBankProgress';
import { createQuestionBankProgress } from '@/data/questionBankProgress';
import { loadQuestionBank } from '@/data/questionBankQuery';
import styles from '../questionBank/shared.module.scss';

interface MistakeItem { entry: ProgressEntry; question: Question }
type LoadState =
  | { status: 'loading' }
  | { status: 'error'; source: 'bank' | 'progress'; message: string }
  | { status: 'ready'; items: MistakeItem[] };

export default function QuestionBankMistakesPage() {
  const t = useT();
  const { theme } = useThemeStore();
  const [view, setView] = useState<LoadState>({ status: 'loading' });

  const load = useCallback(() => {
    setView({ status: 'loading' });
    void Promise.resolve().then(() => {
      const bank = loadQuestionBank(Taro);
      if (bank.status === 'error') {
        setView({ status: 'error', source: 'bank', message: bank.message });
        return;
      }
      try {
        const entries = createQuestionBankProgress(Taro).mistakes();
        const items = entries
          .map((entry) => ({ entry, question: bank.questions.find((q) => q.id === entry.questionId) }))
          .filter((x): x is MistakeItem => !!x.question);
        setView({ status: 'ready', items });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setView({ status: 'error', source: 'progress', message });
      }
    });
  }, []);
  useEffect(load, [load]);

  const backToList = () => {
    const pages = Taro.getCurrentPages();
    if (pages.length > 1) {
      Taro.navigateBack().catch(() => Taro.reLaunch({ url: '/pages/questionBank/index' }));
      return;
    }
    Taro.reLaunch({ url: '/pages/questionBank/index' });
  };

  const redo = (id: string) => {
    Taro.navigateTo({ url: `/pages/questionBankAnswer/index?id=${id}` }).catch((err) =>
      console.warn('[QuestionBankMistakes] navigate failed:', err)
    );
  };

  const renderBody = () => {
    if (view.status === 'loading') {
      return <View className={styles.state}><Text className={styles.stateTitle}>{t('qb.loading')}</Text></View>;
    }
    if (view.status === 'error') {
      return (
        <View className={styles.state}>
          <Text className={styles.stateIcon}>⚠️</Text>
          <Text className={styles.stateTitle}>{t(view.source === 'bank' ? 'qb.loadFailed' : 'qb.progressFailed')}</Text>
          <Text className={styles.stateDesc}>{t(view.source === 'bank' ? 'qb.loadFailedHint' : 'qb.progressFailedHint')}</Text>
          <View className={styles.retry} onClick={load}><Text className={styles.retryText}>{t('qb.retry')}</Text></View>
        </View>
      );
    }
    if (view.items.length === 0) {
      return (
        <View className={styles.state}>
          <Text className={styles.stateIcon}>✅</Text>
          <Text className={styles.stateTitle}>{t('qb.mistakesEmpty')}</Text>
          <Text className={styles.stateDesc}>{t('qb.mistakesEmptyHint')}</Text>
        </View>
      );
    }
    return view.items.map(({ entry, question }) => (
      <View key={entry.questionId} className={styles.card} onClick={() => redo(entry.questionId)}>
        <Text className={styles.stem} numberOfLines={2}>{question.stem}</Text>
        <View className={styles.meta}>
          <Text className={styles.badge}>{t(`qb.system.${question.examSystem}`)}</Text>
          <Text className={styles.badge}>{question.subject}</Text>
          <Text className={styles.badge}>{t('qb.wrongTimes', { n: entry.wrongCount })}</Text>
          <Text className={styles.badge}>{t('qb.redo')}</Text>
        </View>
      </View>
    ));
  };

  return (
    <View className={styles.page} style={brandVars(theme)}>
      <View className={styles.header}>
        <View className={styles.back} onClick={backToList}>
          <Text className={styles.backIcon}>‹</Text>
          <Text className={styles.backText}>{t('common.back')}</Text>
        </View>
        <Text className={styles.title}>{t('qb.mistakesTitle')}</Text>
      </View>
      {view.status === 'ready' && view.items.length > 0 ? (
        <Text className={styles.count}>{t('qb.count', { n: view.items.length })}</Text>
      ) : null}
      {renderBody()}
    </View>
  );
}
