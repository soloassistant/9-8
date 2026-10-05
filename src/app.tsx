import React, { useEffect, useState } from 'react';
import Taro, { useDidShow } from '@tarojs/taro';
import AiAssistant from '@/components/AiAssistant';
import Splash from '@/components/Splash';
// 进入门禁：H5/发布版未登录不得进入（微信端身份由微信提供，直接放行）
import { needsAuthGate, getSession } from '@/services/cloudAuth';
import { useLanguageStore, dict, STORAGE_KEY as LANG_KEY } from '@/store/language';
import { useThemeStore, STORAGE_KEY as THEME_KEY } from '@/store/theme';
import { useUiScaleStore, STORAGE_KEY as UI_SCALE_KEY } from '@/store/uiScale';
import { initCloudSync } from '@/services/cloudSync';
// 全局样式
import './app.scss';

// 用户数据轻云同步（仅 H5）：必须在任何页面读取 storage 之前完成云端恢复，故模块加载即执行
initCloudSync();

/**
 * 云端恢复**重放**（2026-10-05 实测缺陷）：ESM 会把被 import 的 store 模块体求值提到
 * 上面 `initCloudSync()` 之前 —— 三个 store 在创建时读到的是「恢复前」的 storage，
 * 之后也不会自己重读。结果是**跨设备改过的语言/主题/字号在首刷不生效**：
 * 数据其实已经从云端拉回来了（pullRemote 是同步 XHR），但界面仍是默认值。
 *
 * 所以在同步拉取完成后，按同一份 storage 重放一次。**不要去改 store 模块体**去解决 ——
 * 那会把「什么时候读」的时序问题散到三个文件里，而且下次加 store 又会漏。
 */
function rehydrateStoresAfterCloudPull(): void {
  try {
    const lang = Taro.getStorageSync(LANG_KEY);
    if (lang === 'zh' || lang === 'en') useLanguageStore.getState().setLang(lang);
    const theme = Taro.getStorageSync(THEME_KEY);
    if (typeof theme === 'string' && theme) useThemeStore.getState().setTheme(theme);
    const scale = Taro.getStorageSync(UI_SCALE_KEY);
    if (typeof scale === 'string' && scale) useUiScaleStore.getState().setScale(scale);
  } catch (err) {
    console.warn('[App] rehydrate stores after cloud pull failed:', err);
  }
}
rehydrateStoresAfterCloudPull();

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