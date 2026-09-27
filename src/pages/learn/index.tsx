import { useEffect, useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import classnames from 'classnames';
import { LEARN_LANGS, LearnLangId, LearnCourse } from '@/data/learn';
import {
  getLangStats,
  getStreak,
  isTodayCheckedIn,
  getCourseProgress,
  setActiveLang,
  readLearnStore,
  getRecommendedPath,
  settleStreakOnOpen,
  getFreezeCards,
  canMakeup,
  makeupMissed,
  LearnStore
} from '@/utils/learn';
import { useT } from '@/store/language';
import styles from './index.module.scss';

/** 语言学习主页（MVP）：语种切换 + 分级课程 + 进度与打卡 */
function LearnPage() {
  const t = useT();
  const [langId, setLangId] = useState<LearnLangId>(() => readLearnStore().activeLang || 'en');
  // 只需 setStore 触发重渲染（渲染数据走 getLangStats/getCourseProgress 直读工具层）；store 值本身不使用
  const [, setStore] = useState<LearnStore>(() => readLearnStore());
  const [streak, setStreak] = useState(0);
  const [checkedIn, setCheckedIn] = useState(false);
  const [freezeCards, setFreezeCards] = useState(0);
  const [makeup, setMakeup] = useState<{ ok: boolean; date: string | null; reason: string }>({
    ok: false,
    date: null,
    reason: 'none'
  });
  const [ruleOpen, setRuleOpen] = useState(false);

  const refresh = () => {
    setStore(readLearnStore());
    setStreak(getStreak());
    setCheckedIn(isTodayCheckedIn());
    setFreezeCards(getFreezeCards());
    setMakeup(canMakeup());
  };

  useEffect(refresh, []);

  // 从课程页返回后刷新进度；同时做惰性结算（补算漏打卡 + 发冻结卡，PRD Q5）
  useDidShow(() => {
    const settled = settleStreakOnOpen();
    if (settled.frozenDates.length > 0) {
      Taro.showToast({ title: t('learn.freezeUsed'), icon: 'none', duration: 2500 });
    } else if (settled.grantedCards > 0) {
      Taro.showToast({ title: t('learn.freezeGain'), icon: 'none', duration: 2500 });
    }
    refresh();
  });

  /** 补签最近漏打卡日（每月 1 次） */
  const handleMakeup = () => {
    if (!makeup.ok) {
      Taro.showToast({ title: t('learn.makeupExhausted'), icon: 'none' });
      return;
    }
    const res = makeupMissed();
    if (res.ok) {
      Taro.showToast({ title: t('learn.makeupToast', { n: res.streak }), icon: 'success' });
      refresh();
    }
  };

  const lang = LEARN_LANGS.find((l) => l.id === langId) || LEARN_LANGS[0];
  const stats = getLangStats(langId);
  // 个性化学习路径：随进度/打卡状态实时刷新
  const path = getRecommendedPath(langId);
  const recBadgeLabel: Record<string, string> = {
    continue: t('learn.recContinue'),
    next: t('learn.recNext'),
    review: t('learn.recReview')
  };

  const handleLangChange = (id: LearnLangId) => {
    setLangId(id);
    setActiveLang(id);
  };

  const openCourse = (course: LearnCourse) => {
    Taro.navigateTo({ url: `/pages/learnDetail/index?courseId=${course.id}` }).catch((err) =>
      console.warn('[LearnPage] navigate failed:', err)
    );
  };

  /** 推荐路径步骤点击：按 courseId 找到课程后跳转 */
  const openCourseById = (courseId: string) => {
    for (const l of lang.levels) {
      const c = l.courses.find((it) => it.id === courseId);
      if (c) {
        openCourse(c);
        return;
      }
    }
  };

  return (
    <View className={styles.page}>
      {/* 语种切换 */}
      <View className={styles.langBar}>
        {LEARN_LANGS.map((l) => (
          <View
            key={l.id}
            className={classnames(styles.langTab, l.id === langId && styles.langTabActive)}
            style={l.id === langId ? { borderColor: l.accent, color: l.accent } : undefined}
            onClick={() => handleLangChange(l.id)}
          >
            <Text className={styles.langDot} style={{ background: l.accent }} />
            <Text>{l.name}</Text>
          </View>
        ))}
      </View>

      {/* 打卡与进度 */}
      <View className={styles.statsCard}>
        <View className={styles.statItem}>
          <Text className={styles.statNum}>{streak}</Text>
          <Text className={styles.statLabel}>{t('learn.streak')}</Text>
        </View>
        <View className={styles.statDivider} />
        <View className={styles.statItem}>
          <Text className={styles.statNum}>
            {stats.learned}
            <Text className={styles.statUnit}>/{stats.total}</Text>
          </Text>
          <Text className={styles.statLabel}>{t('learn.wordsLearned')}</Text>
        </View>
        <View className={styles.statDivider} />
        <View className={styles.statItem}>
          <Text className={classnames(styles.statNum, checkedIn && styles.statNumOn)}>
            {checkedIn ? '✓' : '·'}
          </Text>
          <Text className={styles.statLabel}>{checkedIn ? t('learn.checkedIn') : t('learn.notCheckedIn')}</Text>
        </View>
      </View>
      {/* v2.1：主 streak 已改挂「每日读晨报」，此处明示学习连续为已归档口径，避免用户误以为数据丢失 */}
      <Text className={styles.progressHint}>{t('learn.streakArchived')}</Text>
      <View className={styles.progressTrack}>
        <View className={styles.progressFill} style={{ width: `${stats.percent}%`, background: lang.accent }} />
      </View>
      <Text className={styles.progressHint}>
        {t('learn.progressHint', { percent: stats.percent, done: stats.coursesDone, total: stats.coursesTotal })}
      </Text>

      {/* 冻结卡 + 补签（L-01 / L-02） */}
      <View className={styles.streakToolbar}>
        <View className={styles.freezeBadge} onClick={() => setRuleOpen((v) => !v)}>
          <Text className={styles.freezeText}>{t('learn.freezeLabel', { n: freezeCards })}</Text>
        </View>
        {makeup.ok || makeup.reason === 'exhausted' ? (
          <View
            className={classnames(styles.makeupBtn, !makeup.ok && styles.makeupDisabled)}
            onClick={handleMakeup}
          >
            <Text className={styles.makeupText}>
              {makeup.ok ? t('learn.makeupBtn') : t('learn.makeupExhausted')}
            </Text>
          </View>
        ) : null}
      </View>
      {ruleOpen ? <Text className={styles.ruleText}>{t('learn.freezeRule')}{'\n'}{t('learn.makeupRule')}</Text> : null}

      {/* 个性化学习路径推荐 */}
      {path.length > 0 ? (
        <View className={styles.recCard}>
          <View className={styles.recHeader}>
            <Text className={styles.recTitle}>✨ {t('learn.recommendTitle')}</Text>
            <Text className={styles.recHint}>{t('learn.recommendHint')}</Text>
          </View>
          {path.map((step, idx) => (
            <View
              key={step.courseId + step.type}
              className={styles.recStep}
              onClick={() => openCourseById(step.courseId)}
            >
              <Text className={styles.recBadge} style={{ background: lang.accent, opacity: 1 - idx * 0.18 }}>
                {recBadgeLabel[step.type]}
              </Text>
              <View className={styles.recBody}>
                <Text className={styles.recCourse}>{step.title}</Text>
                <Text className={styles.recReason}>{step.reason}</Text>
              </View>
              <Text className={styles.recGo}>›</Text>
            </View>
          ))}
        </View>
      ) : null}

      {/* 分级课程 */}
      {lang.levels.map((level) => (
        <View key={level.id} className={styles.levelBlock}>
          <View className={styles.levelHeader}>
            <Text className={styles.levelName} style={{ color: lang.accent }}>
              {level.name}
            </Text>
            <Text className={styles.levelDesc}>{level.desc}</Text>
          </View>
          {level.courses.map((course) => {
            const prog = getCourseProgress(course.id);
            const done = course.words.length > 0 && prog.learned.length >= course.words.length;
            const percent = Math.round((prog.learned.length / course.words.length) * 100);
            return (
              <View key={course.id} className={styles.courseCard} onClick={() => openCourse(course)}>
                <View className={styles.courseMain}>
                  <View className={styles.courseTitleRow}>
                    <Text className={styles.courseTitle}>{course.title}</Text>
                    {done ? <Text className={styles.doneBadge}>{t('learn.done')}</Text> : null}
                  </View>
                  <Text className={styles.courseTheme}>{course.theme}</Text>
                  <View className={styles.courseBar}>
                    <View
                      className={styles.courseBarFill}
                      style={{ width: `${percent}%`, background: lang.accent }}
                    />
                  </View>
                  <Text className={styles.courseStat}>
                    {prog.learned.length}/{course.words.length} {t('learn.wordsUnit')}
                  </Text>
                </View>
                <Text className={styles.courseArrow}>›</Text>
              </View>
            );
          })}
        </View>
      ))}

      <View className={styles.footer}>
        <View className={styles.communityEntry} onClick={() => Taro.navigateTo({ url: '/pages/learnCommunity/index' })}>
          <Text className={styles.communityIcon}>🏅</Text>
          <View className={styles.communityTextWrap}>
            <Text className={styles.communityTitle}>{t('community.entryTitle')}</Text>
            <Text className={styles.communityDesc}>{t('community.entryDesc')}</Text>
          </View>
          <Text className={styles.courseArrow}>›</Text>
        </View>
        <Text className={styles.footerText}>{t('learn.moreComing')}</Text>
      </View>
    </View>
  );
}

export default LearnPage;
