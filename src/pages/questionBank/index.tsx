/**
 * pages/questionBank —— 题库列表（接入批次 2/5）。
 *
 * 三态是**三种不同的现实**，不许合并：
 *   · loading：正在读本机题库；
 *   · error  ：读不出来（存储损坏 / 版本不支持）—— 给重试，**绝不渲染成「题库 0 题」**；
 *   · ready  ：读出来了；再分「题库为空」与「筛选没命中」两种空态。
 * 筛选走 `questionBankQuery`：学科始终与体系成对使用（闭集 key 不扁平化）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, Input } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useT } from '@/store/language';
import { brandVars, useThemeStore } from '@/store/theme';
import type { ExamSystem, Question } from '@/types/questionBank';
import { filterQuestions, examSystemsOf, loadQuestionBank, subjectsOf } from '@/data/questionBankQuery';
import styles from './shared.module.scss';

type ViewState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; questions: Question[] };

const NO_QUESTIONS: Question[] = [];

export default function QuestionBankPage() {
  const t = useT();
  const { theme } = useThemeStore();
  const [view, setView] = useState<ViewState>({ status: 'loading' });
  const [system, setSystem] = useState<ExamSystem | null>(null);
  const [subject, setSubject] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');

  const load = useCallback(() => {
    setView({ status: 'loading' });
    // 读取是本地同步操作，但仍走一次事件循环：加载态是真实渲染出来的，不是装饰
    void Promise.resolve().then(() => {
      const result = loadQuestionBank(Taro);
      if (result.status === 'error') {
        console.error('[QuestionBank] load failed:', result.code, result.message);
        setView({ status: 'error', message: result.message });
      } else {
        setView({ status: 'ready', questions: result.questions });
      }
    });
  }, []);
  useEffect(load, [load]);

  const questions = view.status === 'ready' ? view.questions : NO_QUESTIONS;
  const systems = useMemo(() => examSystemsOf(questions), [questions]);
  const subjects = useMemo(() => (system ? subjectsOf(questions, system) : []), [questions, system]);
  const filtered = useMemo(
    () => filterQuestions(questions, { examSystem: system, subject, keyword }),
    [questions, system, subject, keyword]
  );

  const handleBack = useCallback(() => {
    const pages = Taro.getCurrentPages();
    if (pages.length > 1) {
      Taro.navigateBack().catch(() => Taro.reLaunch({ url: '/pages/briefing/index' }));
      return;
    }
    Taro.reLaunch({ url: '/pages/briefing/index' });
  }, []);

  const openQuestion = (q: Question) => {
    Taro.navigateTo({ url: `/pages/questionBankAnswer/index?id=${q.id}` }).catch((err) =>
      console.warn('[QuestionBank] navigate failed:', err)
    );
  };

  const changeSystem = (next: ExamSystem | null) => {
    setSystem(next);
    setSubject(null);
  };

  const renderBody = () => {
    if (view.status === 'loading') {
      return (
        <View className={styles.state}>
          <Text className={styles.stateTitle}>{t('qb.loading')}</Text>
        </View>
      );
    }
    if (view.status === 'error') {
      return (
        <View className={styles.state}>
          <Text className={styles.stateIcon}>⚠️</Text>
          <Text className={styles.stateTitle}>{t('qb.loadFailed')}</Text>
          <Text className={styles.stateDesc}>{t('qb.loadFailedHint')}</Text>
          <View className={styles.retry} onClick={load}>
            <Text className={styles.retryText}>{t('qb.retry')}</Text>
          </View>
        </View>
      );
    }
    if (questions.length === 0) {
      return (
        <View className={styles.state}>
          <Text className={styles.stateIcon}>📚</Text>
          <Text className={styles.stateTitle}>{t('qb.empty')}</Text>
          <Text className={styles.stateDesc}>{t('qb.emptyHint')}</Text>
        </View>
      );
    }
    if (filtered.length === 0) {
      return (
        <View className={styles.state}>
          <Text className={styles.stateIcon}>🔍</Text>
          <Text className={styles.stateTitle}>{t('qb.noMatch')}</Text>
          <Text className={styles.stateDesc}>{t('qb.noMatchHint')}</Text>
        </View>
      );
    }
    return filtered.map((q) => (
      <View key={q.id} className={styles.card} onClick={() => openQuestion(q)}>
        <Text className={styles.stem} numberOfLines={2}>{q.stem}</Text>
        <View className={styles.meta}>
          <Text className={styles.badge}>{t(`qb.system.${q.examSystem}`)}</Text>
          <Text className={styles.badge}>{q.subject}</Text>
          <Text className={styles.badge}>{t('qb.difficulty', { n: q.difficulty })}</Text>
        </View>
      </View>
    ));
  };

  const headerLink = (url: string, label: string) => (
    <Text className={styles.headerAction}
      onClick={() => Taro.navigateTo({ url }).catch((err) => console.warn('[QuestionBank] navigate failed:', err))}>
      {label}
    </Text>
  );

  return (
    <View className={styles.page} style={brandVars(theme)}>
      <View className={styles.header}>
        <View className={styles.back} onClick={handleBack}>
          <Text className={styles.backIcon}>‹</Text>
          <Text className={styles.backText}>{t('common.back')}</Text>
        </View>
        <Text className={styles.title}>{t('qb.title')}</Text>
        <View className={styles.headerLinks}>
          {headerLink('/pages/questionBankImport/index', t('qb.openImport'))}
          {headerLink('/pages/questionBankMistakes/index', t('qb.openMistakes'))}
        </View>
      </View>

      <Input
        className={styles.search}
        value={keyword}
        placeholder={t('qb.searchPlaceholder')}
        onInput={(e) => setKeyword(e.detail.value)}
      />

      {systems.length > 0 ? (
        <View className={styles.chips}>
          <Text className={!system ? `${styles.chip} ${styles.chipActive}` : styles.chip} onClick={() => changeSystem(null)}>
            {t('qb.allSystems')}
          </Text>
          {systems.map((s) => (
            <Text key={s} className={s === system ? `${styles.chip} ${styles.chipActive}` : styles.chip} onClick={() => changeSystem(s)}>
              {t(`qb.system.${s}`)}
            </Text>
          ))}
        </View>
      ) : null}

      {system && subjects.length > 0 ? (
        <View className={styles.chips}>
          <Text className={!subject ? `${styles.chip} ${styles.chipActive}` : styles.chip} onClick={() => setSubject(null)}>
            {t('qb.allSubjects')}
          </Text>
          {subjects.map((s) => (
            <Text key={s} className={s === subject ? `${styles.chip} ${styles.chipActive}` : styles.chip} onClick={() => setSubject(s)}>
              {s}
            </Text>
          ))}
        </View>
      ) : null}

      {view.status === 'ready' && filtered.length > 0 ? (
        <Text className={styles.count}>{t('qb.count', { n: filtered.length })}</Text>
      ) : null}

      {renderBody()}
    </View>
  );
}
