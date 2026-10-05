import React, { useEffect, useState } from 'react';
import Taro, { useDidShow } from '@tarojs/taro';
import AiAssistant from '@/components/AiAssistant';
import Splash from '@/components/Splash';
// 进入门禁：H5/发布版未登录不得进入（微信端身份由微信提供，直接放行）
import { needsAuthGate, getSession } from '@/services/cloudAuth';
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
  // 当前路由：用于把**应用外壳**（AI 悬浮球、开屏动画）挡在登录页之外。
  // 实测依据（2026-10-05 浏览器核对）：登录页上确实渲染了 🤖 悬浮球与「点击进入」开屏，
  // 未登录用户会看到一个能用但点了没用的浮层 —— 属于状态泄漏。
  // H5 首帧就同步读 hash，避免先渲染再卸载造成闪动。
  const [route, setRoute] = useState(() => {
    if (process.env.TARO_ENV === 'h5' && typeof window !== 'undefined') return window.location.hash || '';
    return '';
  });
  const isLoginPage = route.indexOf('login') >= 0;
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
    setRoute(route);
    setContext(routeToContext(route));
    // 门禁：未登录且不在登录页 → 送回登录页。放在 useDidShow 是因为它覆盖
    // 「切 tab / 深链 / 冷启动」所有进入路径。
    // 注意实现方式是**重定向**，而不是在 App 里不渲染 children —— 后者会打断
    // Taro 的页面生命周期（实测抛「没有找到页面实例」并整页白屏，只剩 Tab 栏）。
    if (needsAuthGate && route && !route.includes('login')) {
      getSession().then((s) => {
        if (!s) Taro.redirectTo({ url: '/pages/login/index' }).catch(() => {});
      });
    }
  });

  return (
    <>
      {props.children}
      {/* 应用外壳一律不进登录页：未登录时它既无用又泄漏"应用已就绪"的错觉 */}
      {isLoginPage ? null : (
        <React.Fragment>
          {/* 晨报页有常驻输入栏（含快捷指令条），AI 悬浮球需额外抬升避让 */}
          <AiAssistant context={context} offset={context === 'briefing' ? 240 : 40} />
          {/* 开屏动画：每次冷启动展示，点击可跳过 */}
          <Splash />
        </React.Fragment>
      )}
    </>
  );
}

export default App;