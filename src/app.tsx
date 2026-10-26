import React, { useEffect, useState } from 'react';
import type { PropsWithChildren } from 'react';
import Taro, { useDidShow } from '@tarojs/taro';
import Splash from '@/components/Splash';
import ConsentGate from '@/components/ConsentGate';
// 进入门禁：H5/发布版未登录不得进入（微信端身份由微信提供，直接放行）
import { needsAuthGate, getSession } from '@/services/cloudAuth';
import { hasAgreedConsent } from '@/data/legal';
import { useLanguageStore, dict, STORAGE_KEY as LANG_KEY } from '@/store/language';
import { useThemeStore, STORAGE_KEY as THEME_KEY } from '@/store/theme';
import { useUiScaleStore, STORAGE_KEY as UI_SCALE_KEY } from '@/store/uiScale';
import { initCloudSync } from '@/services/cloudSync';
import { reportCrash, installH5CrashHandlers } from '@/services/crashReport';
import type { CrashPayload } from '@/services/crashReport';
import { clientErrorInsert } from '@/services/cloudDb';
// 全局样式
import './app.scss';

// ========== 崩溃上报（P2） ==========
// 两条通道按端分派（细节与踩坑记录见 src/services/crashReport.ts 文件头）：
//   · 微信小程序：Taro.onError → reportError 云函数（要求 OPENID，H5 调不到）
//   · H5：window.onerror / unhandledrejection → 云库 log_client_error
//     （H5 的 Taro.onError 会把事件压扁成字符串，stack / filename / lineno 全丢，故不采用）
// 一律 fire-and-forget：上报失败静默，绝不阻断用户主流程。
const weappCrashTransport = async (p: CrashPayload): Promise<boolean> => {
  const cloud = (Taro as unknown as { cloud?: { callFunction?: (opt: { name: string; data: Record<string, unknown> }) => Promise<unknown> } }).cloud;
  if (!cloud?.callFunction) return false;
  await cloud.callFunction({
    name: 'reportError',
    data: { message: p.message, stack: p.stack, page: p.page, channel: p.channel, extra: { ua: p.ua } }
  });
  return true;
};

// H5 通道：只写不读的 SECURITY DEFINER 函数，原因见 cloudDb.clientErrorInsert 注释
const h5CrashTransport = (p: CrashPayload): Promise<boolean> => clientErrorInsert(p);

try {
  if (process.env.TARO_ENV === 'weapp') {
    Taro.onError((err: unknown) => {
      reportCrash(err, { transport: weappCrashTransport, channel: 'weapp' });
    });
  } else {
    installH5CrashHandlers(h5CrashTransport);
  }
} catch (hookErr) {
  // 用 console.error：生产构建会剔除 console.warn
  console.error('[App] 崩溃上报注册失败:', hookErr);
}

// 用户数据轻云同步（仅 H5）：必须在任何页面读取 storage 之前完成云端恢复，故模块加载即执行。
// 返回的 Promise 在**启动拉取结束后** resolve —— 重放必须挂在它后面（.then），
// 否则重放读到的是「恢复前」的 storage，跨设备改过的语言/主题/字号在首刷不生效。
void initCloudSync().then(() => rehydrateStoresAfterCloudPull());

