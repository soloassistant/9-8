import Taro from '@tarojs/taro';

/**
 * 当前前台页是否是指定页面。
 *
 * 为什么需要：Taro 的 tab 页切走只触发 didHide、**不卸载**。所以「页面自己往 body 上挂
 * 版式类」的写法（晨报的 .briefing-desktop、热点详情的 .has-detail-rail）如果在
 * matchMedia 变化、useDidShow 补挂这类时机里无条件执行，就会在**别的页面**上生效：
 * 那个页面会被按晨报/热点的版式撑开，而左栏导航仍是固定宽 —— 实测 1440 下
 * 面板变成 1280@80，240 宽的左栏直接压住内容 160px（2026-10-29 桌面逐页扫描）。
 *
 * 取不到路由信息时按「是」处理：宁可多加一次类让本页版式正常，
 * 也不要首次渲染就少挂一次、让本页版式塌掉。
 */
export function isPageForeground(route: string): boolean {
  try {
    const pages = Taro.getCurrentPages();
    const cur = pages[pages.length - 1];
    if (!cur || !cur.route) return true;
    return cur.route.replace(/^\//, '') === route.replace(/^\//, '');
  } catch {
    return true;
  }
}
