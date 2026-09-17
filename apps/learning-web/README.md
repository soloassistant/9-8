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

产物根目录应包含：

| 文件 | 作用 |
| --- | --- |
| `index.html` | SPA 入口，含 `noindex` 元信息 |
| `robots.txt` | 拒绝搜索引擎收录（测试站点） |
| `_headers` | Cloudflare Pages 响应头：安全头、`X-Robots-Tag`、缓存策略 |
| `logo.png` / `share-cover.png` | 站点图标与社交分享封面 |

> **重要**：`robots.txt` 必须是真实静态文件。若缺失，SPA 的 catch-all 回退会让 `/robots.txt`
> 返回 `index.html`（HTTP 200 的 HTML），爬虫会继续抓取。`_headers` 同理。

## 路由模式

使用 **HashRouter**，URL 形如 `/#/course/en-a1-1`。这样在纯静态托管下任意深链接刷新都不会 404，
不依赖服务端 rewrite。代价是 URL 带 `#`。

若改为 history 模式（BrowserRouter），必须同时：

1. 在托管侧配置 SPA 回退（Cloudflare Pages 用 `_redirects`，Vercel 用 `rewrites`）；
2. 若部署在子路径（如 `example.com/learning/`），设置 `base` 并给 Router 传 `basename`。

## 部署

### Cloudflare Pages（当前线上方式）

将 `dist-learning/` 作为产物目录上传即可，`_headers` 与 `robots.txt` 会随之生效。

构建也可以交给 Cloudflare：

    build command:  corepack yarn workspace @learning/web build
    output dir:     dist-learning

### Vercel

使用根目录的 `vercel.learning.json`：

    vercel --local-config vercel.learning.json

## 数据边界

首期数据使用独立命名空间的浏览器 localStorage（`learning-web:v1:*`）。它与 Taro 小程序端的
storage 不互通，这是展示版的明确边界，不是部署故障。

## 索引状态

本应用是**测试站点，明确拒绝搜索引擎收录**，通过三重手段保证：

- `public/robots.txt`：`Disallow: /`，并显式列出主要中文搜索引擎 UA；
- `index.html` 的 `<meta name="robots" content="noindex, nofollow, ...">`；
- `public/_headers` 的 `X-Robots-Tag: noindex, nofollow, noarchive`（覆盖非 HTML 资源）。

若未来要对外正式发布并允许收录，需要同时移除这三处，并补充针对性的 SEO 元信息。