/**
 * 云端恢复**重放**（2026-10-05 实测缺陷）：ESM 会把被 import 的 store 模块体求值提到
 * 上面 `initCloudSync()` 之前 —— 三个 store 在创建时读到的是「恢复前」的 storage，
 * 之后也不会自己重读。结果是**跨设备改过的语言/主题/字号在首刷不生效**：
 * 数据其实已经从云端拉回来了，但界面仍是默认值。
 *
 * 所以在启动拉取完成后（initCloudSync().then），按同一份 storage 重放一次。
 * **不要去改 store 模块体**去解决 —— 那会把「什么时候读」的时序问题散到三个文件里，
 * 而且下次加 store 又会漏。
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

function App(props: PropsWithChildren) {
  // 当前路由：用于把**应用外壳**（开屏动画）挡在登录页之外。
  // 实测依据（2026-10-05 浏览器核对）：登录页上确实渲染了 🤖 悬浮球与「点击进入」开屏，
  // 未登录用户会看到一个能用但点了没用的浮层 —— 属于状态泄漏。
  // H5 首帧就同步读 hash，避免先渲染再卸载造成闪动。
  const [route, setRoute] = useState(() => {
    if (process.env.TARO_ENV === 'h5' && typeof window !== 'undefined') return window.location.hash || '';
    return '';
  });
  const isLoginPage = route.indexOf('login') >= 0;
  const lang = useLanguageStore((s) => s.lang);

  // 应用级合规同意（H5 首启）：未同意前整屏遮罩，覆盖所有 tab 与 AI 悬浮球。
  // 小程序端依赖微信平台隐私弹窗，此处恒为 true 不参与。
  const [consentAgreed, setConsentAgreed] = useState(() =>
    process.env.TARO_ENV === 'h5' ? hasAgreedConsent() : true
  );

  /**
   * H5 路由跟随 —— **必须自己订阅导航，不能依赖 useDidShow**。
   *
   * 实测依据（2026-10-09，真 Chrome + CDP，在页面脚本前装路由事件记录器）：
   *   Taro H5 的页面跳转走 `history.replaceState` —— **既不派发 hashchange 也不派发 popstate**；
   *   而 App 级 `useDidShow` 随 app 显示触发，**不随导航重触发**。
   *   三种导航方式（replaceState / popstate / hashchange）逐一试过，`route` 状态都不更新。
   *
   * 后果（均在线上实测复现）：
   *   ① 从登录页登录进主应用后 `isLoginPage` 永远为 true → AI 悬浮球与开屏**永不挂载**，
   *      必须手动刷新才出现；C1 要求的「AI 对话页全程固定展示提示」因此在 H5 上拿不到。
   *   ② 反方向：未登录深链到受保护页、被门禁送回登录页后，外壳**仍留在登录页上**
   *      （未登录用户看到一个点了没用的浮层）—— 就是上面注释里说 2026-10-05 修掉的
   *      「状态泄漏」，其实当时只修了冷启动那半边。
   *
   * 所以这里直接盯住「导航本身」：包一层 history 方法 + 监听浏览器前进后退。
   * 只读 `window.location.hash`，与 Taro 的 router 内部状态无关，故不挑路由模式。
   */
  useEffect(() => {
    if (process.env.TARO_ENV !== 'h5' || typeof window === 'undefined') return;

    const syncRoute = () => setRoute(window.location.hash || '');
    syncRoute(); // 挂载时对齐一次（首帧的 useState 初值可能已过期，例如门禁重定向发生在首帧之后）

    window.addEventListener('hashchange', syncRoute);
    window.addEventListener('popstate', syncRoute);

    const pushOrig = window.history.pushState;
    const replaceOrig = window.history.replaceState;
    type HistoryArgs = Parameters<typeof window.history.pushState>;
    const wrap = (orig: typeof window.history.pushState) =>
      function (this: History, ...args: HistoryArgs) {
        const ret = orig.apply(this, args);
        syncRoute(); // replaceState 是同步的，返回时 location.hash 已是新值
        return ret;
      };
    window.history.pushState = wrap(pushOrig);
    window.history.replaceState = wrap(replaceOrig);

    return () => {
      window.removeEventListener('hashchange', syncRoute);
      window.removeEventListener('popstate', syncRoute);
      window.history.pushState = pushOrig;
      window.history.replaceState = replaceOrig;
    };
  }, []);

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

  // 对应 onShow：感知当前路由（登录门禁与开屏外壳都按它判断）
  useDidShow(() => {
    const pages = Taro.getCurrentPages();
    const current = pages[pages.length - 1];
    const nextRoute = current ? current.route || '' : '';
    setRoute(nextRoute);
    // 门禁：未登录且不在登录页 → 送回登录页。放在 useDidShow 是因为它覆盖
    // 「切 tab / 深链 / 冷启动」所有进入路径。
    // 注意实现方式是**重定向**，而不是在 App 里不渲染 children —— 后者会打断
    // Taro 的页面生命周期（实测抛「没有找到页面实例」并整页白屏，只剩 Tab 栏）。
    if (needsAuthGate && route && !route.includes('login')) {
      getSession().then((s) => {
        if (!s) {
          // ⚠️ 用 reLaunch 而非 redirectTo：前者只 unload 当前页但不清理 tabBar 缓存，
          // 导致 briefing 页一直留在 DOM 里且带 .taro_page_show.taro_page_stationed，
          // CSS 规则 `:not(.taro_tabbar_page)` 又不会隐藏 tabBar 页 → 真实访客跳登录后
          // 视觉上仍看着晨报页、完全登不了录（2026-10-20 CDP 实测）。reLaunch 会同步
          // 卸载 tabBar 缓存的页面实例，清掉双 stationed 导致的层层叠。
          Taro.reLaunch({ url: '/pages/login/index' }).catch((err) => {
            // 门禁重定向失败 = 未登录用户仍停留在受保护页，属真故障，必须留痕
            // （用 console.error：console.warn 会被生产构建剔除）
            console.error('[App] 门禁重定向登录页失败:', err);
          });
        }
      });
    }
  });

  return (
    <>
      {props.children}
      {/* 应用外壳一律不进登录页：未登录时它既无用又泄漏"应用已就绪"的错觉 */}
      {isLoginPage ? null : (
        <React.Fragment>
          {/* 2026-10-27：全局 AI 悬浮球已移除。全站唯一的 AI 入口是「我的 → AI 助手」
              （pages/assistant）。理由：它和晨报页底部输入条是同一件事的两个入口，
              两套实现各自维护；收敛成一个页面后，页面上不再有悬浮物遮挡正文。 */}
          {/* H5 首启合规同意层：未同意前整屏遮罩，覆盖所有 tab 页 */}
          {!consentAgreed ? <ConsentGate onAgree={() => setConsentAgreed(true)} /> : null}
          {/* 开屏动画：每次冷启动展示，点击可跳过 */}
          <Splash />
        </React.Fragment>
      )}
    </>
  );
}

export default App;