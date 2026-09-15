import React, { useEffect, useState } from 'react';
import Taro, { useDidShow } from '@tarojs/taro';
import AiAssistant from '@/components/AiAssistant';
import Splash from '@/components/Splash';
import { useLanguageStore, dict } from '@/store/language';
import { initCloudSync } from '@/services/cloudSync';
// 全局样式
import './app.scss';

// 用户数据轻云同步（仅 H5）：必须在任何页面读取 storage 之前完成云端恢复，故模块加载即执行
initCloudSync();

/** TabBar 文案：语言切换时同步更新（index 与 app.config.ts tabBar list 顺序一致） */
const TAB_KEYS = ['tab.briefing', 'tab.inbox', 'tab.hotspot', 'tab.calendar', 'tab.mine'] as const;

function syncTabBar(lang: 'zh' | 'en') {
  TAB_KEYS.forEach((key, index) => {
    try {
      Taro.setTabBarItem({ index, text: dict[lang][key] });
    } catch (err) {
      console.warn(`[App] setTabBarItem #${index} failed:`, err);
    }
  });
}

/** 路由 → AI Context（用于主动建议提示语） */
function routeToContext(route: string): string {
  if (!route) return '';
  if (route.includes('briefing')) return 'briefing';
  if (route.includes('inbox')) return 'inbox';
  if (route.includes('Library') || route.includes('library')) return 'hotspot';
  if (route.includes('calendar')) return 'calendar';
  if (route.includes('mine')) return 'mine';
  if (route.includes('search')) return 'search';
  if (route.includes('settings')) return 'settings';
  if (route.includes('shopping')) return 'shopping';
  if (route.includes('history')) return 'history';
  return '';
}

function App(props) {
  const [context, setContext] = useState('');
  const lang = useLanguageStore((s) => s.lang);

  // 语言变化（含恢复本地选择）时同步 TabBar 文案；延迟执行等 H5 TabBar 渲染就绪，否则刷新后仍为默认文案
  useEffect(() => {
    const timer = setTimeout(() => syncTabBar(lang), 300);
    return () => clearTimeout(timer);
  }, [lang]);

  useEffect(() => {
    // 云开发初始化：仅微信小程序平台启用（H5/其他平台走 mock 数据）
    if (process.env.TARO_ENV === 'weapp') {
      if (Taro.cloud) {
        // 云环境 ID：config/index.ts defineConstants 编译期注入（系统环境变量 TARO_APP_CLOUD_ENV，或直接填值）；空串 = 默认环境
        Taro.cloud.init({ env: TARO_APP_CLOUD_ENV || '', traceUser: true });
        console.info('[App] cloud init done, env =', TARO_APP_CLOUD_ENV || '(default)');
      } else {
        console.error('[App] Taro.cloud is unavailable, please check base library version');
      }
    }
  }, []);

  // 对应 onShow：感知当前路由，让 AI 在不同界面给出不同主动建议
  useDidShow(() => {
    const pages = Taro.getCurrentPages();
    const current = pages[pages.length - 1];
    const route = current ? current.route || '' : '';
    setContext(routeToContext(route));
  });

  return (
    <React.Fragment>
      {props.children}
      {/* 晨报页有常驻输入栏（含快捷指令条），AI 悬浮球需额外抬升避让 */}
      <AiAssistant context={context} offset={context === 'briefing' ? 240 : 40} />
      {/* 开屏动画：每次冷启动展示，点击可跳过 */}
      <Splash />
    </React.Fragment>
  );
}

export default App;