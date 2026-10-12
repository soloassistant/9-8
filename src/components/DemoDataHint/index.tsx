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
 * 文案复用 `briefing.degraded`（「当前为演示数据，云端服务尚未接通」）：
 * 被登记的 action 都是回退到**演示/本地实现**的，措辞准确；返回**真实本地数据**的
 * action（getLibrary / shopping / confirmItem / getUsage）已在 cloud.ts 侧排除，
 * 不会出现「把真实数据说成演示数据」的反向谎言。
 *
 * 无障碍：这里只渲染文本，**不写 role/aria-*** —— Taro 的 View/Text 不把这些未知属性
 * 透传到 H5 真实节点（详见 components/Splash 的 nativeProps 说明），写上去属于假修。
 * 文本本身就能被读屏获取，不需要额外标注。
 */
function DemoDataHint() {
  const t = useT();
  const [actions, setActions] = useState<string[]>(() => getDegradedActions());

  // subscribeDegraded 订阅时立即回调一次当前快照，并返回取消订阅函数
  useEffect(() => subscribeDegraded(setActions), []);

  if (actions.length === 0) return null;

  return (
    <View className={styles.hint}>
      <Text className={styles.text}>{t('briefing.degraded')}</Text>
    </View>
  );
}

export default DemoDataHint;
