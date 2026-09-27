import { useEffect, useMemo, useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import VoiceButton from '@/components/VoiceButton';
import { LearnCourse, LearnLangId } from '@/data/learn';
import { buildSpeakingLines, langToAsr, langToTts, speechSimilarity } from '@/utils/learnDrills';
import { addDrillResult } from '@/utils/learn';
import { startSpeak, stopSpeak, TtsLang } from '@/utils/tts';
import { DrillFinish, DrillProgress, DrillRevealBox, vibrateCorrect } from './DrillShared';
import { useT } from '@/store/language';
import styles from './index.module.scss';

interface SpeakingDrillProps {
  course: LearnCourse;
  langId: LearnLangId;
  accent: string;
  /** 该课口语练习历史最高分 */
  best: number;
  /** 当前端是否支持该语种 TTS 发音（不支持则隐藏示范按钮，保留跟读自评） */
  audioSupported: boolean;
}

interface Feedback {
  type: 'self' | 'score';
  pct?: number;
}

/** 口语跟读：听示范 → 按住跟读 → 英语句自动比对相似度，其余语种/端自评 */
function SpeakingDrill({ course, langId, accent, best, audioSupported }: SpeakingDrillProps) {
  const t = useT();
  const lines = useMemo(() => buildSpeakingLines(course), [course]);
  const [idx, setIdx] = useState(0);
  const [practiced, setPracticed] = useState<Set<string>>(() => new Set());
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [done, setDone] = useState(false);

  const line = lines[idx];
  const ttsLang: TtsLang = langToTts(langId);
  // 同声传译插件仅支持英/中识别：英语课可用转写比对，其余走自评
  const canAutoScore = langId === 'en';

  useEffect(() => () => stopSpeak(), [idx]);

  const play = (slow = false) => {
    if (!line) return;
    startSpeak(
      [line.example],
      {
        onError: (msg) => Taro.showToast({ title: msg, icon: 'none' })
      },
      { lang: ttsLang, rate: slow ? 0.6 : 0.9, scene: 'learning' }
    );
  };

  const markPracticed = (wordId: string) => {
    setPracticed((prev) => {
      const next = new Set(prev);
      next.add(wordId);
      return next;
    });
  };

  const advance = () => {
    setFeedback(null);
    if (idx + 1 >= lines.length) {
      addDrillResult(course.id, 'speaking', 100);
      setDone(true);
    } else {
      setIdx(idx + 1);
    }
  };

  const handleVoiceResult = (transcript?: string) => {
    if (!line) return;
    if (canAutoScore && transcript) {
      const pct = Math.round(speechSimilarity(line.example, transcript) * 100);
      markPracticed(line.wordId);
      setFeedback({ type: 'score', pct });
      // U-03：英语课相似度达标视为答对，轻震动反馈
      if (pct >= 60) vibrateCorrect();
      return;
    }
    // H5 mock / 微信降级录音：无可用转写 → 自评
    setFeedback({ type: 'self' });
  };

  const restart = () => {
    setIdx(0);
    setPracticed(new Set());
    setFeedback(null);
    setDone(false);
  };

  if (done || !line) {
    return (
      <DrillFinish
        emoji="🗣"
        title={t('learn.speakDone')}
        score={t('learn.speakProgress', { count: practiced.size, total: lines.length })}
        best={Math.max(best, 100)}
        accent={accent}
        onRestart={restart}
      />
    );
  }

  const pct = feedback?.pct;
  return (
    <View className={styles.drillWrap}>
      <DrillProgress current={idx + 1} total={lines.length} accent={accent} />
      <Text className={styles.drillHint}>{t('learn.speakHint')}</Text>

      <View className={styles.speakCard}>
        <Text className={styles.speakTerm} style={{ color: accent }}>
          {line.term}
        </Text>
        {line.reading ? <Text className={styles.speakReading}>{line.reading}</Text> : null}
        <Text className={styles.speakExample}>{line.example}</Text>
        <Text className={styles.speakExampleCn}>{line.exampleCn}</Text>

        {audioSupported ? (
          <View className={styles.playRow}>
            <Text className={styles.slowBtn} onClick={() => play(false)}>
              🔊 {t('learn.speakPlay')}
            </Text>
            <Text className={styles.slowBtn} onClick={() => play(true)}>
              🐢 {t('learn.listenSlow')}
            </Text>
          </View>
        ) : (
          <Text className={styles.ttsNote}>{t('learn.ttsUnsupported')}</Text>
        )}
      </View>

      {feedback === null ? (
        <View className={styles.speakActionBox}>
          <Text className={styles.speakYourTurn}>{t('learn.speakYourTurn')}</Text>
          <VoiceButton asrLang={langToAsr(langId)} onResult={(res) => handleVoiceResult(res.transcript)} />
        </View>
      ) : feedback.type === 'self' ? (
        <DrillRevealBox>
          <Text className={styles.revealMeaning}>{t('learn.speakSelfCheck')}</Text>
          <View className={styles.selfRow}>
            <Text className={styles.btnGhost} onClick={() => setFeedback(null)}>
              {t('learn.speakAgain')}
            </Text>
            <Text
              className={styles.btnPrimary}
              style={{ background: accent }}
              onClick={() => {
                markPracticed(line.wordId);
                vibrateCorrect();
                advance();
              }}
            >
              {t('learn.speakGood')}
            </Text>
          </View>
        </DrillRevealBox>
      ) : (
        <DrillRevealBox>
          <Text className={styles.scoreNum} style={{ color: accent }}>
            {t('learn.speakMatch', { score: pct || 0 })}
          </Text>
          <Text className={styles.revealCn}>{(pct || 0) >= 60 ? t('learn.speakMatchGood') : t('learn.speakMatchRetry')}</Text>
          <View className={styles.selfRow}>
            <Text className={styles.btnGhost} onClick={() => setFeedback(null)}>
              {t('learn.speakAgain')}
            </Text>
            {(pct || 0) >= 60 ? (
              <Text className={styles.btnPrimary} style={{ background: accent }} onClick={advance}>
                {idx + 1 >= lines.length ? t('learn.finish') : t('learn.next')}
              </Text>
            ) : (
              <Text className={styles.btnGhost} onClick={advance}>
                {t('learn.speakSkip')}
              </Text>
            )}
          </View>
        </DrillRevealBox>
      )}

      <Text className={styles.masteredCount}>
        {t('learn.speakProgress', { count: practiced.size, total: lines.length })}
      </Text>
    </View>
  );
}

export default SpeakingDrill;
