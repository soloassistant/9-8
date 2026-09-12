import { useEffect, useState } from 'react';
import { View, Text, Textarea, Input, Button } from '@tarojs/components';
import Taro from '@tarojs/taro';
import dayjs from 'dayjs';
import classnames from 'classnames';
import { getAchievements, getLearnerName, setLearnerName, Achievement } from '@/utils/achievements';
import { readLearnStore, getStreak } from '@/utils/learn';
import { LEARN_LANGS } from '@/data/learn';
import { useT } from '@/store/language';
import { fromNow } from '@/utils/date';
import styles from './index.module.scss';

/** 社区动态（MVP：本地持久化 + 种子示例，结构兼容后续云同步） */
interface Post {
  id: string;
  name: string;
  langName: string;
  text: string;
  at: string;
  likes: number;
  liked: boolean;
  mine: boolean;
}

const COMMUNITY_STORE_KEY = 'learnCommunityStore';

/** 种子示例动态：展示社区氛围，真实发帖后排在前面 */
function seedPosts(): Post[] {
  const now = Date.now();
  return [
    {
      id: 'seed-1',
      name: '柚子同学',
      langName: '日语',
      text: 'N5 寒暄课打卡 ✅ こんにちは已经在便利店用上了，店员真的会回你！',
      at: dayjs(now - 3 * 3600 * 1000).toISOString(),
      likes: 12,
      liked: false,
      mine: false
    },
    {
      id: 'seed-2',
      name: 'Kevin',
      langName: '英语',
      text: 'A2 餐厅点餐课学完，昨天给外国同事推荐了菜单，成就感和实用性双达标 🥳',
      at: dayjs(now - 26 * 3600 * 1000).toISOString(),
      likes: 8,
      liked: false,
      mine: false
    },
    {
      id: 'seed-3',
      name: 'momo',
      langName: '韩语',
      text: '连续打卡 5 天！티켓和환승记住了，下周去首尔地铁实测 🚇',
      at: dayjs(now - 2 * 24 * 3600 * 1000).toISOString(),
      likes: 21,
      liked: false,
      mine: false
    }
  ];
}

interface CommunityStore {
  posts: Post[];
}

function readCommunity(): CommunityStore {
  try {
    const raw = Taro.getStorageSync(COMMUNITY_STORE_KEY);
    if (raw && Array.isArray(raw.posts)) return { posts: raw.posts };
  } catch (err) {
    console.warn('[learnCommunity] read failed:', err);
  }
  return { posts: seedPosts() };
}

function writeCommunity(store: CommunityStore) {
  try {
    Taro.setStorageSync(COMMUNITY_STORE_KEY, store);
  } catch (err) {
    console.warn('[learnCommunity] write failed:', err);
  }
}

function LearnCommunityPage() {
  const t = useT();
  const [achievements, setAchievements] = useState<Achievement[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [draft, setDraft] = useState('');
  const [name, setName] = useState('我');
  const [editingName, setEditingName] = useState(false);
  const [streak, setStreak] = useState(0);
  const activeLang = readLearnStore().activeLang || 'en';
  const lang = LEARN_LANGS.find((l) => l.id === activeLang) || LEARN_LANGS[0];

  const refresh = () => {
    setAchievements(getAchievements());
    setPosts(readCommunity().posts);
    setStreak(getStreak());
    setName(getLearnerName());
  };

  useEffect(refresh, []);

  const unlocked = achievements.filter((a) => a.unlockedAt).length;

  const submitPost = () => {
    const text = draft.trim();
    if (!text) {
      Taro.showToast({ title: '说点什么再发布吧', icon: 'none' });
      return;
    }
    const post: Post = {
      id: `p-${Date.now()}`,
      name: getLearnerName(),
      langName: lang.name,
      text: text.slice(0, 200),
      at: new Date().toISOString(),
      likes: 0,
      liked: false,
      mine: true
    };
    const next = [post, ...posts].slice(0, 50);
    setPosts(next);
    writeCommunity({ posts: next });
    setDraft('');
    Taro.showToast({ title: '已发布到打卡墙', icon: 'success' });
  };

  const toggleLike = (id: string) => {
    const next = posts.map((p) =>
      p.id === id ? { ...p, liked: !p.liked, likes: p.likes + (p.liked ? -1 : 1) } : p
    );
    setPosts(next);
    writeCommunity({ posts: next });
  };

  const saveName = () => {
    setEditingName(false);
    setLearnerName(name || '我');
    setName(getLearnerName());
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
