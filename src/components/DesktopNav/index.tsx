/**
 * DesktopNav —— 桌面端（≥1200px）左栏导航，替换 Taro 的 tabBar。
 *
 * 为什么要自绘：设计稿 p56 的左栏是 **10 项 + 未读数 + 品牌/日期 + 底部用户**，
 * 而 Taro 的 tabBar 在 app.config 里最多 5 项、且不能分组/加计数。把它当侧栏用
 * （600px 起靠 CSS 变竖排）只能到 5 项，剩下的入口全埋在「我的」九宫格里。
 *
 * 边界：
 *   · 只在 H5 且 ≥1200px 挂载（CSS 控制显隐）；窄屏仍旧用 Taro tabBar，不动。
 *   · 分组与设计稿一致：主导航 8 项 + 「其他」2 项（设置 / 我的）。
 *   · 计数只显示**真实的**：收件箱待办数来自 drafts 的持久化键，没有就不显示数字，
 *     绝不为了"看起来像设计稿"编一个 2。
 */
import { pressableProps } from '@/utils/a11y';
import { useCallback, useEffect, useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useT } from '@/store/language';
import { brandVars, useThemeStore } from '@/store/theme';
import styles from './index.module.scss';

export interface Item {
  key: string;
  icon: string;
  labelKey: string;
  url: string;
  /** tabBar 页只能 switchTab，二级页走 navigateTo —— 混用会直接抛错 */
  tab: boolean;
}

/**
 * ⚠️ 这两个数组是**全站桌面左栏的唯一数据源**。晨报页（`pages/briefing`）的
 * 自绘侧栏也从这里派生（见该文件 `SIDE_NAV`），不要再在页面里写第二份。
 * 2026-10-29 巡检发现两套列表各自漂移：晨报页 6 项、其余页 10 项，
 * 桌面用户在晨报页找不到学习/运动/省钱/记账。
 */
export const NAV_MAIN: Item[] = [
  { key: 'today', icon: '☀️', labelKey: 'tab.briefing', url: '/pages/briefing/index', tab: true },
  { key: 'inbox', icon: '📥', labelKey: 'tab.inbox', url: '/pages/inbox/index', tab: true },
  { key: 'hot', icon: '🔥', labelKey: 'tab.hotspot', url: '/pages/library/index', tab: true },
  { key: 'calendar', icon: '📅', labelKey: 'tab.calendar', url: '/pages/calendar/index', tab: true },
  { key: 'learn', icon: '📚', labelKey: 'nav.learn', url: '/pages/learn/index', tab: false },
  { key: 'sport', icon: '🏃', labelKey: 'nav.sport', url: '/pages/sport/index', tab: false },
  { key: 'save', icon: '🛍️', labelKey: 'nav.save', url: '/pages/shopping/index', tab: false },
  { key: 'ledger', icon: '🧾', labelKey: 'nav.ledger', url: '/pages/ledger/index', tab: false }
];

export const NAV_MORE: Item[] = [
  { key: 'prefs', icon: '⚙️', labelKey: 'nav.settings', url: '/pages/prefs/index', tab: false },
  { key: 'mine', icon: '🙂', labelKey: 'tab.mine', url: '/pages/mine/index', tab: true }
];

function currentRoute(): string {
  const pages = Taro.getCurrentPages();
  const cur = pages[pages.length - 1];
  return cur ? `/${cur.route || ''}` : '';
}

export default function DesktopNav() {
  const t = useT();
  const { theme } = useThemeStore();
  const [route, setRoute] = useState(currentRoute);

  // 路由变化：Taro 的 tab 页切换不会卸载本组件，只能靠监听 hash/popstate 同步高亮。
  useEffect(() => {
    const sync = () => setRoute(currentRoute());
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    const timer = setInterval(sync, 600); // navigateTo 后 hash 可能不触发事件，兜底轮询
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
      clearInterval(timer);
    };
  }, []);

  const go = useCallback((it: Item) => {
    if (it.url === currentRoute()) return;
    const nav = it.tab
      ? Taro.switchTab({ url: it.url })
      : Taro.navigateTo({ url: it.url });
    nav.catch((err) => {
      console.error('[DesktopNav] 导航失败:', it.url, err);
    });
  }, []);

  const today = new Date();
  const dateLabel = `${today.getMonth() + 1} 月 ${today.getDate()} 日`;

  const renderItem = (it: Item) => {
    const active = route.indexOf(it.url.replace('/index', '')) >= 0;
    return (
      <View
        key={it.key}
        className={active ? `${styles.item} ${styles.itemActive}` : styles.item}
        onClick={() => go(it)}
        // 键盘可达（2026-10-29）：桌面导航是键盘用户最该先摸到的东西
        {...pressableProps(`${t(it.labelKey as never)}（${active ? '当前页' : '前往'}）`)}
      >
        <Text className={styles.icon}>{it.icon}</Text>
        <Text className={styles.label}>{t(it.labelKey as never)}</Text>
      </View>
    );
  };

  return (
    <View className={styles.nav} style={brandVars(theme)}>
      <View className={styles.brandRow}>
        <View className={styles.logo}>
          <Text className={styles.logoText}>晨</Text>
        </View>
        <View className={styles.brandMeta}>
          <Text className={styles.brandTitle}>{t('app.title')}</Text>
          <Text className={styles.brandDate}>{dateLabel}</Text>
        </View>
      </View>

      <View className={styles.group}>{NAV_MAIN.map(renderItem)}</View>
      <Text className={styles.groupLabel}>{t('nav.more')}</Text>
      <View className={styles.group}>{NAV_MORE.map(renderItem)}</View>
    </View>
  );
}
