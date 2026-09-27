import { useMemo, useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, { useRouter } from '@tarojs/taro';
import classnames from 'classnames';
import EmptyState from '@/components/EmptyState';
import { findCourse } from '@/data/learn';
import { getCourseProgress, markWords, setCourseCompleted, getDrillScore, LearnLangId } from '@/utils/learn';
import { langToTts } from '@/utils/learnDrills';
import { isTtsLangSupported, stopSpeak } from '@/utils/tts';
import { useT } from '@/store/language';
import GrammarDrill from './GrammarDrill';
import ListeningDrill from './ListeningDrill';
import SpeakingDrill from './SpeakingDrill';
import styles from './index.module.scss';

type DrillMode = 'words' | 'grammar' | 'listening' | 'speaking';

/** 课程学习页：单词卡自测 + 语法填空 + 听力选义 + 口语跟读（四模式 Tab，进度统一写入 learn store） */
function LearnDetailPage() {
  const t = useT();
  const router = useRouter();
  const courseId = router.params.courseId || '';
  const [mode, setMode] = useState<DrillMode>('words');

  const found = useMemo(() => findCourse(courseId), [courseId]);

  const initial = useMemo(() => getCourseProgress(courseId), [courseId]);
  const [learned, setLearned] = useState<Set<string>>(() => new Set(initial.learned));
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [finished, setFinished] = useState(false);

  const langId: LearnLangId = (found?.lang.id || 'en') as LearnLangId;
  const ttsLang = useMemo(() => langToTts(langId), [langId]);
  const audioSupported = useMemo(() => isTtsLangSupported(ttsLang), [ttsLang]);

  if (!found) {
    return (
      <View className={styles.page}>
        <EmptyState icon='📖' title={t('learn.courseMissing')} hint={t('learn.backToPick')} />
      </View>
    );
  }

  const { course, lang } = found;
  const words = course.words;
  const word = words[index];

  const switchMode = (next: DrillMode) => {
    if (next === mode) return;
    stopSpeak();
    setMode(next);
  };

  const handleMark = (isKnown: boolean) => {
    if (!word) return;
    const next = new Set(learned);
    if (isKnown) next.add(word.id);
    else next.delete(word.id);
    setLearned(next);
    markWords(courseId, [word.id], isKnown);
    // 全课掌握 → 标记课程完成（含打卡）
    if (next.size >= words.length) setCourseCompleted(courseId, true, words.length);

    if (index + 1 >= words.length) {
      setFinished(true);
    } else {
      setIndex(index + 1);
      setFlipped(false);
    }
  };

  const restart = () => {
    setIndex(0);
    setFlipped(false);
    setFinished(false);
  };

  const back = () => {
    Taro.navigateBack().catch(() => {
      Taro.switchTab({ url: '/pages/mine/index' }).catch((err) =>
        console.warn('[LearnDetail] back failed:', err)
      );
    });
  };

  const tabs: Array<{ id: DrillMode; icon: string; label: string }> = [
    { id: 'words', icon: '🃏', label: t('learn.tabWords') },
    { id: 'grammar', icon: '✏️', label: t('learn.tabGrammar') },
    { id: 'listening', icon: '🎧', label: t('learn.tabListening') },
    { id: 'speaking', icon: '🗣', label: t('learn.tabSpeaking') }
  ];

  const renderWordsMode = () => {
    if (finished || !word) {
      const mastered = learned.size;
      return (
        <View className={styles.finishCard}>
          <Text className={styles.finishEmoji}>🎉</Text>
          <Text className={styles.finishTitle}>{t('learn.finishTitle')}</Text>
          <Text className={styles.finishStat}>
            {mastered}/{words.length} {t('learn.wordsMastered')}
          </Text>
          <Text className={styles.finishHint}>{t('learn.finishHint')}</Text>
          <View className={styles.finishActions}>
            <Text className={styles.btnGhost} onClick={restart}>
              {t('learn.again')}
            </Text>
            <Text className={styles.btnPrimary} onClick={back}>
              {t('learn.backCourses')}
            </Text>
          </View>
        </View>
      );
    }

    return (
      <View>
        <View className={styles.progressTrack}>
          <View className={styles.progressFill} style={{ width: `${((index + 1) / words.length) * 100}%`, background: lang.accent }} />
        </View>

        {/* 单词卡：点按翻转 */}
        <View className={styles.cardWrap} onClick={() => setFlipped(!flipped)}>
          <View className={classnames(styles.card, flipped && styles.cardFlipped)}>
            {!flipped ? (
              <View className={styles.cardFront}>
                <Text className={styles.term} style={{ color: lang.accent }}>
                  {word.term}
                </Text>
                {word.reading ? <Text className={styles.reading}>{word.reading}</Text> : null}
                <Text className={styles.flipHint}>{t('learn.tapToFlip')}</Text>
              </View>
            ) : (
              <View className={styles.cardBack}>
                <Text className={styles.meaning}>{word.meaning}</Text>
                <Text className={styles.example}>{word.example}</Text>
                <Text className={styles.exampleCn}>{word.exampleCn}</Text>
              </View>
            )}
          </View>
        </View>

        {/* 自测按钮 */}
        <View className={styles.actions}>
          <Text className={styles.btnGhost} onClick={() => handleMark(false)}>
            {t('learn.notYet')}
          </Text>
          <Text className={styles.btnPrimary} onClick={() => handleMark(true)}>
            {t('learn.gotIt')}
          </Text>
        </View>
        <Text className={styles.masteredCount}>
          {t('learn.sessionMastered', { count: learned.size, total: words.length })}
        </Text>
      </View>
    );
  };

  return (
    <View className={styles.page}>
      <View className={styles.header}>
        <Text className={styles.courseTitle}>{course.title}</Text>
        {mode === 'words' && !finished && word ? (
          <Text className={styles.counter}>
            {index + 1}/{words.length}
          </Text>
        ) : null}
      </View>

      {/* 四模式 Tab */}
      <View className={styles.modeBar}>
        {tabs.map((tab) => (
          <View
            key={tab.id}
            className={classnames(styles.modeTab, mode === tab.id && styles.modeTabActive)}
            style={mode === tab.id ? { borderColor: lang.accent, color: lang.accent } : undefined}
            onClick={() => switchMode(tab.id)}
          >
            <Text>
              {tab.icon} {tab.label}
            </Text>
          </View>
        ))}
      </View>

      {/* U-02：key=mode 使切 Tab 时内容区重挂载并播放 160ms 淡入过渡 */}
      <View key={mode} className={styles.modeContent}>
        {mode === 'words' ? (
          renderWordsMode()
        ) : mode === 'grammar' ? (
          <GrammarDrill key={`g-${course.id}`} course={course} accent={lang.accent} best={getDrillScore(course.id, 'grammar')} />
        ) : mode === 'listening' ? (
          audioSupported ? (
            <ListeningDrill
              key={`l-${course.id}`}
              course={course}
              accent={lang.accent}
              ttsLang={ttsLang}
              best={getDrillScore(course.id, 'listening')}
            />
          ) : (
            <EmptyState icon='🔇' title={t('learn.ttsUnsupportedTitle')} hint={t('learn.ttsUnsupported')} />
          )
        ) : (
          <SpeakingDrill
            key={`s-${course.id}`}
            course={course}
            langId={langId}
            accent={lang.accent}
            best={getDrillScore(course.id, 'speaking')}
            audioSupported={audioSupported}
          />
        )}
      </View>
    </View>
  );
}

export default LearnDetailPage;
