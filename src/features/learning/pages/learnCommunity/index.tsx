import { useEffect, useState } from 'react';
import { View, Text, Textarea, Input, Button } from '@tarojs/components';
import Taro from '@tarojs/taro';
import classnames from 'classnames';
import type { Achievement, CommunityPost } from '@learning/core';
import { LEARN_LANGS } from '@/features/learning/data';
import { getLearningRepository } from '@/features/learning/repository';
import { useT } from '@/store/language';
import { fromNow } from '@/utils/date';
import styles from './index.module.scss';

/** 社区动态（MVP：本地持久化 + 演示种子内容，读写统一走 learning-core repository） */
function LearnCommunityPage() {
  const t = useT();
  const repository = getLearningRepository();
  const [achievements, setAchievements] = useState<Achievement[]>([]);
  const [posts, setPosts] = useState<CommunityPost[]>([]);
  const [draft, setDraft] = useState('');
  const [name, setName] = useState('我');
  const [editingName, setEditingName] = useState(false);
  const [streak, setStreak] = useState(0);
  const lang = LEARN_LANGS.find((l) => l.id === repository.getActiveLanguage()) || LEARN_LANGS[0];

  const refresh = () => {
    setAchievements(repository.getAchievements());
    setPosts(repository.getCommunityPosts());
    setStreak(repository.getStreak());
    setName(repository.getLearnerName());
  };

  useEffect(refresh, []);

  const unlocked = achievements.filter((a) => a.unlockedAt).length;

  const submitPost = () => {
    const text = draft.trim();
    if (!text) {
      Taro.showToast({ title: '说点什么再发布吧', icon: 'none' });
      return;
    }
    repository.addPost({ text });
    setDraft('');
    refresh();
    Taro.showToast({ title: '已发布到打卡墙', icon: 'success' });
  };

  const toggleLike = (id: string) => {
    repository.toggleLike(id);
    refresh();
  };

  const saveName = () => {
    setEditingName(false);
    repository.setLearnerName(name || '我');
    refresh();
  };

  return (
    <View className={styles.page}>
      {/* 头部：学习身份 + 成就进度 */}
      <View className={styles.headCard} style={{ background: lang.accent }}>
        <View className={styles.headRow}>
          {editingName ? (
            <Input
              className={styles.nameInput}
              value={name}
              maxlength={12}
              focus
              onInput={(e) => setName(e.detail.value)}
              onBlur={saveName}
            />
          ) : (
            <Text className={styles.headName} onClick={() => setEditingName(true)}>
              {name} ✎
            </Text>
          )}
          <Text className={styles.headStreak}>
            🔥 {streak} {t('community.streakUnit')}
          </Text>
        </View>
        <Text className={styles.headSub}>
          {t('community.unlockedTip', { unlocked, total: achievements.length })}
        </Text>
      </View>

      {/* 成就徽章墙 */}
      <View className={styles.sectionCard}>
        <Text className={styles.sectionTitle}>🏅 {t('community.badgeTitle')}</Text>
        <View className={styles.badgeGrid}>
          {achievements.map((a) => (
            <View
              key={a.id}
              className={classnames(styles.badge, a.unlockedAt && styles.badgeOn)}
            >
              <Text className={styles.badgeIcon}>{a.icon}</Text>
              <Text className={styles.badgeName}>{a.name}</Text>
              <Text className={styles.badgeDesc}>{a.unlockedAt ? a.desc : `${a.progress}%`}</Text>
            </View>
          ))}
        </View>
      </View>

      {/* 打卡墙：发帖 + 动态流 */}
      <View className={styles.sectionCard}>
        <Text className={styles.sectionTitle}>📣 {t('community.wallTitle')}</Text>
        <Textarea
          className={styles.postInput}
          value={draft}
          maxlength={200}
          placeholder={t('community.postPlaceholder')}
          onInput={(e) => setDraft(e.detail.value)}
        />
        <View className={styles.postActions}>
          <Text className={styles.postLangTag} style={{ color: lang.accent, borderColor: lang.accent }}>
            {lang.name}
          </Text>
          <Button className={styles.postButton} onClick={submitPost}>
            {t('community.postButton')}
          </Button>
        </View>
        {posts.map((p) => (
          <View key={p.id} className={styles.postItem}>
            <View className={styles.postAvatar}>
              <Text>{p.name.slice(0, 1)}</Text>
            </View>
            <View className={styles.postBody}>
              <View className={styles.postMeta}>
                <Text className={styles.postName}>{p.name}</Text>
                <Text className={styles.postLang}>· {p.langName}</Text>
                {p.demo ? <Text className={styles.postTime}>· 演示内容</Text> : null}
                <Text className={styles.postTime}>{fromNow(p.at)}</Text>
              </View>
              <Text className={styles.postText}>{p.text}</Text>
              <View
                className={classnames(styles.likeRow, p.liked && styles.likeOn)}
                onClick={() => toggleLike(p.id)}
              >
                <Text>{p.liked ? '❤️' : '🤍'}</Text>
                <Text className={styles.likeCount}>{p.likes}</Text>
              </View>
            </View>
          </View>
        ))}
      </View>

      <View className={styles.footer}>
        <Text className={styles.footerText}>{t('community.cloudNote')}</Text>
      </View>
    </View>
  );
}

export default LearnCommunityPage;
