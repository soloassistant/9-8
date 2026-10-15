import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, Input, ScrollView } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { apiGetBriefing, apiGetLibrary } from '@/services/api';
import { formatEventTime } from '@/utils/date';
import { brandVars, useThemeStore } from '@/store/theme';
import type { Briefing, CollectionItem } from '@/types';
import { useT } from '@/store/language';
import styles from './index.module.scss';

interface SearchResult {
  events: Briefing['events'];
  todos: Briefing['todos'];
  collections: CollectionItem[];
}

function SearchPage() {
  const t = useT();
  const { theme } = useThemeStore();
  const [keyword, setKeyword] = useState('');
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [library, setLibrary] = useState<CollectionItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [b, lib] = await Promise.all([apiGetBriefing(), apiGetLibrary()]);
        if (!alive) return;
        setBriefing(b);
        setLibrary(lib);
      } catch (err) {
        // 错误痕迹与是否已卸载无关，始终记录
        console.error('[SearchPage] load data failed:', err);
        if (alive) Taro.showToast({ title: t('common.loadFailed'), icon: 'none' });
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // t 仅用于失败提示文案；本 effect 负责加载数据，语言切换无需重跑请求
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const result: SearchResult = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return { events: [], todos: [], collections: [] };
    const hit = (text?: string) => !!text && text.toLowerCase().includes(kw);
    return {
      events: (briefing?.events || []).filter((e) => hit(e.title) || hit(e.location)),
      todos: (briefing?.todos || []).filter((todo) => hit(todo.title)),
      collections: library.filter((c) => hit(c.title) || hit(c.summary) || c.tags.some(hit))
    };
  }, [keyword, briefing, library]);

  const total = result.events.length + result.todos.length + result.collections.length;

  const goBackWithPick = useCallback(
    (label: string) => {
      Taro.showToast({ title: t('search.found', { q: label.slice(0, 8) }), icon: 'none' });
    },
    [t]
  );

  /**
   * 明确的返回入口（2026-10-15 补）。
   *
   * 此前本页只有顶部一个 Input，**页内没有任何返回控件**；H5 下 TabRouter 不渲染原生
   * 导航栏，所以空结果态下用户「看不到回去的路」——实测巡检只能靠敲首页地址退出。
   * 这里显式放一个返回键：优先 navigateBack（保留来源页状态），栈里只剩本页时
   * 兜底 reLaunch 回晨报，避免走进死路。
   */
  const handleBack = useCallback(() => {
    const pages = Taro.getCurrentPages();
    if (pages.length > 1) {
      Taro.navigateBack().catch(() => {
        Taro.reLaunch({ url: '/pages/briefing/index' });
      });
      return;
    }
    Taro.reLaunch({ url: '/pages/briefing/index' });
  }, []);

  return (
    <View className={styles.page} style={brandVars(theme)}>
      <View className={styles.searchBar}>
        <View className={styles.backButton} onClick={handleBack}>
          <Text className={styles.backIcon}>‹</Text>
          <Text className={styles.backText}>{t('common.back')}</Text>
        </View>
        <Input
          className={styles.searchInput}
          value={keyword}
          placeholder={t('search.placeholder')}
          focus
          confirmType='search'
          onInput={(e) => setKeyword(e.detail.value)}
          onConfirm={() => setKeyword((k) => k.trim())}
        />
      </View>

      {loading ? (
        <View className={styles.hint}>
          <Text>{t('search.loading')}</Text>
        </View>
      ) : !keyword.trim() ? (
        <View className={styles.hint}>
          <Text className={styles.hintIcon}>🔍</Text>
          <Text>{t('search.empty')}</Text>
        </View>
      ) : total === 0 ? (
        <View className={styles.hint}>
          <Text className={styles.hintIcon}>🫙</Text>
          <Text>{t('search.noResult', { q: keyword.trim() })}</Text>
        </View>
      ) : (
        <ScrollView scrollY className={styles.results}>
          {result.events.length > 0 ? (
            <View className={styles.group}>
              <Text className={styles.groupTitle}>{t('search.groupEvents', { n: result.events.length })}</Text>
              {result.events.map((evt) => (
                <View key={evt.id} className={styles.row} onClick={() => goBackWithPick(evt.title)}>
                  <Text className={styles.rowMain}>{evt.title}</Text>
                  <Text className={styles.rowMeta}>{formatEventTime(evt.startTime)}</Text>
                </View>
              ))}
            </View>
          ) : null}

          {result.todos.length > 0 ? (
            <View className={styles.group}>
              <Text className={styles.groupTitle}>{t('search.groupTodos', { n: result.todos.length })}</Text>
              {result.todos.map((todo) => (
                <View key={todo.id} className={styles.row} onClick={() => goBackWithPick(todo.title)}>
                  <Text className={styles.rowMain}>{todo.title}</Text>
                  <Text className={styles.rowMeta}>{todo.dueDate ? formatEventTime(todo.dueDate) : t('search.noDue')}</Text>
                </View>
              ))}
            </View>
          ) : null}

          {result.collections.length > 0 ? (
            <View className={styles.group}>
              <Text className={styles.groupTitle}>{t('search.groupFavorites', { n: result.collections.length })}</Text>
              {result.collections.map((item) => (
                <View key={item.id} className={styles.row} onClick={() => goBackWithPick(item.title)}>
                  <Text className={styles.rowMain}>{item.title}</Text>
                  <Text className={styles.rowMeta}>{item.tags.join(' / ') || item.sourceType}</Text>
                </View>
              ))}
            </View>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}

export default SearchPage;
