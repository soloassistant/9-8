/**
 * pages/questionBankAnswer —— 答题 + 结果页（接入批次 4/6）。
 * 本笔只做「答题 + 判分 + 结果」，不写进度/错题本（下一笔接入）。
 * 读取失败仍走独立失败态 + 重试；题目被删是「不存在」而不是「出错」。
 */
import { useCallback, useEffect, useState } from 'react';
import { View, Text, Input } from '@tarojs/components';
import Taro, { useRouter } from '@tarojs/taro';
import { useT } from '@/store/language';
import { brandVars, useThemeStore } from '@/store/theme';
import type { Question } from '@/types/questionBank';
import { loadQuestionBank } from '@/data/questionBankQuery';
import { createQuestionBankProgress } from '@/data/questionBankProgress';
import { formatAnswerKey, gradeAnswer, isResponseComplete, type UserResponse } from '@/utils/questionBankGrading';
import styles from '../questionBank/shared.module.scss';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'missing' }
  | { status: 'ready'; question: Question };

function initialResponse(q: Question): UserResponse {
  if (q.type === 'multi') return [];
  if (q.type === 'fill') return Array.isArray(q.answerKey) ? q.answerKey.map(() => '') : [''];
  if (q.type === 'single') return '';
  return null;
}

export default function QuestionBankAnswerPage() {
  const t = useT();
  const { theme } = useThemeStore();
  const router = useRouter();
  const id = router.params.id || '';
  const [view, setView] = useState<LoadState>({ status: 'loading' });
  const [response, setResponse] = useState<UserResponse>(null);
  const [result, setResult] = useState<boolean | null>(null);

  const load = useCallback(() => {
    setView({ status: 'loading' });
    void Promise.resolve().then(() => {
      const loaded = loadQuestionBank(Taro);
      if (loaded.status === 'error') {
        console.error('[QuestionBankAnswer] load failed:', loaded.code, loaded.message);
        setView({ status: 'error', message: loaded.message });
        return;
      }
      const question = loaded.questions.find((q) => q.id === id);
      if (!question) {
        setView({ status: 'missing' });
        return;
      }
      setResponse(initialResponse(question));
      setResult(null);
      setView({ status: 'ready', question });
    });
  }, [id]);
  useEffect(load, [load]);

  const backToList = () => {
    const pages = Taro.getCurrentPages();
    if (pages.length > 1) {
      Taro.navigateBack().catch(() => Taro.reLaunch({ url: '/pages/questionBank/index' }));
      return;
    }
    Taro.reLaunch({ url: '/pages/questionBank/index' });
  };

  const question = view.status === 'ready' ? view.question : null;
  const fillValues = Array.isArray(response) ? response : [];
  const multiValues = Array.isArray(response) ? response : [];
  const canSubmit = !!question && isResponseComplete(question, response);

  const submit = () => {
    if (!question || !canSubmit) return;
    const correct = gradeAnswer(question, response);
    setResult(correct);
    try {
      createQuestionBankProgress(Taro).record(question.id, correct);
    } catch (err) {
      // 记录失败不阻断判分结果；错题本页会以失败态提示读取问题
      console.error('[QuestionBankAnswer] progress write failed:', err);
    }
  };

  const chooseOption = (key: string) => {
    if (!question) return;
    if (question.type === 'single') setResponse(key);
    if (question.type === 'multi') {
      setResponse(multiValues.includes(key) ? multiValues.filter((k) => k !== key) : [...multiValues, key]);
    }
  };

  const buildBody = () => {
    if (!question) return null;
    if (question.type === 'single' || question.type === 'multi') {
      return question.options.map((o) => {
        const active = question.type === 'single' ? response === o.key : multiValues.includes(o.key);
        return (
          <View key={o.key} className={active ? `${styles.option} ${styles.optionActive}` : styles.option} onClick={() => chooseOption(o.key)}>
            <Text className={styles.optionKey}>{o.key}</Text>
            <Text className={styles.optionText}>{o.text}</Text>
          </View>
        );
      });
    }
    if (question.type === 'fill') {
      return (
        <View>
          {fillValues.map((v, i) => (
            <Input
              key={i}
              className={styles.fillInput}
              value={v}
              placeholder={t('qb.fillPlaceholder')}
              onInput={(e) => setResponse(fillValues.map((x, idx) => (idx === i ? e.detail.value : x)))}
            />
          ))}
        </View>
      );
    }
    return (
      <View className={styles.judgeRow}>
        {[true, false].map((v) => (
          <Text
            key={String(v)}
            className={response === v ? `${styles.judgeBtn} ${styles.optionActive}` : styles.judgeBtn}
            onClick={() => setResponse(v)}
          >
            {t(v ? 'qb.true' : 'qb.false')}
          </Text>
        ))}
      </View>
    );
  };

  const renderResult = () => {
    if (!question || result === null) return null;
    const expectedText =
      question.type === 'judge' && typeof question.answerKey === 'boolean'
        ? t(question.answerKey ? 'qb.true' : 'qb.false')
        : formatAnswerKey(question);
    return (
      <View className={styles.result}>
        <Text className={result ? styles.resultGood : styles.resultBad}>{t(result ? 'qb.correct' : 'qb.wrong')}</Text>
        <View className={styles.answerLine}>
          <Text className={styles.badge}>{t('qb.answerKey')}</Text>
          <Text className={styles.answerText}>{expectedText}</Text>
        </View>
        {question.explanation ? (
          <View>
            <Text className={styles.badge}>{t('qb.explanationTitle')}</Text>
            <Text className={styles.explanation}>{question.explanation}</Text>
          </View>
        ) : null}
        <View className={styles.actions}>
          <View className={styles.secondaryBtn} onClick={() => { setResponse(initialResponse(question)); setResult(null); }}>
            <Text>{t('qb.tryAgain')}</Text>
          </View>
          <View className={styles.primaryBtn} onClick={backToList}>
            <Text className={styles.primaryText}>{t('qb.backToList')}</Text>
          </View>
        </View>
      </View>
    );
  };

  const renderState = () => {
    if (view.status === 'loading') return <View className={styles.state}><Text className={styles.stateTitle}>{t('qb.loading')}</Text></View>;
    if (view.status === 'error') {
      return (
        <View className={styles.state}>
          <Text className={styles.stateIcon}>⚠️</Text>
          <Text className={styles.stateTitle}>{t('qb.loadFailed')}</Text>
          <Text className={styles.stateDesc}>{t('qb.loadFailedHint')}</Text>
          <View className={styles.retry} onClick={load}><Text className={styles.retryText}>{t('qb.retry')}</Text></View>
        </View>
      );
    }
    if (view.status === 'missing') {
      return (
        <View className={styles.state}>
          <Text className={styles.stateIcon}>📄</Text>
          <Text className={styles.stateTitle}>{t('qb.notFound')}</Text>
          <Text className={styles.stateDesc}>{t('qb.notFoundHint')}</Text>
          <View className={styles.retry} onClick={backToList}><Text className={styles.retryText}>{t('qb.backToList')}</Text></View>
        </View>
      );
    }
    return null;
  };

  return (
    <View className={styles.page} style={brandVars(theme)}>
      <View className={styles.header}>
        <View className={styles.back} onClick={backToList}>
          <Text className={styles.backIcon}>‹</Text>
          <Text className={styles.backText}>{t('common.back')}</Text>
        </View>
        <Text className={styles.title}>{t('qb.answerTitle')}</Text>
      </View>
      {renderState()}
      {question ? (
        <View>
          <View className={styles.meta}>
            <Text className={styles.badge}>{t(`qb.system.${question.examSystem}`)}</Text>
            <Text className={styles.badge}>{question.subject}</Text>
            <Text className={styles.badge}>{t('qb.difficulty', { n: question.difficulty })}</Text>
          </View>
          <Text className={styles.questionStem}>{question.stem}</Text>
          {result === null ? (
            <View>
              {buildBody()}
              <View className={canSubmit ? styles.primaryBtn : styles.primaryBtnDisabled} onClick={submit}>
                <Text className={styles.primaryText}>{t('qb.submit')}</Text>
              </View>
            </View>
          ) : null}
          {renderResult()}
        </View>
      ) : null}
    </View>
  );
}
