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

### 3.1 ★ H5 构建"看似卡死"时，先杀干净进程树再重试（2026-10-09 实测）

现象：`taro build --type h5` 跑到 `building (10%) 675/694 dependencies` 后日志冻结，
进程却持续满 CPU（约 1 核）+ RSS 涨到 1.1 GiB，`dist/` 十几分钟不出文件。

同一台机器、同一份源码连续 5 次实测：

| # | 启动方式 | 结果 |
|---|---|---|
| 1 | `npx taro build --type h5` | 卡住 ≥14 分钟，手动终止 |
| 2 | `npx taro build --type h5` | 卡在同一处 ≥10 分钟，`taskkill /T /F` 终止 |
| 3 | `node node_modules/@tarojs/cli/bin/taro build --type h5` | **成功，编译 44.5s** |
| 4 | `npm run build:h5` | **成功，编译 60.9s** |
| 5 | `npx taro build --type h5`（输出到 `TARO_OUTPUT_DIR`） | **成功，编译 63.2s** |

- **不要据此断定「npx 有问题」**：第 5 次同样是 `npx` 却成功了 → **卡死是间歇性的**。
- 前两次卡死时机器上都还残留着上一次构建的 node 子进程；用**杀进程树**的
  `taskkill //PID <pid> //T //F` 清干净后，后续 3 次全部正常。
- 判「真卡死」的判据是**日志文件 mtime 冻结**（不是「屏幕上没滚动」）+ `dist/` 长时间不出文件；
  进度条不动也可能只是 webpack 进入了不打进度条的阶段（seal / minify）。

**产物指纹（判断「本地是否等于线上」用）**：`main` 上 H5 的稳定产物是
`js/app.a8cbdfbb.js`（1,864,973 B，sha256 `a10e8634…`）、
`css/app.a8cbdfbbff5e90af8b73.css`（154,005 B，sha256 `ef445990…`）、
`index.html`（1,191 B，sha256 `7aee7486…`）。2026-10-09 重建后与线上 gh-pages 三个文件
**逐字节相同** → gh-pages 上就是 `main` 源码的产物，且产物目录改造未改变 H5 输出。

> ★★ **本项目的"网页版"有两个入口，它们会各自漂移 —— 判断"线上是哪一版"必须两个都查**（2026-10-09 实测）：
>
> | 入口 | 发布源 | 是否随 `main` 自动更新 |
> |---|---|---|
> | `https://soloassistant.github.io/9-8/`（gh-pages 分支） | `origin/gh-pages` | ❌ **不会** —— `.github/workflows/refresh-data.yml` **只刷新 `api/hotspot.json`，不构建前端**；bundle 要人工推 |
> | `https://48f86dcd48e3462dbe897b5fce534551.app.workbuddy.host/` | 本地 `D:\Agent\dist` | ❌ 不会 —— 要靠平台侧重新发布 |
>
> 教训：改了 `src/` 只把代码提交/推送，**两个线上入口都不会变**。当天实测两者差了整整一个
> 合规提交（`01f6296`）：WorkBuddy 那个仍指 `app.2fedd178.js`，包里 `panelNotice` 命中 **0** 次，
> 而 gh-pages 已是 `a8cbdfbb`（命中 2 次）。
>
> 查法（30 秒）：`curl <入口>/ | grep -o 'js/app\.[0-9a-f]*\.js'`，再把那份 JS 拉下来
> `grep -o <特征符号> | wc -l`。特征符号要选**完整词**（`panelNotice` / `ai.notice`），
> 别选短串——本环境吃过 `stance` 命中 320 次全是 `instance` 的假阳性。

> ⚠️ 比对产物时**先落到文件再比**，且别用 `sed 's#.*/##'` 去拼本地路径
> —— 它会把 `js/app.X.js` 削成 `app.X.js`，于是 `cmp` 比的是一个**不存在的文件**，
> 报出"线上与本地不一致"的假故障（2026-10-09 我正是这么误报了一次，sha256 一比才知道全等）。

> ⚠️ 本环境 `rm -rf dist` 可能被**批量删除守卫**拦下（文件数 > 50 时要求确认，报
> `SAFE_DELETE_BULK_CONFIRM_REQUIRED`，并且会**删到一半就停**，留下小程序版残留文件）。
> 清理产物目录要么分批删、要么确认删干净后再构建，否则残留文件会被一起发布出去。

### 3.2 兜底数据 `dist/api/hotspot.json` 会被构建清掉 —— 现已自愈（2026-10-09 补）

Taro 构建**先清空产物目录**，所以每次 `build:h5` 都会把 `dist/api/hotspot.json` 清掉。
它是前端兜底链的第 3 跳（`src/services/cloud.ts:41`：
`/api/hotspot` → `soloassistant.github.io/9-8/api/hotspot.json` → `./api/hotspot.json`），
此前只能靠人**手动备份/还原** —— 而实践证据是它真的丢过一次。

现在由 `.tools/copy-assets.js`（`build:h5` 的后置步骤）**在发现它缺失时**从 gh-pages 取一份当日数据补回。
best-effort 设计，失败只告警、不抛错、不阻塞构建：

