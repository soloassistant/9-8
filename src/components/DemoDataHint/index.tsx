import { useEffect, useState } from 'react';
import { View, Text } from '@tarojs/components';
import { getDegradedActions, subscribeDegraded } from '@/services/cloud';
import { useT } from '@/store/language';
import styles from './index.module.scss';

/**
 * 数据降级提示（诚实性，2026-10-12）。
 *
 * 背景：H5 端多数云函数没有可用的 RPC 通道（src/services/dataSource.ts 的 RPC_ALLOWLIST
 * 只放行 webSearch / chat / extract），拿不到就静默回退 src/data/* 本地实现 —— 用户看到
 * 的是演示/本地数据，界面上却没有任何提示，会当成真实数据。唯一做对的是晨报页
 * （src/pages/briefing/index.tsx 用 briefing.intel.degraded 显示提示）。
 *
 * 这里复用同一套「可被 UI 观察」的机制：services/cloud.ts 维护降级登记表，
 * 本组件订阅它，有降级就渲染一行提示，真实路径成功后条目被清掉、提示自动消失。
 *
 * 文案用 `cloud.degradedHint`（「云端功能暂不可用，当前为本地演示数据」）：
 * 被登记的 action 都是回退到**演示/本地实现**的，措辞准确；返回**真实本地数据**的
 * action（getLibrary / shopping / confirmItem / getUsage）已在 cloud.ts 侧排除，
 * 不会出现「把真实数据说成演示数据」的反向谎言。
 * 2026-10-24：不再复用 `briefing.degraded` —— 那把钥匙现在专指晨报空态的
 * 「天气与资讯没取到」，与这里的「功能云端版不可用」是两件事；共用一句曾让
 * 旧文案写成不实的「云端服务尚未接通」（云服务本身实测是通的）。
 *
 * 无障碍：这里只渲染文本，**不写 role/aria-*** —— Taro 的 View/Text 不把这些未知属性
 * 透传到 H5 真实节点（详见 components/Splash 的 nativeProps 说明），写上去属于假修。
 * 文本本身就能被读屏获取，不需要额外标注。
 *
 * 2026-10-30 新增 `actions` prop（**页面粒度**）：
 *   降级登记表是**模块级全局**、SPA 跨页不清 —— 于是 A 页的一次降级会把横幅带到 B 页。
 *   线上实测（2026-10-30）：晨报页的 `apiGetVideoNews()` 走了 H5 上必然 404 的
 *   webSearch 的 rpc 调用 ⇒ `markDegraded('webSearch')` ⇒ 横幅跟着流到热点页，
 *   而热点页显示的是 **412 条真实 RSS** ⇒ 提示写「当前为本地演示数据」=
 *   **把真实数据说成演示数据**（反向谎言）。
 *   现在每个页面只声明**自己关心的 action**，别的页面的降级不会串进来。
 *   不传 actions = 显示全部（保持既有行为，给没有明确边界的页面用）。
 *
 * ⚠️ 2026-10-30 修一个语义陷阱：`actions={[]}`（显式空数组）此前会被当成「没传」
 *   —— 原判据写的是 `scope && scope.length ? 过滤 : 全部`，空数组的 length 是 0 ⇒
 *   走「全部」分支 ⇒ **本页本来什么都该不显示，却把全局降级横幅拉了过来**。
 *   现在以 `scope === undefined` 区分两者：
 *     · undefined（没传）⇒ 显示全部（既有行为）
 *     · []（传了空的）⇒ 本页不显示任何降级提示
 *   区分「没传」与「传了但为空」是必要的：页面级横幅的意义就是**不串台**。 */
function DemoDataHint({ actions: scope }: { actions?: string[] }) {
  const t = useT();
  const [degraded, setDegraded] = useState<string[]>(() => getDegradedActions());

  // subscribeDegraded 订阅时立即回调一次当前快照，并返回取消订阅函数
  useEffect(() => subscribeDegraded(setDegraded), []);

  // 页面粒度过滤：**只有没传 actions 时才显示全部**；传了（哪怕是空数组）就只看本页关心的
  const hit = scope === undefined ? degraded : degraded.filter((a) => scope.indexOf(a) >= 0);
  if (hit.length === 0) return null;

  return (
    <View className={styles.hint}>
      <Text className={styles.text}>{t('cloud.degradedHint')}</Text>
    </View>
  );
}

export default DemoDataHint;
