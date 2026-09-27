import { useEffect, useMemo, useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import classnames from 'classnames';
import { LearnCourse } from '@/data/learn';
import { buildListeningQuestions, ListeningQuestion } from '@/utils/learnDrills';
import { addDrillResult } from '@/utils/learn';
import { startSpeak, stopSpeak, TtsLang } from '@/utils/tts';
import { DrillFinish, DrillOptions, DrillProgress, DrillReveal, vibrateCorrect } from './DrillShared';
import { useT } from '@/store/language';
import styles from './index.module.scss';

interface ListeningDrillProps {
  course: LearnCourse;
  accent: string;
  /** 课程语种对应的 TTS 语种 */
  ttsLang: TtsLang;
  /** 该课听力练习历史最高分 */
  best: number;
}

/** 听力训练：播报目标语单词（不显示文字），四选一挑出中文释义 */
function ListeningDrill({ course, accent, ttsLang, best }: ListeningDrillProps) {
  const t = useT();
  const [round, setRound] = useState(0);
  const questions = useMemo(() => buildListeningQuestions(course), [course, round]);
  const [idx, setIdx] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [correct, setCorrect] = useState(0);
  const [done, setDone] = useState(false);
  const [playing, setPlaying] = useState(false);

  const q: ListeningQuestion | undefined = questions[idx];

  // 切题/卸载时停掉上一次播报
  useEffect(() => () => stopSpeak(), [idx, round]);

  const play = (slow = false) => {
    if (!q) return;
    startSpeak(
      [q.speakText],
      {
        onEnd: () => setPlaying(false),
        onError: (msg) => {
          setPlaying(false);
          Taro.showToast({ title: msg, icon: 'none' });
        }
      },
      { lang: ttsLang, rate: slow ? 0.6 : 0.9, scene: 'learning' }
    );
    setPlaying(true);
  };

  const pick = (opt: string) => {
    if (picked !== null || !q) return;
    stopSpeak();
    setPlaying(false);
    setPicked(opt);
    if (opt === q.answer) {
      setCorrect((c) => c + 1);
      vibrateCorrect();
    }
  };

  const next = () => {
    if (idx + 1 >= questions.length) {
      addDrillResult(course.id, 'listening', (correct / questions.length) * 100);
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

  if (done || !q) {
    const pct = Math.round((correct / questions.length) * 100);
    return (
      <DrillFinish
        emoji="🎧"
        title={t('learn.listenDone')}
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
      <Text className={styles.drillHint}>{t('learn.listenHint')}</Text>

      <View className={styles.listenCard}>
        <View className={classnames(styles.playBtn, playing && styles.playBtnOn)} style={{ borderColor: accent }} onClick={() => play(false)}>
          <Text className={styles.playIcon}>🔊</Text>
          <Text className={styles.playLabel}>{t('learn.listenPlay')}</Text>
        </View>
        <Text className={styles.slowBtn} onClick={() => play(true)}>
          🐢 {t('learn.listenSlow')}
        </Text>
      </View>

      <DrillOptions options={q.options} answer={q.answer} picked={picked} accent={accent} onPick={pick} />

      {picked !== null && q ? (
        <DrillReveal
          accent={accent}
          primaryLabel={idx + 1 >= questions.length ? t('learn.finish') : t('learn.next')}
          onPrimary={next}
        >
          <Text className={styles.revealWord}>{q.speakText}</Text>
          <Text className={styles.revealCn}>
            {q.example} · {q.exampleCn}
          </Text>
        </DrillReveal>
      ) : null}
    </View>
  );
}

export default ListeningDrill;
