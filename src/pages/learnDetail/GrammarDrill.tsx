import { useMemo, useState } from 'react';
import { View, Text } from '@tarojs/components';
import { LearnCourse } from '@/data/learn';
import { buildGrammarQuestions, GrammarQuestion } from '@/utils/learnDrills';
import { addDrillResult } from '@/utils/learn';
import EmptyState from '@/components/EmptyState';
import { DrillFinish, DrillOptions, DrillProgress, DrillReveal, vibrateCorrect } from './DrillShared';
import { useT } from '@/store/language';
import styles from './index.module.scss';

interface GrammarDrillProps {
  course: LearnCourse;
  accent: string;
  /** 该课语法练习历史最高分 */
  best: number;
}

/** 语法练习：例句关键词填空，四选一补全句子 */
function GrammarDrill({ course, accent, best }: GrammarDrillProps) {
  const t = useT();
  // round 用于「再来一轮」时重新洗牌
  const [round, setRound] = useState(0);
  const questions = useMemo(() => buildGrammarQuestions(course), [course, round]);
  const [idx, setIdx] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [correct, setCorrect] = useState(0);
  const [done, setDone] = useState(false);

  const q: GrammarQuestion | undefined = questions[idx];

  const pick = (opt: string) => {
    if (picked !== null || !q) return;
    setPicked(opt);
    if (opt === q.answer) {
      setCorrect((c) => c + 1);
      vibrateCorrect();
    }
  };

  const next = () => {
    if (idx + 1 >= questions.length) {
      addDrillResult(course.id, 'grammar', (correct / questions.length) * 100);
      setDone(true);
    } else {
      setIdx(idx + 1);
      setPicked(null);
    }
  };

  const restart = () => {
    setRound(round + 1);
    setIdx(0);
    setPicked(null);
    setCorrect(0);
    setDone(false);
  };

  // L3-02 边界：可出题数 <3 时题料不足，显示空态而非 0/0 结算卡
  if (questions.length < 3) {
    return <EmptyState icon="✏️" title={t('learn.grammarEmptyTitle')} hint={t('learn.grammarEmptyHint')} />;
  }

  if (done || !q) {
    const pct = Math.round((correct / questions.length) * 100);
    return (
      <DrillFinish
        emoji="✏️"
        title={t('learn.grammarDone')}
        score={`${t('learn.correctCount', { count: correct, total: questions.length })} · ${pct}%`}
        best={Math.max(best, pct)}
        accent={accent}
        onRestart={restart}
      />
    );
  }

  return (
    <View className={styles.drillWrap}>
      <DrillProgress current={idx + 1} total={questions.length} accent={accent} />
      <Text className={styles.drillHint}>{t('learn.grammarFillHint')}</Text>
      <View className={styles.drillCard}>
        <Text className={styles.stem}>
          {q.stem.split('____').map((seg, i, arr) => (
            <Text key={i}>
              {seg}
              {i < arr.length - 1 ? (
                <Text className={styles.blank} style={{ color: picked ? (q.answer === picked ? accent : undefined) : undefined }}>
                  {picked && i === 0 ? picked : '____'}
                </Text>
              ) : null}
            </Text>
          ))}
        </Text>
      </View>

      <DrillOptions options={q.options} answer={q.answer} picked={picked} accent={accent} onPick={pick} />

      {picked !== null ? (
        <DrillReveal
          accent={accent}
          primaryLabel={idx + 1 >= questions.length ? t('learn.finish') : t('learn.next')}
          onPrimary={next}
        >
          <Text className={styles.revealMeaning}>
            {picked === q.answer ? '✅' : '❌'} {q.meaningCn}
          </Text>
          <Text className={styles.revealCn}>{q.exampleCn}</Text>
        </DrillReveal>
      ) : null}
    </View>
  );
}

export default GrammarDrill;
