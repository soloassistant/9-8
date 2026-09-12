import { useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, Input, Image } from '@tarojs/components';
import Taro from '@tarojs/taro';
import dayjs from 'dayjs';
import classnames from 'classnames';
import TagChip from '@/components/TagChip';
import EmptyState from '@/components/EmptyState';
import { apiGetLibrary, apiGetHotspot, apiNewsSearch } from '@/services/api';
import { getHotspotMeta } from '@/services/cloud';
import { useUserStore } from '@/store/user';
import { fromNow } from '@/utils/date';
import { logActivity } from '@/utils/activityLog';
import type { CollectionItem, HotspotNews } from '@/types';
import { useT } from '@/store/language';
import styles from './index.module.scss';

const TYPE_ICONS: Record<CollectionItem['sourceType'], string> = {
  article: '📄',
  message: '💬',
  link: '🔗'
};

const HISTORY_KEY = 'browseHistory';
const HISTORY_LIMIT = 50;
const NEWS_FEEDBACK_KEY = 'newsFeedback';

/** 读取本地资讯反馈记录 */
function readNewsFeedback(): Record<string, 'up' | 'down'> {
  try {
    return Taro.getStorageSync(NEWS_FEEDBACK_KEY) || {};
  } catch (err) {
    console.warn('[LibraryPage] read newsFeedback failed:', err);
    return {};
  }
}

/** 资讯反馈云端落库（真机生效，失败静默） */
async function apiNewsFeedback(id: string, value: 'up' | 'down'): Promise<void> {
  try {
    await Taro.cloud?.callFunction({
      name: 'newsFeedback',
      data: { id, value }
    });
  } catch (err) {
    console.warn('[LibraryPage] apiNewsFeedback failed:', err);
  }
}

/** 记录浏览历史（v2.0，点头像在「我的-浏览历史」查看） */
export function recordBrowseHistory(entry: { id: string; title: string; source?: string }) {
  try {
    const list = Taro.getStorageSync(HISTORY_KEY) || [];
    const next = [
      { ...entry, viewedAt: dayjs().toISOString() },
      ...list.filter((it: { id: string }) => it.id !== entry.id)
    ].slice(0, HISTORY_LIMIT);
    Taro.setStorageSync(HISTORY_KEY, next);
  } catch (err) {
    console.error('[LibraryPage] record history failed:', err);
  }
}

