/**
 * 学习平台对外路由：主产品只依赖这里，不直接拼接学习页面 URL。
 * 保留现有页面路径，后续迁移成独立项目时只需替换这一层。
 */
export const LEARNING_ROUTES = {
  home: '/pages/learn/index',
  detail: (courseId: string) => `/pages/learnDetail/index?courseId=${encodeURIComponent(courseId)}`,
  community: '/pages/learnCommunity/index'
} as const;

/** Taro app.config.ts 使用的学习平台页面入口。 */
export const LEARNING_PAGE_PATHS = [
  'pages/learn/index',
  'pages/learnDetail/index',
  'pages/learnCommunity/index'
] as const;