| 场景 | 行为 | 实测 |
|---|---|---|
| 文件缺失 + 网络通 | 拉取并落盘 | `65702 B, 195 items, updatedAt=2026-10-09T08:23:59Z` |
| 文件缺失 + 网络断 | `console.warn` + 提示手动命令，**exit 0** | `HOTSPOT_LIVE_URL=https://127.0.0.1:9/nope.json` → 告警且**未**创建文件 |
| 文件已在位 | 只打印大小，**不打网络** | `已在位 65702 B` |

- 落盘前会 `JSON.parse` 并断言 `items` 是数组 —— 免得把错误页当数据写进去。
- 可用 `HOTSPOT_LIVE_URL` 覆盖来源（就是靠它做上面那条负路径验证的）。
- ⚠️ 第一跳 `/api/hotspot` 在两个线上域名上都实测 **404**（纯静态托管无后端），
  所以**实际生效的是第 2 跳**；第 3 跳是"gh-pages 也挂了"时的最后防线。
  因此这份文件缺失**不是**用户可见故障，但缺了就应该知道。

### 3.3 ★★ Taro 两种"单位陷阱" + 一种 flex 陷阱，构建/单测都不报错，只有真浏览器量几何才暴露（2026-10-09 实测）

起因：用户报「晨报页底部输入区有问题」，查出来是**三处独立缺陷**，全都在构建日志、`typecheck`、
既有单测里**一路绿灯**。详细根因、读数、截图见 `docs/晨报页底部输入区-三处缺陷-根因与修复-2026-10-09.md`。

**陷阱一：Taro H5 里小写 `px` 就是 `rpx`（都是设计 px），不是 CSS px。**

| 源码 | 构建产物 | 375 视口实际 |
|---|---|---|
| `66px` | `1.76rem` | **33px** |
| `66PX` | `66PX`（原样保留） | 66px ✅ |

⇒ 要写"真 px"必须大写 `PX` 逃过 pxtransform（`app.scss` 的 `500PX` 是同一手法）。
指纹：一个本该固定的尺寸却随视口缩放（本次 `bottom` 三档 33 / 34.32 / 44px 全都不是 66）。
后果实例：`.h5Fix` 想避让 50px 的 TabBar，实际只避让 33px → 输入栏底部 17px 被压住。

**陷阱二：内联 `style` 里写 `rpx` 是无效 CSS —— 整条声明被丢弃，不是"留个错值"。**

浏览器不认 `rpx`，`calc(50px + env(...) + 340rpx)` 整条非法 → `bottom` 退回 **`auto`** →
元素落到**静态位置**（实测 AI 悬浮球因此渲染到屏幕顶端，提示气泡盖住页头问候语）。
内联 style 要用 `rem`：本项目 **1 设计 px = 1/37.5 rem**（推导自 `app.scss` 的
`html{font-size:calc(min(100vw,500PX)/20)}`，即 750 设计宽 = 20rem；构建产物 `24rpx→0.64rem`、
`66px→1.76rem` 两处都精确吻合这个比值）。
- ⚠️ **不要改用 `Taro.pxTransform`**：它按 **1/20 rem** 换算（面向"设计 px ≠ rpx"的项目），在本项目会放大一倍；
  且它假设根字号 = `100vw/20`，而本项目根字号**封顶 500px**，>500px 视口会一起错。
- 小程序端（WXSS）`rpx` 原生合法，所以这类 bug **只在 H5 坏**，属于"编译期不报、真机才发现"。
- 排查：`grep -n "rpx'\|\${.*}rpx" src/**/*.tsx`（改完上述两处后全仓应为 0 命中）。

**陷阱三：flex 行里给子项写 `width:100%` 当"占位"，会把兄弟项挤成 0。**

`width:100%` 让该子项以**整行宽**作为 flex basis；若同行其他项都是 `flex:0 0 auto` 不可压缩，
压力全落在 `flex:1` 的兄弟上。本次实例：VoiceButton 的 `.wrapper{width:100%}` 占 173px，
把输入框压到 32px，而它自身 padding 左右各 16px ⇒ 内容盒 0 ⇒ 里面的 `<input>` **宽度 0**，
placeholder 一个字都不显示。修法是 `.wrapper.compact{width:auto;flex:0 0 auto}`。
> 同类"看起来没事其实内容盒为 0"的情况，光看宽度不够 —— 要同时读 `getBoundingClientRect().width`
> 与该元素的 `paddingLeft/Right`，二者相等就是塌了。

**量几何的脚手架**（都在 `.tmp-verify/inputui/`，不进 `dist/`、不进版本控制）：
```bash
bash .tmp-verify/inputui/run.sh                                    # ① 线上多视口量测（注入 SDK 桩 + 点掉开屏封面）
PROBE=.tmp-verify/inputui/probe-intervention.mjs bash .tmp-verify/inputui/run.sh   # ② 干预验证
bash .tmp-verify/inputui/run-local.sh                              # ③ 本地构建产物复测
```
**先做②再做①**：直接改源码再测，分不清"我修对了"和"问题本来会自己好"；先在浏览器里注入候选修法、
拿到明确的好/坏值变化，才把假设钉成根因。（另：`.tools/cdp-probe.mjs` 是通用单视口版，本目录是它的多视口特化版。）

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
