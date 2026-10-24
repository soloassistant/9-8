import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Input, ScrollView } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { apiGetBriefing, apiGetLibrary, apiNewsSearch } from '@/services/api';
import { formatEventTime } from '@/utils/date';
import { openExternalPage } from '@/utils/externalLink';
import { brandVars, useThemeStore } from '@/store/theme';
import type { Briefing, CollectionItem, HotspotNews } from '@/types';
import { useT, useLanguageStore } from '@/store/language';
import styles from './index.module.scss';

interface SearchResult {
  events: Briefing['events'];
  todos: Briefing['todos'];
  collections: CollectionItem[];
}

function SearchPage() {
  const t = useT();
  const lang = useLanguageStore((s) => s.lang);
  const { theme } = useThemeStore();
  const [keyword, setKeyword] = useState('');
  /**
   * 搜索范围（2026-10-24 新增）：本站 = 日程/待办/收藏纯本地过滤；
   * 全网 = webSearch 云函数 action='searchNews'（Bing News RSS + LLM 兜底）。
   * 此前本页只做本地过滤，apiNewsSearch 一直没被调用 —— "搜索"实际只能搜到自己的数据。
   */
  const [scope, setScope] = useState<'local' | 'web'>('local');
  const [webItems, setWebItems] = useState<HotspotNews[] | null>(null);
  const [webLoading, setWebLoading] = useState(false);
  const [webFailed, setWebFailed] = useState(false);
  const webSeq = useRef(0);
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

  /**
   * 全网检索（2026-10-24 接上）：`apiNewsSearch` 早已实现（webSearch 云函数
   * action='searchNews'，Bing News RSS + LLM 联网兜底），但本页此前从未调用 —— 用户
   * 搜什么都只能搜到自己的日程/待办/收藏。
   *
   * 语义三分（失败 ≠ 空是本项目反复修过的坑，这里必须分开）：
   *   · null  → 通道不可用（云端未就绪 / 未登录 / 网络失败）→ 如实提示，不伪装成"没搜到"
   *   · []    → 真没搜到 → 正常空态
   *   · items → 展示
   */
  useEffect(() => {
    const kw = keyword.trim();
    if (scope !== 'web' || !kw) {
      setWebItems(null);
      setWebFailed(false);
      setWebLoading(false);
      return;
    }
    const seq = ++webSeq.current;
    setWebLoading(true);
    setWebFailed(false);
    // 防抖 400ms：别每敲一个字就打一次云函数（也有配额成本）
    const timer = setTimeout(() => {
      apiNewsSearch(kw)
        .then((items) => {
          if (seq !== webSeq.current) return; // 旧请求晚到，不覆盖新结果
          if (items === null) {
            setWebFailed(true);
            setWebItems(null);
          } else {
            setWebItems(items);
          }
        })
        .finally(() => {
          if (seq === webSeq.current) setWebLoading(false);
        });
    }, 400);
    return () => clearTimeout(timer);
  }, [keyword, scope]);

  const scopeLabel = useCallback(
    (k: 'local' | 'web') =>
      lang === 'en' ? (k === 'local' ? 'In-app' : 'Web') : k === 'local' ? '本站' : '全网',
    [lang]
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

  const goBackWithPick = useCallback(
    (label: string) => {
      // 名字叫 goBackWithPick，但原先只弹一条 toast 就结束 —— 用户点完搜索结果
      // 什么也没发生，仍停在搜索页（P1：「搜索结果只有 toast」）。
      // 至少要兑现名字里的 goBack：复用上面 handleBack 的 navigateBack + reLaunch 兜底。
      // ⚠️ 「把选中项回传给来源页」仍未实现：需要定 eventChannel 或 store 约定，
      //    属于产品交互决策，这里不擅自发明一个跳转目标（跳错页比不跳更坏）。
      Taro.showToast({ title: t('search.found', { q: label.slice(0, 8) }), icon: 'none' });
      handleBack();
    },
    [t, handleBack]
  );

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

      {/* 搜索范围切换：本站（日程/待办/收藏，纯本地）· 全网（webSearch.searchNews） */}
      <View className={styles.scopeTabs}>
        {(['local', 'web'] as const).map((k) => (
          <View
            key={k}
            className={`${styles.scopeTab} ${scope === k ? styles.scopeTabActive : ''}`}
            onClick={() => setScope(k)}
          >
            <Text className={scope === k ? styles.scopeTabTextActive : styles.scopeTabText}>
              {scopeLabel(k)}
            </Text>
          </View>
        ))}
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
      ) : scope === 'web' ? (
        webLoading ? (
          <View className={styles.hint}>
            <Text>{t('search.loading')}</Text>
          </View>
        ) : webFailed ? (
          <View className={styles.hint}>
            <Text className={styles.hintIcon}>📡</Text>
            <Text>
              {lang === 'en'
                ? 'Web search is unavailable right now (cloud not ready). Switch to In-app to search your schedule, to-dos and favorites.'
                : '全网检索暂不可用（云端服务未就绪），可切回「本站」搜索你的日程、待办与收藏'}
            </Text>
          </View>
        ) : webItems && webItems.length > 0 ? (
          <ScrollView scrollY className={styles.results}>
            <View className={styles.group}>
              <Text className={styles.groupTitle}>{`${scopeLabel('web')} · ${webItems.length}`}</Text>
              {webItems.map((item) => (
                <View
                  key={item.id}
                  className={styles.row}
                  onClick={() => {
                    if (!item.url) {
                      Taro.showToast({
                        title: lang === 'en' ? 'No source link for this item' : '该条暂无原文链接',
                        icon: 'none'
                      });
                      return;
                    }
                    void openExternalPage(item.url);
                  }}
                >
                  <Text className={styles.rowMain}>{item.title}</Text>
                  <Text className={styles.rowMeta}>{item.source}</Text>
                </View>
              ))}
            </View>
          </ScrollView>
        ) : (
          <View className={styles.hint}>
            <Text className={styles.hintIcon}>🫙</Text>
            <Text>{t('search.noResult', { q: keyword.trim() })}</Text>
          </View>
        )
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
