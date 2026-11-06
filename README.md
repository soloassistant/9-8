# 私人晨报助理 · 晨报工程

> 本目录即「私人晨报助理」的**完整工程根**（含 git 仓库）。
> 2026-10-21 由 `D:/Agent` 根目录整体迁入此处（详见 `归档/迁移记录-2026-10-21.md`）。
> 原 `D:/Agent` 根下剩余的 `ai-course-teacher/`（灵犀课堂）、`star-empire-qa-2026-10-14/` 等其他项目与本工程无关。

## 这是什么

每天给用户一份「私人晨报」的跨端应用：自适应开场 + 今日日程/待办 + 今日情报
（天气 + 按偏好排序的 RSS + LLM 提炼）+ 语音播报；另有收件箱、资讯库/收藏、
购物清单与比价、习惯守护、学习模块等。

- **前端**：Taro 4 + React 18 + TypeScript（H5 为主，微信小程序为次），产物在 `dist/`
- **后端**：微信云开发，27 个云函数（`cloudfunctions/`，Node.js）
- **同步**：44 个 SYNC_KEYS → 云数据库 `user_kv` 表（RLS 按 owner 隔离）
- **页面**：22 个（`src/pages/`）

## 目录导览

| 路径 | 内容 |
|---|---|
| `src/` | 前端源码（pages / components / store / utils / services / data / config 消费方） |
| `cloudfunctions/` | 27 个云函数（getBriefing 定时推送 / webSearch 情报 / chat / login / extract / 支付与退款 / auth-alipay / auth-douyin …） |
| `docs/` | 全部文档：PRD、发布记录、合规清单、调研报告、问题总表、RSS 尽调 |
| `.tools/` | 验证工具链：mutation-verify 变异验证、ledger-export / sync-conflict / share-ai-label 等 harness、static-server、visual-pass 巡检 |
| `config/ types/ assets/ vendor/` | Taro 配置、类型定义、静态资源、vendored 子应用（灵犀课堂/省心买接入） |
| `dist/ dist-weapp/ dist-alipay/ dist-tt/` | 构建产物（H5 / 微信 / 支付宝 / 抖音）。**多端产物不随源码自动更新**：见下方「多端产物重建」 |
| `codefix/` | codefix 静态检查工具源码 |
| `归档/` | 参考资料（资料库链接）、视觉巡检截图、2026-09 早期交付物、迁移记录 |
| `AGENTS.md` | **工程铁律**（验证方法论、构建两步、storage 格式、禁止事项——动手前必读） |
| `MEMORY.md` | 项目记忆（**不进版本库**，已 gitignore） |
| `项目源码整合.md` | 2026-09-27 生成的全仓源码索引快照 |

## 常用命令

```bash
# H5 构建（两步，漏第二步会静默半残，原因见 AGENTS.md）
node node_modules/@tarojs/cli/bin/taro build --type h5 && node .tools/copy-assets.js dist

# 类型检查
node node_modules/typescript/bin/tsc --noEmit

# 变异验证流水线（10 cases，含基线/恢复态复跑/sha256 校验）
node .tools/mutation-verify.mjs .tools/mutations-share.mjs .tools/mutations-sync.mjs .tools/mutations-ledger.mjs
```

## 多端产物重建（`dist-weapp` / `dist-alipay` / `dist-tt`）

这三份产物**不随源码自动更新**，也不由 H5 的 `build:h5` 一并生成。目前它们停留在
2026-10-21（早于当前源码），**与最新源码不一致，必须重新构建后才能用于发布/预览**：

```bash
npm run build:weapp    # → dist-weapp/  （微信小程序）
npm run build:alipay   # → dist-alipay/ （支付宝小程序）
npm run build:tt       # → dist-tt/     （抖音小程序）
```

- 构建时间以产物目录 mtime 为准（`Get-ChildItem dist-weapp | Select LastWriteTime`），
  对应源码版本以当时的 `git rev-parse HEAD` 为准 —— 两者没有自动写入产物的凭据，
  **重建后请在发布记录里同时记下这两个值**，否则无法判断产物是哪一版源码。
- `dist/` 是 H5 产物（含 `index.html`），发布前按 AGENTS.md §4 用 `robocopy /MIR` 复制到
  平台发布目录；`dist-preview/` 是 2026-09 的旧预览产物，不参与发布。

部署状态、最近变更、同步方式等历史信息见 `docs/发布记录-*.md` 与 git log。

## 铁律速查（详见 AGENTS.md）

1. 只跑「修复态 PASS」不算数——必须反向变异确认断言有判别力
2. 断言失败分支的返回值必须是布尔，不能是 truthy 字符串
3. 生产构建剔除 `console.warn`，留痕一律用 `console.error`
4. Taro storage 格式 `{data: <值>}`，取不到返回空串 `''` 而非 undefined
5. 样式尺寸一律 rpx（pxtransform baseFontSize 37.5）
