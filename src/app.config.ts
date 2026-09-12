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
    'pages/briefing/index',
    'pages/inbox/index',
    'pages/library/index',
    'pages/calendar/index',
    'pages/mine/index',
    'pages/search/index',
    'pages/history/index',
    'pages/shopping/index',
    'pages/learn/index',
    'pages/learnDetail/index',
    'pages/learnCommunity/index'
  ],
  // 定位权限（weapp 生效，H5 忽略）：晨报天气城市自动定位
  permission: {
    'scope.userLocation': {
      desc: '用于获取你所在城市的天气和晨报，坐标不存储'
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
    color: '#999999',
    selectedColor: '#FF7A45',
    backgroundColor: '#FFFFFF',
    borderStyle: 'white',
    list: [
      {
        pagePath: 'pages/briefing/index',
        text: '晨报',
        iconPath: 'assets/tabbar/briefing.svg',
        selectedIconPath: 'assets/tabbar/briefing-selected.svg'
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
        iconPath: 'assets/tabbar/calendar.svg',
        selectedIconPath: 'assets/tabbar/calendar-selected.svg'
      },
      {
        pagePath: 'pages/mine/index',
        text: '我的',
        iconPath: 'assets/tabbar/mine.svg',
        selectedIconPath: 'assets/tabbar/mine-selected.svg'
      }
    ]
  }
})
