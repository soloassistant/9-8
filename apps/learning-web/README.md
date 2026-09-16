# 学习平台 Web MVP

这是多语种学习平台的独立 Web 展示入口，不加载主产品的 Taro 页面、TabBar 或 AI 助手。

## 本地运行

在仓库根目录执行：

    corepack yarn install
    corepack yarn workspace @learning/web dev

浏览器打开 Vite 输出的本地地址即可体验语言选择、课程学习、进度保存和打卡社区。

## 生产构建

    corepack yarn build:learning

构建产物位于仓库根目录的 dist-learning/，不会覆盖主产品的 dist/。

## Vercel 展示

使用根目录的 vercel.learning.json：

    vercel --local-config vercel.learning.json

首期数据使用独立命名空间的浏览器 localStorage。它与 Taro 小程序端的 storage 不互通，这是展示版的明确边界。
