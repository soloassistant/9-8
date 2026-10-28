export default defineAppConfig({
  plugins: {
    // 微信同声传译（语音转写 ASR，F05）：需在小程序后台「设置-第三方设置-插件管理」
    // 添加该插件后生效；version 以后台插件管理页显示的最新稳定版为准。
    // H5 构建忽略 plugins 字段，仅 weapp 生效。
    WechatSI: {
      version: '0.3.5',
      provider: 'wx069ba97219f66d99'
    }
  },
  pages: [
    // 登录页放在首位 = 入口页：根路径先到登录页，已登录则立即跳转，
    // 避免"先渲染受保护内容再重定向"的闪现。
    'pages/login/index',
    'pages/briefing/index',
    'pages/inbox/index',
    'pages/library/index',
    'pages/calendar/index',
    'pages/mine/index',
    // 2026-10-26 IA 瘦身：订阅/账单/额度与偏好设置从「我的」页拆成二级页。
    // 都不是 tabBar（navigateTo 进入，系统返回手势可回「我的」）。
    'pages/membership/index',
    'pages/prefs/index',
    // 2026-10-27：全站唯一的 AI 对话入口（原晨报页底部输入条 + 全局悬浮球已移除）
    'pages/assistant/index',
    'pages/search/index',
    // pages/history 已于 2026-10-25 并入热点页「最近浏览」区（IA 瘦身：13 → 12 页）
    'pages/shopping/index',
    'pages/ledger/index',
    // 省心买 · 小程序原生页（阶段 B 第一期）：小程序端不再复制外链，改为跳本页
    'pages/sxm/index',
    'pages/learn/index',
    'pages/learnDetail/index',
    'pages/learnCommunity/index',
    // 2026-10-28：专业交易终端（黄金/外汇，模拟行情）。仅 H5 渲染终端 UI，
    // weapp 渲染「仅网页版可用」占位；非 tabBar 页（navigateTo 进入）。
    'pages/trade/index'
  ],
  // 定位权限（weapp 生效，H5 忽略）：晨报天气城市自动定位
  // ⚠️ 文案必须与 location.ts 的真实行为一致（2026-10-12 合规修正）：
  // 原文写「坐标不存储」——不存储属实，但**漏了会把坐标发给第三方**做逆地理编码，
  // 属于告知不完整。微信授权弹层的文案是用户决定是否授权的唯一依据，不能只说对自己有利的部分。
  // 2026-10-13 再补：该第三方是 **api.bigdatacloud.net（境外服务）**，此环节可能构成个人信息出境，
  // 只写「第三方」仍不完整，故补「境外」二字。
  permission: {
    'scope.userLocation': {
      desc: '用于获取你所在城市的天气和晨报。坐标会发送至第三方境外地图服务解析出城市名，不做存储'
    }
  },
  requiredPrivateInfos: ['getLocation'],
  window: {
    backgroundTextStyle: 'light',
    navigationBarBackgroundColor: '#FFF3EC',
    navigationBarTitleText: '私人晨报助理',
    navigationBarTextStyle: 'black'
  },
  tabBar: {
    // 2026-10-24 无障碍修正：原 #999999（2.85:1）/ #FF7A45（2.59:1）双双不达 WCAG AA 4.5:1。
    // 未选中改 $color-text-tertiary 同值 #657080（5.02:1）；选中改 sunrise 的 strong 变体
    // #C7371A（白底 5.26:1）—— tabBar 选中态承载「当前在哪个页」的导航信息，必须可读。
    color: '#657080',
    selectedColor: '#C7371A',
    backgroundColor: '#FFFFFF',
    borderStyle: 'white',
    list: [
      {
        pagePath: 'pages/briefing/index',
        text: '晨报',
        // 微信 tabBar 仅支持 png（svg 真机不显示），统一用 tabbar-png
        iconPath: 'assets/tabbar-png/briefing.png',
        selectedIconPath: 'assets/tabbar-png/briefing-selected.png'
      },
      {
        pagePath: 'pages/inbox/index',
        text: '收件箱',
        iconPath: 'assets/tabbar-png/inbox.png',
        selectedIconPath: 'assets/tabbar-png/inbox-selected.png'
      },
      {
        pagePath: 'pages/library/index',
        text: '热点',
        iconPath: 'assets/tabbar-png/library.png',
        selectedIconPath: 'assets/tabbar-png/library-selected.png'
      },
      {
        pagePath: 'pages/calendar/index',
        text: '日历',
        iconPath: 'assets/tabbar-png/calendar.png',
        selectedIconPath: 'assets/tabbar-png/calendar-selected.png'
      },
      {
        pagePath: 'pages/mine/index',
        text: '我的',
        iconPath: 'assets/tabbar-png/mine.png',
        selectedIconPath: 'assets/tabbar-png/mine-selected.png'
      }
    ]
  }
})