function LibraryPage() {
  const t = useT();
  const [items, setItems] = useState<CollectionItem[]>([]);
  const [news, setNews] = useState<HotspotNews[]>([]);
  const [hotMeta, setHotMeta] = useState<ReturnType<typeof getHotspotMeta>>(null);
  const [activeNewsTag, setActiveNewsTag] = useState('全部');
  // F29 全网搜索：回车触发；真机走 webSearch 云函数（Bing News RSS），H5 预览/云端空结果走本地过滤兜底
  const [searchMode, setSearchMode] = useState(false);
  const [searchResults, setSearchResults] = useState<HotspotNews[]>([]);
  const [searching, setSearching] = useState(false);
  const [activeTag, setActiveTag] = useState('全部');
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(true);
  const [feedbackMap, setFeedbackMap] = useState<Record<string, 'up' | 'down'>>(() => readNewsFeedback());
  const { refreshUsage } = useUserStore();

  useEffect(() => {
    Promise.all([apiGetLibrary(), apiGetHotspot().catch(() => [])])
      .then(([lib, hotspot]) => {
        setItems(lib);
        setNews(hotspot);
        // 数据来源元信息（mock/真机 webSearch 路径为 null，不显示来源栏）
        setHotMeta(getHotspotMeta());
        refreshUsage();
      })
      .catch((err) => {
        console.error('[LibraryPage] load failed:', err);
        Taro.showToast({ title: '加载失败', icon: 'none' });
      })
      .finally(() => setLoading(false));
  }, []);

  const tags = useMemo(() => {
    const set = new Set<string>();
    items.forEach((item) => item.tags.forEach((t) => set.add(t)));
    return ['全部', ...Array.from(set)];
  }, [items]);

  const filtered = useMemo(
    () =>
      items.filter(
        (item) =>
          (activeTag === '全部' || item.tags.includes(activeTag)) &&
          (!keyword ||
            item.title.includes(keyword) ||
            item.summary.includes(keyword) ||
            item.tags.some((t) => t.includes(keyword)))
      ),
    [items, activeTag, keyword]
  );

  /** 资讯分类频道（F29）：全部 + 出现过的标签，超 8 个截断 */
  const newsTags = useMemo(
    () => ['全部', ...Array.from(new Set(news.flatMap((n) => n.tags))).slice(0, 8)],
    [news]
  );

  const newsFiltered = useMemo(
    () =>
      news.filter(
        (n) =>
          (activeNewsTag === '全部' || n.tags.includes(activeNewsTag)) &&
          (!keyword || n.title.includes(keyword) || n.summary.includes(keyword))
      ),
    [news, activeNewsTag, keyword]
  );

  const handleCopy = (item: CollectionItem) => {
    Taro.setClipboardData({
      data: `${item.title}\n${item.summary}`,
      success: () => Taro.showToast({ title: '摘要已复制', icon: 'success' })
    }).catch((err) => console.error('[LibraryPage] copy failed:', err));
  };

  const handleNewsTap = (item: HotspotNews) => {
    recordBrowseHistory({ id: item.id, title: item.title, source: item.source });
    logActivity('🔥', `浏览热点：${item.title.slice(0, 14)}`);
    Taro.showToast({ title: `来源：${item.source}`, icon: 'none', duration: 1500 });
  };

  /** 点封面图全屏预览（F29）；不触发卡片浏览行为 */
  const handleNewsImageTap = (item: HotspotNews) => {
    if (!item.image) return;
    Taro.previewImage({ urls: [item.image] }).catch((err) =>
      console.warn('[LibraryPage] previewImage failed:', err)
    );
  };

  /** 全网搜索（F29）：搜索键触发；云端无结果时回退本地热点过滤 */
  const handleNewsSearch = async () => {
    const kw = keyword.trim();
    if (!kw) {
      setSearchMode(false);
      setSearchResults([]);
      return;
    }
    setSearchMode(true);
    setSearching(true);
    const online = await apiNewsSearch(kw);
    const local = news.filter(
      (n) => n.title.includes(kw) || n.summary.includes(kw) || n.tags.some((tg) => tg.includes(kw))
    );
    setSearchResults(online && online.length ? online : local);
    setSearching(false);
    if (online && online.length) {
      logActivity('🔎', `全网搜索：${kw.slice(0, 14)}`);
    }
  };

  /** 清空关键词并退出全网搜索模式 */
  const handleClearSearch = () => {
    setKeyword('');
    setSearchMode(false);
    setSearchResults([]);
  };

  /** 资讯反馈（F22）：👍 有用 / 👎 不感兴趣；再点一次取消；本地持久化 + 云端落库 */
  const handleNewsFeedback = (item: HotspotNews, value: 'up' | 'down') => {
    const current = feedbackMap[item.id];
    const next = current === value ? undefined : value;
    const nextMap = { ...feedbackMap };
    if (next) nextMap[item.id] = next;
    else delete nextMap[item.id];
    setFeedbackMap(nextMap);
    try {
      Taro.setStorageSync(NEWS_FEEDBACK_KEY, nextMap);
    } catch (err) {
      console.warn('[LibraryPage] persist newsFeedback failed:', err);
    }
    if (next) {
      logActivity(next === 'up' ? '👍' : '👎', `资讯反馈：${item.title.slice(0, 14)}`);
      Taro.showToast({ title: t('library.feedbackSaved'), icon: 'none', duration: 1200 });
      // 云端落库（真机生效；取消反馈只改本地，云端按最新一条聚合）
      apiNewsFeedback(item.id, next).catch(() => {});
    }
  };

  return (
    <View className={styles.page}>
      <View className={styles.searchBar}>
        <Text className={styles.searchIcon}>🔍</Text>
        <Input
          className={styles.searchInput}
          value={keyword}
          placeholder={t('library.searchPlaceholder')}
          confirmType='search'
          onInput={(e) => setKeyword(e.detail.value)}
          onConfirm={() => handleNewsSearch()}
        />
        {keyword ? (
          <Text className={styles.searchGo} onClick={() => handleNewsSearch()}>
            {t('library.searchGo')}
          </Text>
        ) : null}
        {keyword ? (
          <Text className={styles.searchClear} onClick={handleClearSearch}>
            ✕
          </Text>
        ) : null}
      </View>

      {searchMode || newsFiltered.length > 0 ? (
        <View className={styles.hotspot}>
          <View className={styles.sectionBar}>
            <Text className={styles.sectionBarIcon}>{searchMode ? '🔎' : '🔥'}</Text>
            <Text className={styles.sectionBarTitle}>
              {searchMode ? `${t('library.searchOnlineTitle')} · ${keyword.trim().slice(0, 12)}` : t('library.hotTitle')}
            </Text>
            <Text className={styles.sectionBarHint}>{searchMode ? t('library.searchOnlineHint') : t('library.hotHint')}</Text>
          </View>
          {!searchMode && hotMeta ? (
            <View className={styles.dataMetaBar}>
              <Text className={styles.dataMetaText}>
                {t('library.dataUpdated')} {dayjs(hotMeta.updatedAt || Date.now()).format('HH:mm')}
                {hotMeta.stale ? ` · ${t('library.dataStale')}` : ''}
                {hotMeta.sources.length
                  ? ` · ${t('library.dataSources')}${hotMeta.sources.filter((s) => s.ok).map((s) => s.name).join('/')}`
                  : ''}
              </Text>
            </View>
          ) : null}
          {!searchMode && newsTags.length > 2 ? (
            <View className={styles.filterBar}>
              <ScrollView scrollX className={styles.chipScroll}>
                {newsTags.map((tag) => (
                  <TagChip
                    key={tag}
                    label={tag}
                    active={tag === activeNewsTag}
                    onClick={() => setActiveNewsTag(tag)}
                  />
                ))}
              </ScrollView>
            </View>
          ) : null}
          {searchMode && searching ? (
            <View className={styles.searchingTip}>
              <Text className={styles.searchingText}>{t('library.searchSearching')}</Text>
            </View>
          ) : null}
          {(searchMode ? searchResults : newsFiltered).map((item) => {
            const fb = feedbackMap[item.id];
            return (
              <View key={item.id} className={styles.newsCard} onClick={() => handleNewsTap(item)}>
                {item.image ? (
                  <Image
                    src={item.image}
                    mode='aspectFill'
                    lazyLoad
                    className={styles.newsImage}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleNewsImageTap(item);
                    }}
                  />
                ) : null}
                <Text className={styles.newsTitle}>{item.title}</Text>
                <Text className={styles.newsSummary}>{item.summary}</Text>
                <View className={styles.newsMeta}>
                  <Text className={styles.newsSource}>来源 · {item.source}</Text>
                  <Text className={styles.newsTime}>{fromNow(item.createTime)}</Text>
                </View>
                <View className={styles.feedbackRow} onClick={(e) => e.stopPropagation()}>
                  <Text
                    className={classnames(styles.feedbackBtn, fb === 'up' && styles.feedbackActive)}
                    onClick={() => handleNewsFeedback(item, 'up')}
                  >
                    👍 {t('library.feedbackUp')}
                  </Text>
                  <Text
                    className={classnames(styles.feedbackBtn, fb === 'down' && styles.feedbackActive)}
                    onClick={() => handleNewsFeedback(item, 'down')}
                  >
                    👎 {t('library.feedbackDown')}
                  </Text>
                </View>
              </View>
            );
          })}
          {searchMode && !searching && searchResults.length === 0 ? (
            <EmptyState
              icon='🔎'
              title={t('library.searchEmpty')}
              hint={t('library.searchEmptyHint')}
            />
          ) : null}
        </View>
      ) : null}

      <View className={styles.sectionBar}>
        <Text className={styles.sectionBarIcon}>🔖</Text>
        <Text className={styles.sectionBarTitle}>{t('library.favTitle')}</Text>
        <Text className={styles.sectionBarHint}>{t('library.favHint')}</Text>
      </View>

      <View className={styles.filterBar}>
        <ScrollView scrollX className={styles.chipScroll}>
          {tags.map((tag) => (
            <TagChip key={tag} label={tag} active={tag === activeTag} onClick={() => setActiveTag(tag)} />
          ))}
        </ScrollView>
      </View>

      <View className={styles.list}>
        {filtered.map((item) => (
          <View key={item.id} className={styles.card} onClick={() => handleCopy(item)}>
            <View className={styles.cardHeader}>
              <Text className={styles.typeIcon}>{TYPE_ICONS[item.sourceType]}</Text>
              <Text className={styles.title}>{item.title}</Text>
              <Text className={styles.time}>{fromNow(item.createTime)}</Text>
            </View>
            <Text className={styles.summary}>{item.summary}</Text>
            <View className={styles.tagRow}>
              {item.tags.map((t) => (
                <TagChip key={t} label={t} />
              ))}
            </View>
          </View>
        ))}
      </View>

      {!loading && filtered.length === 0 ? (
        <EmptyState
          icon='🔖'
          title={keyword ? '没有找到相关内容' : activeTag === '全部' ? '还没有收藏' : '这个标签下还没有内容'}
          hint={
            keyword
              ? '换个关键词试试，支持匹配标题、摘要和标签'
              : '在收件箱粘贴内容时勾选「收藏」，AI 摘要会存到这里'
          }
        />
      ) : null}
    </View>
  );
}

export default LibraryPage;
