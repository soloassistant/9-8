# AGENTS.md — 私人晨报助理（Personal Morning Brief Assistant）

> 本文件给在本仓库工作的 AI 代理/开发者。只写**可验证的事实与硬约束**，不写愿景。
> 最后更新：2026-10-09

## 1. 这是什么

一个每天给用户一份「私人晨报」的跨端应用：自适应开场 + 今日日程/待办 + 今日情报
（天气 + 按偏好排序的 RSS + LLM 提炼）+ 语音播报；另有收件箱、资讯库/收藏、
购物清单与比价、习惯守护、学习模块。

- **项目根**：本仓库根目录（Windows 路径形如 `D:\Agent`）
- **H5 线上**：https://soloassistant.github.io/9-8/
- **代码仓库**：https://github.com/soloassistant/9-8 （**public**）

## 2. 技术栈

| 层 | 选型 |
|---|---|
| 框架 | Taro **4.1.9** + React 18 + TypeScript |
| 构建 | webpack 5.78.0 / esbuild 0.21.5 |
| 目标端 | 微信小程序（`weapp`）+ H5（`h5`） |
| 后端 | **微信云开发**（云函数 Node.js，见 `cloudfunctions/`） |
| 云 SDK（H5） | `@tencent-ai/workbuddy-cloud-sdk`（CDN 引入） |

## 3. 构建与产物目录（★ 有一条曾踩过的坑）

产物**按平台分目录**：H5 → `dist/`，其它端 → `dist-<platform>`（小程序 = `dist-weapp/`）。
该约定写在 `config/index.ts` 的 `outputRoot` 里（`TARO_OUTPUT_DIR` 仍可覆盖）。

```bash
npm run build:h5      # → dist/        （H5）
npm run build:weapp   # → dist-weapp/  （微信小程序）
npx tsc --noEmit      # 类型检查
```

> ⚠️ **发布 H5 前必须先确认 `dist/` 里是 H5 产物**（存在 `index.html`）。
> 历史上 `build:weapp` 未设 `TARO_OUTPUT_DIR`，跑一次小程序构建就会把 `dist/` 覆盖成
> **小程序产物**；若此时把 `dist/` 发到 gh-pages，等于**把小程序产物当网页发布上线**。
> 已在 `config/index.ts` 收口，但发布前仍请看一眼。
>
> 小程序端不需要 `copy-assets.js`（Taro 的 `config.copy` 已拷 tabbar PNG 等）；
> 只有 **H5** 需要 `node .tools/copy-assets.js dist`。

## 4. 上线通道

| 端 | 通道 | 说明 |
|---|---|---|
| H5 | **GitHub Pages** | 源分支 `gh-pages`；把 `dist/` 内容提交到该分支。⚠️ **必须保留 `api/hotspot.json`** —— 它由 `.github/workflows/refresh-data.yml` 定时刷新 |
| 微信小程序 | WorkBuddy 小程序应用面板 | 先在面板「分享」里发布；不是 gh-pages |

> `deploy.ps1` / `.deploy-config.json`（SFTP）**不是**当前上线通道，别照它操作。

## 5. 云函数

`cloudfunctions/` 下 12 个函数：`chat` `confirmItem` `createOrder` `deleteAccount`
`extract` `getBriefing` `getLibrary` `getUsage` `login` `shopping` `updateSettings` `webSearch`。

- 部署命令：`npm run deploy:cloud`（读 `.env.local`）
- ⚠️ **当前无法部署**：缺 `WX_APPID` / `WX_PRIVATE_KEY_PATH` / `WX_CLOUD_ENV`
  （`.env.local` 里没有；`project.config.json` 的 appid 还是 `touristappid`）
  → **云函数改动目前只能在本地验证，线上跑的是旧版本**
- 云函数里调用 `cloud.openapi.*` 需要在**同名目录**放 `config.json` 声明权限，
  例如 `security.msgSecCheck`（参考 `cloudfunctions/extract/config.json`）

## 6. 测试与验证

```bash
node .tools/test-trust-filter.js          # 内容信任过滤：常拦 + 必放（precision）双清单
node .tools/test-trust-filter-incident.js # 真实投毒语料
node .tools/test-trust-cache-guard.js     # 空结果不入缓存
node .tools/test-chat-seccheck.js         # chat 的 msgSecCheck（输入/输出/fail-open）
node .tools/test-trust-filter-corpus.js <语料.json>   # 对真实语料跑，防过度修复
node .tools/verify-intel-degraded-semantics.cjs
node .tools/cdp-probe.mjs <url> <w> <h> [--init-script …] [--block-url …] [--dismiss-splash] [--expr …] [--png …]
```

**给过滤器/守卫类代码加验收清单时，必须同时给「必拦」和「必放」两份** ——
只测「攻击能否拦住」(recall) 而从不测「正常内容会不会被误杀」(precision)，
会让每轮修复都在悄悄引入误杀且无人发现（本项目此模块曾因此返工 3 轮）。

## 7. 合规硬约束（微信小程序发布前必读）

- 本产品含**文本深度合成**（AI 提炼 + AI 对话）→ 微信要求【**深度合成-AI 问答**】服务类目
- 该类目**「适用于非个人主体」**：**个人主体不开放**，会因类目/内容不符被驳回
  → 主体需为**企业或个体工商户**
- 官方硬规则：**先类目审核通过，再提交代码包**，否则 100% 驳回
- 代码侧强制项（人工必查）：① AI 对话页**全程固定展示**醒目生成标识（禁止角落小字/浅色隐藏）；
  ② 用户输入与 AI 输出**均过 `msgSecCheck`**；③ 大模型 Key 不得出现在前端；④ 隐私协议含 AI 条款
- 材料清单与办理时序见 `docs/深度合成类目-材料清单与办理时序-2026-10-09.md`

## 8. 代码约定

- 提交信息用中文；涉及判据变更要写清「为什么改、改前是什么行为」
- 修问题优先在**数据入口一处收口**，而不是每个使用点各自防御；每处修复留一句原因注释
- 不吞错误：`2>/dev/null` 这类会掩盖失败，涉及成败判断的命令不要吞
- 不静默失败：保存失败/降级/额度耗尽必须让用户看见
- `.tools/` 已被 gitignore 但**已在版本控制中**：新增文件需 `git add -f`，改已有文件用 `git add -u`

## 9. 待确认（我无法代为决定）

1. 微信小程序 AppID 与云环境 ID（`WX_APPID` / `WX_CLOUD_ENV`）—— 没有它无法部署云函数、无法真机预览
2. 主体类型是否已按「个体工商户」办理（决定类目与支付能否走通）
3. 第三方 LLM 供应商是否愿意提供算法备案截图 + 盖章合作协议
