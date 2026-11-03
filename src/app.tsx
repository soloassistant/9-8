import React, { useCallback, useEffect, useState } from 'react';
import type { PropsWithChildren } from 'react';
import Taro, { useDidShow } from '@tarojs/taro';
import Splash from '@/components/Splash';
import Onboarding, { hasOnboarded } from '@/components/Onboarding';
import DesktopNav from '@/components/DesktopNav';
import ConsentGate from '@/components/ConsentGate';
import HotkeyHelp from '@/components/HotkeyHelp';
import { HELP_EVENT, focusSearchBox, useGlobalHotkeys } from '@/hooks/useHotkeys';
import { hotkeyRoute } from '@/utils/hotkeys';
import type { HotkeyId } from '@/utils/hotkeys';
// 进入门禁：H5/发布版未登录不得进入（微信端身份由微信提供，直接放行）
import { needsAuthGate, getSession, markGateRedirect } from '@/services/cloudAuth';
import { hasAgreedConsent } from '@/data/legal';
import { useLanguageStore, dict, STORAGE_KEY as LANG_KEY } from '@/store/language';
import { useThemeStore, STORAGE_KEY as THEME_KEY } from '@/store/theme';
import { useUiScaleStore, STORAGE_KEY as UI_SCALE_KEY } from '@/store/uiScale';
import { initCloudSync } from '@/services/cloudSync';
import { restoreSubscriptionFromOrders } from '@/services/subscription';
import { dismissBootSkeletonAfterPaint } from '@/utils/bootSkeleton';
import { activatePressable, observePressables } from '@/utils/a11y';
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
void initCloudSync().then(() => {
  rehydrateStoresAfterCloudPull();
  // 订阅回放（2026-10-29 审计 P1）：原本只在会员中心页触发，于是**付费用户换设备/清缓存后
  // 首页仍是免费版** —— AI 额度、语音条数、收藏上限全按免费档算，权益等于丢了。
  // 挂到启动链上与云同步同一顺序（先 user_kv 再按 orders 回放到期日）；
  // 未登录时 ordersListOwn 返回 no-session，是正常分支，不报错；失败只留痕，不阻断启动。
  void restoreSubscriptionFromOrders().catch((err) => {
    console.error('[app] restore subscription from orders failed:', err);
  });
});

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
    // 用 console.error：生产构建只保留 console.error（stripConsoleExceptError），
    // 这里失败 = 云端拉回的用户设置没落到 store（跨设备改过的语言/主题/字号首刷不生效），
    // 属于需要人工介入的数据路径故障，不能只 warn —— warn 在线上产物里根本不存在。
    console.error('[App] rehydrate stores after cloud pull failed:', err);
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

  /* ===== 桌面端键盘快捷键（2026-10-27）=====
     只有 H5 + 有物理指针设备时才生效（useGlobalHotkeys 内部判 `(pointer: fine)`）。

     三个门禁叠在一起，避免「用户还在登录页 / 同意页 / 开屏上就响应按键」：
       · 登录页 —— 没有可跳转的目标；
       · 未同意合规 —— 遮罩之下一切交互本就该被阻断；
       · 开屏未消失 —— 不透明全屏层，面板会在它下面打开，用户看到的是「按了没反应」。
     小程序端不挂（没有物理键盘，挂上去只是白打代码）。 */
  const [helpOpen, setHelpOpen] = useState(false);
  const [shellReady, setShellReady] = useState(process.env.TARO_ENV !== 'h5');
  // 首次启动引导（设计稿 p19/p20）：只在 H5 且有真实账号体系时才有意义，
  // 看过一次就落库，不再骚扰（微信端直接视为已看过）。
  const [onboarded, setOnboarded] = useState(() => process.env.TARO_ENV !== 'h5' || hasOnboarded());
  // 外壳左栏导航：H5 + ≥600px 挂载（手机继续用 Taro 底部 tabBar）。
  // 同时给 body 打类，让 app.scss 把 Taro tabBar 关掉并把内容列按断点右移（64/232/240）。
  // 断点从 1200 降到 600 的原因：Taro tabBar 最多 5 项，768 的 iPad 上记账/运动/省钱
  // 全没有入口（2026-10-29 线上巡检）；自绘栏从 600 起就是同一份 10 项。
  const [desktopNav, setDesktopNav] = useState(false);
  useEffect(() => {
    if (process.env.TARO_ENV !== 'h5' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(min-width: 600px)');
    const apply = () => {
      setDesktopNav(mq.matches);
      document.body.classList.toggle('has-desktop-nav', mq.matches);
    };
    apply();
    mq.addEventListener('change', apply);
    return () => {
      mq.removeEventListener('change', apply);
      document.body.classList.remove('has-desktop-nav');
    };
  }, []);

  /**
   * 懒加载 chunk 加载失败的一次性自愈（2026-10-29 开启按页拆包后必需）。
   *
   * 场景：用户开着页面时我们发布了新版本 → 旧的页面 chunk（带内容 hash）被删除，
   * 他点开一个没加载过的页面，浏览器去拿 `js/p-xxx.<hash>.js` 拿到 404，
   * 页面停在空白/骨架屏上。历史上正是为了躲这个问题才把全站塞进一个 2.2MB 的单包里 ——
   * 但单包同样会 404（index.html 引用的 app.<hash>.js 一样会变），根因是**没有恢复机制**。
   *
   * 两类信号都要接：脚本元素 onerror（老浏览器的 chunk 失败只走这条）和
   * ChunkLoadError / "dynamically imported module" 的运行时错误。
   * 15 秒窗口内只救一次：第二次还失败说明不是版本漂移，重载只会变成刷屏死循环，
   * 那时应该让用户看到错误而不是无限刷新。
   *
   * ⚠️ 2026-10-30 加了**启动期豁免**：此前任何脚本加载失败（**包括网络抖动/超时**）
   *   都会整页 reload。而发布网关对单个请求有 20–31 秒的首字节长尾（实测），
   *   一次卡顿就会把用户从「已渲染的界面」打回「重新下载 900 KB + 骨架重来」——
   *   把一次局部抖动放大成整页重来，比不重载更糟。
   *   ⇒ 启动后 15 秒内不重载：那段时间多半是网络问题，不是版本漂移；
   *     真碰上版本漂移（首屏拿到的 index.html 是旧的）也有更好的出路 ——
   *     骨架的「重新加载」按钮带 cache-busting 的 query，会强制取一份**新的** index.html。
   *   启动期失败改为把骨架切到失败态（文案 + 可重试按钮），不再静默整页刷新。
   */
  useEffect(() => {
    if (process.env.TARO_ENV !== 'h5' || typeof window === 'undefined') return;
    const KEY = 'chunk-reload-at';
    /** 启动后这段时间内的失败不整页重载（见上方注释） */
    const BOOT_GRACE_MS = 15000;
    const onError = (e: Event) => {
      const target = e.target as HTMLElement | null;
      const scriptFailed = target && target.tagName === 'SCRIPT';
      const msg = String((e as ErrorEvent).message || '');
      const chunkFailed = /ChunkLoadError|Loading chunk|dynamically imported module|Importing a module script failed/i.test(msg);
      if (!scriptFailed && !chunkFailed) return;
      const inBoot = (() => {
        try {
          return typeof performance !== 'undefined' && performance.now() < BOOT_GRACE_MS;
        } catch {
          return false;
        }
      })();
      if (inBoot) {
        // 启动期：把骨架切到失败态，让用户看到「没加载出来」+ 能重试，而不是无限刷新
        console.error('[App] 启动期资源加载失败（不整页重载，交由骨架的失败态处理）:', scriptFailed ? 'script' : msg);
        try {
          const skel = document.getElementById('boot-skeleton');
          if (skel) skel.classList.add('is-fail');
        } catch {
          /* DOM 不可用就只记日志 */
        }
        return;
      }
      try {
        const last = Number(window.sessionStorage.getItem(KEY) || 0);
        if (Date.now() - last < 15000) return;
        window.sessionStorage.setItem(KEY, String(Date.now()));
      } catch {
        return; // sessionStorage 被禁（隐私模式）：不重载，避免无记录的死循环
      }
      console.error('[App] chunk 加载失败，重载一次以获取最新版本:', scriptFailed ? 'script' : msg);
      window.location.reload();
    };
    // 捕获阶段才能拿到资源加载错误（它们不冒泡）
    window.addEventListener('error', onError, true);
    return () => window.removeEventListener('error', onError, true);
  }, []);

  const handleHelpKey = useCallback(() => setHelpOpen(true), []);
  const handleSearchKey = useCallback(() => {
    // 当前页有搜索框就聚焦它（在搜索页再按 / 不该又开一页），否则去搜索页
    if (focusSearchBox()) return;
    Taro.navigateTo({ url: '/pages/search/index' }).catch((err) => {
      console.error('[App] hotkey search navigate failed:', err);
    });
  }, []);
  const handleNavigateKey = useCallback((id: HotkeyId) => {
    // 路由来自 HOTKEYS 表（tools 门禁会断言每个跳转键的目标页真实存在），
    // 不在 App 里再抄一份 switch —— 两处各写一遍，改路径时必漏。
    const url = hotkeyRoute(id);
    if (!url) return;
    Taro.switchTab({ url }).catch((err) => {
      console.error('[App] hotkey switchTab failed:', err);
    });
  }, []);
  const handleSplashGone = useCallback(() => setShellReady(true), []);

  useGlobalHotkeys({
    onHelp: handleHelpKey,
    onSearch: handleSearchKey,
    onNavigate: handleNavigateKey,
    enabled: !isLoginPage && consentAgreed && shellReady
  });

  // 键盘可达性（2026-10-29）：把 Enter / Space 翻译成「点击当前聚焦的可操作元素」。
  // 之所以做成**全局代理**而不是每个 View 挂 onKeyDown：taro-view-core 只稳定转发 onClick，
  // 键盘事件由这里统一接原生事件更可靠，且新加的可操作元素只要带 data-pressable 就自动生效。
  // 让路规则（输入框 / 修饰键 / IME 组字）见 utils/a11y.ts 的注释。
  useEffect(() => {
    if (process.env.TARO_ENV !== 'h5') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (activatePressable(e)) e.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    // 自定义元素上 React 的 tabIndex 不会落成属性（浏览器进 Tab 序列看的是属性），
    // 所以这里补 tabindex="0"，并用观察器覆盖动态渲染出来的列表项。见 utils/a11y.ts。
    const stopObserving = observePressables();
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      stopObserving();
    };
  }, []);

  // 首屏骨架退场（2026-10-29）：骨架写在 src/index.html，是 app 挂载前的唯一可见内容。
  // 这里等两帧（挂载完成 → 真正上屏）再淡出，避免「骨架撤了、界面还没画」的白闪。
  // app 自己的开屏（splash）在这一帧已经渲染，所以用户看到的是 骨架 → 开屏 → 内容，中间不断档。
  useEffect(() => {
    if (process.env.TARO_ENV !== 'h5') return;
    dismissBootSkeletonAfterPaint();
  }, []);

  // 「我的 → 键盘快捷键」入口：二级页没法直接改 App 的 state，走事件请求打开
  useEffect(() => {
    if (process.env.TARO_ENV !== 'h5') return;
    // Taro 的 eventCenter.on 返回 void，解绑只能靠 off（见 useHotkeys 里的同款注释）
    Taro.eventCenter.on(HELP_EVENT, handleHelpKey);
    return () => {
      Taro.eventCenter.off(HELP_EVENT, handleHelpKey);
    };
  }, [handleHelpKey]);

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

  // 登录页是独立的全屏版式：Taro 的 TabBar 由路由层渲染，不在 React 树里，
  // 所以只能在 body 上打类、由 app.scss 关掉（否则登录页底部挂着主 TabBar，
  // 未登录用户可以直接点进 tab 页，也会看到「应用已就绪」的错觉）。
  useEffect(() => {
    if (process.env.TARO_ENV !== 'h5') return;
    document.body.classList.toggle('is-login-page', isLoginPage);
    return () => document.body.classList.remove('is-login-page');
  }, [isLoginPage]);

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
          // 记一笔「刚刚被门禁送来登录页」：登录页据此跳过自己那次会话检查。
          // 否则冷启动未登录会连着发两次 POST /.cloud/auth/v1/token（2026-10-28 实测）。
          markGateRedirect();
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
      {/* ★ 2026-10-30：侧栏必须排在正文**之前**。
          DesktopNav 是 position:fixed，放在 children 前后视觉上完全一样，
          但**Tab 顺序按 DOM 走** —— 放在 children 后面时，键盘用户得先穿过整个正文
          才摸得到导航（资料库页实测 2121 个停靠点、导航排在第 2121 位）。
          登录页不渲染侧栏，所以此处要自己带 isLoginPage 守卫（原来靠外层 Fragment 兜着）。 */}
      {!isLoginPage && desktopNav ? <DesktopNav /> : null}
      {props.children}
      {/* 应用外壳一律不进登录页：未登录时它既无用又泄漏"应用已就绪"的错觉 */}
      {isLoginPage ? null : (
        <React.Fragment>
          {/* 2026-10-27：全局 AI 悬浮球已移除。全站唯一的 AI 入口是「我的 → AI 助手」
              （pages/assistant）。理由：它和晨报页底部输入条是同一件事的两个入口，
              两套实现各自维护；收敛成一个页面后，页面上不再有悬浮物遮挡正文。 */}
          {/* H5 首启合规同意层：未同意前整屏遮罩，覆盖所有 tab 页 */}
          {!consentAgreed ? <ConsentGate onAgree={() => setConsentAgreed(true)} /> : null}
          {/* 首启引导：必须等隐私同意之后再挂（两个全屏层叠在一起，用户会点不到下面那层），
              也必须等开屏退场（shellReady），否则引导藏在开屏下面等于没出现。 */}
          {consentAgreed && shellReady && !onboarded ? (
            <Onboarding onDone={() => setOnboarded(true)} />
          ) : null}
          {/* 键盘快捷键面板：`?` 或「我的 → 键盘快捷键」打开（H5 桌面端） */}
          <HotkeyHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
          {/* 开屏动画：每次冷启动展示，点击可跳过 */}
          <Splash onGone={handleSplashGone} />
        </React.Fragment>
      )}
    </>
  );
}

export default App;