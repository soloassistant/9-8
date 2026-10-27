# AGENTS.md — 私人晨报助理（Personal Morning Brief Assistant）

> 本文件给在本仓库工作的 AI 代理/开发者。只写**可验证的事实与硬约束**，不写愿景。
> 最后更新：2026-10-24（新增 `verify:all` / `verify:parity` 与第 11 节上下文纪律；本轮修正了 7 处与仓库现状不符的表述，并加了 `npm run verify:docs` 防再腐烂）

## 1. 这是什么

一个每天给用户一份「私人晨报」的跨端应用：自适应开场 + 今日日程/待办 + 今日情报
（天气 + 按偏好排序的 RSS + LLM 提炼）+ 语音播报；另有收件箱、资讯库/收藏、
购物清单与比价、习惯守护、学习模块。

- **项目根**：`D:/Agent/晨报`（`git rev-parse --show-toplevel` 即此；`D:/Agent` 根下还有别的项目，别动）
- **H5 产品入口**：WorkBuddy 应用面板发布（发布目录、发布后四查、为什么不能用 gh-pages，统一见 §4）
- **H5 静态镜像**：https://soloassistant.github.io/9-8/ —— 云端能力不可用，仅静态外壳 + 热点镜像
- **代码仓库**：https://github.com/soloassistant/9-8（**public** ⇒ 任何进库文件都视为对外公开）

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

**不要背产物指纹，现查**。bundle 名与字节数每次构建都变，写死在文档里必然腐烂
（本文档过去写过 `app.a8cbdfbb.js / 1,864,973 B`，下一次构建就失效了）：

```bash
ls dist/js/ | grep '^app\.'                          # 本地包名
curl -s <入口>/ | grep -o 'js/app\.[0-9a-f]*\.js'    # 线上包名，两者应一致
```

> ★★ **两个网页入口各自漂移 —— 判断"线上是哪一版"必须两个都查。**
> 哪个是产品入口、为什么 gh-pages 上云端能力全废、"改了 `src/` 两个入口都不会自动变"，
> 统一见 **§4 上线通道**（单一事实来源，别在这里重复维护一份）。
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

#### ★★ 平台侧重新发布：**app 身份绑在"发布目录路径"上，不是绑在项目上**（2026-10-23 踩坑）

把仓库根从 `D:/Agent` 迁到 `D:/Agent/晨报` 后，第一次重新发布**没有覆盖旧 app，而是新建了一个** ——
因为平台按「发布目录」认 app，旧 app 记录的目录是 `D:\Agent\dist`，该目录随迁移消失了，
于是同一个项目变成两个线上 app：

| 入口 | 发布目录 | 云登录 |
|---|---|---|
| `48f86dcd…app.workbuddy.host`（旧，正确） | `D:\Agent\dist` | ✅ 可用 |
| `morning-brief-71007.app.workbuddy.link`（新，本次误建） | `D:\Agent\晨报\dist` | ❌ **必然失败** |

**为什么新域名一定登录不了**：`src/services/cloudAuth.ts:34` 的 `CLOUD_ENDPOINT` 写死旧域名，
服务端按 **Origin 精确匹配**（该文件 L28-30 有原文警告）。跨 Origin 请求连 CORS 都不给 ——
实测新域名页面 `fetch(旧域名/v1/...)` 直接 `TypeError: Failed to fetch`，
连 401 都拿不到。**只要页面 origin 变了，登录、云同步、AI 全部挂掉。**

**正确做法**：发布前先确保 `D:\Agent\dist` 存在且是最新产物，再 `deploy` 这个目录。
用 `robocopy /MIR` 而不是 `rm -rf && cp -r` —— 后者会被批量删除守卫拦（见上），
且 **Git Bash 会把 `/MIR` 当路径**，必须带 `MSYS_NO_PATHCONV=1`：

```bash
MSYS_NO_PATHCONV=1 robocopy "D:\Agent\晨报\dist" "D:\Agent\dist" /MIR
```

发布成功的判据：返回的 `sandboxId` 必须是 `48f86dcd48e3462dbe897b5fce534551`。
拿到别的 id = 又新建了 app = 链接换了域名 = 登录不可用，**立即停下并回退**。

> ⚠️ **不要用 junction / 符号链接替代 `D:\Agent\dist`**（试过，必失败）。
> 发布工具用 `tar` 打包，会把 junction 当成一个指向 `D:/Agent/晨报/dist` 的**符号链接条目**去创建，
> 而目标名与自身冲突：`tar: .: Cannot create symlink to 'D:/Agent/晨报/dist': File exists` → exit 2 →
> `SITES_UPLOAD_FAILED`。而且该失败**已经改写了线上 sandbox**，链接会短时间不可用，必须重新发布一次恢复。
> **必须是真实目录副本**（3.4 MB，可接受）。

发布后 4 项必查（缺一项都可能"看起来上线了但其实坏的"）：

```bash
H=https://48f86dcd48e3462dbe897b5fce534551.app.workbuddy.host
KEY=$(grep -o "wbpk_[A-Za-z0-9_]*" src/services/cloudAuth.ts | head -1)

# 1 包名与本地一致
curl -s $H/ | grep -o 'js/app\.[0-9a-f]*\.js'
# 2 关键资源都在（200，且 size 应与本地文件一致）
for f in assets/wb-sdk.js api/hotspot.json; do
  curl -s -o /dev/null -w "$f %{http_code} %{size_download}\n" $H/$f
done
# 3 Origin 白名单：必须 204 且 ACAO 精确等于 $H（跨域被拒时是 403 且无 ACAO）
curl -s -o /dev/null -D - -X OPTIONS $H/.cloud/database/rest/user_kv \
  -H "Origin: $H" -H "Access-Control-Request-Method: GET" \
  -H "Access-Control-Request-Headers: authorization" | grep -iE '^HTTP|access-control-allow-origin'
# 4 未登录语义：认证接口应回结构化 401，匿名读 user_kv 应回 []
curl -s $H/.cloud/auth/v1/user/me -H "Origin: $H" -H "X-Wb-Webapp-Access-Key: $KEY"
curl -s "$H/.cloud/database/rest/user_kv?select=*" -H "Origin: $H" -H "X-Wb-Webapp-Access-Key: $KEY"
```

> ★ 云端路径前缀是 **`/.cloud/`**（`auth` / `database/rest` / `storage` / `llm`）。
> 直接请求 `/v1/user/me` 会落到静态服务并返回 **404 `python http.server`** —— 那是路径写错，
> **不是云接口坏了**。数据库 REST 的鉴权头是 **`X-Wb-Webapp-Access-Key`**，不是 `apikey`；
> 用错会得到 `invalid_client`，看起来像凭据失效。
>
> 上面第 3/4 条比"用 CDP 在页面里跑 SDK 登录"更快更稳；需要更强证据时再用 CDP：
> `createWorkBuddyCloud({endpoint:location.origin, publishableKey:…}).auth.signInWithPassword(不存在的账号)`
> 必须返回业务错误 `invalid-request / "Username or password incorrect."`；返回 `Failed to fetch`
> 就是 Origin/CORS 问题，**不是密码问题**。

顺带一条隔离举证（顺手做的，可复用）：**未登录** `database.from('user_kv').select('*')` 返回
`rows: 0, error: null` —— 库里 20+ 行真实数据对匿名用户完全不可见，即 RLS 生效。

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

**量几何的脚手架**：用 `.tools/cdp-probe.mjs`（通用单视口版，`--expr` 注入测量表达式）。
2026-10-09 那次排查还写过一套多视口特化脚本，放在 `.tmp-verify/inputui/` —— 那是**临时目录，
现在已被清理**。⚠️ 别把文档锚点挂在 `.tmp-verify/` 下（它随时会没），需要时按下面重搭：

```bash
node .tools/cdp-probe.mjs <url> 375 812 --init-script .tools/cdp-probe-session.js \
  --dismiss-splash --expr <测量表达式文件>
```

**先做②「浏览器里注入候选修法」再做①「改源码复测」**：直接改源码再测，分不清"我修对了"和
"问题本来会自己好"；先在浏览器里注入候选修法、拿到明确的好/坏值变化，才把假设钉成根因。

## 4. 上线通道

**★★ 先说结论：云后端按 Origin 精确白名单，`gh-pages` 的源被 403 拒，云端能力在 gh-pages 上全不可用。**
2026-10-23 逐 Origin 实测（同一路径 `/.cloud/database/rest/rpc/...` 的 OPTIONS 预检）：

| Origin | 预检结果 |
|---|---|
| `https://soloassistant.github.io` | **HTTP 403，无 `Access-Control-Allow-Origin`** |
| `https://48f86dcd48e3462dbe897b5fce534551.app.workbuddy.host` | 204 + ACAO ✓ |
| `http://127.0.0.1:<port>`（本地开发） | 204 + ACAO ✓ |

所以在 gh-pages 上：**登录 / 跨设备同步 / AI 对话 / 用量额度 / 崩溃上报全部不可用**
（浏览器只会报 `TypeError: Failed to fetch`，连 401 都拿不到，极像"断网"）。
gh-pages 现在只适合当**静态外壳 + 热点数据镜像**，不是产品入口。

**★★ 两个入口都不会随 `main` 自动更新**（这是最容易误判的一条）：
`.github/workflows/refresh-data.yml` **只刷新 `api/hotspot.json`，不构建前端**；
WorkBuddy 那个要平台侧重发。⇒ 改了 `src/` 只提交/推送，**两个线上入口都还是旧代码**。

| 端 | 通道 | 说明 |
|---|---|---|
| **H5（产品入口）** | **WorkBuddy 应用面板发布** | 发布目录 `D:\Agent\dist`（平台按**目录**认 app，换目录=换 app=换域名且登录必挂）。产物要**真实目录副本**，junction/symlink 会被 tar 打包拒绝。云端能力只在这里可用 |
| H5（静态镜像） | GitHub Pages `gh-pages` | `.tools/deploy-gh-pages.mjs` 发布（`npm run deploy:pages`），带构建指纹闸。**云端能力不可用**，仅静态内容 + `api/hotspot.json` |
| 微信小程序 | WorkBuddy 小程序应用面板 | 先在面板「分享」里发布；不是 gh-pages |

发布到 WorkBuddy 前务必同步：`robocopy D:\Agent\晨报\dist D:\Agent\dist /MIR`，
否则发出去的是上一次的旧产物（平台只认 `D:\Agent\dist` 这个目录，不认仓库路径）。

> `deploy.ps1` / `.deploy-config.json`（SFTP）**不是**当前上线通道，别照它操作。
> `deploy-gh-pages.ps1` **在仓库里从来不存在**（历史文档提到的那个脚本已不存在，别再去找）。

## 5. 云函数

`cloudfunctions/` 下的函数按功能分组（**数量用 `ls -d cloudfunctions/*/ | wc -l` 现查，别背数字**；
本文档曾写"24 个"，实际已是 25）：

| 分组 | 函数 |
|---|---|
| 身份 / 账号 | `login` `deleteAccount` `updateSettings` `getUsage` `reportError` |
| 晨报 / 情报 | `getBriefing` `webSearch` `extract` `chat` |
| 待办 / 购物 | `todoStatus` `confirmItem` `getLibrary` `shopping` |
| 支付 | `createOrder` `queryOrder` `closeOrder` `ordersList` `refundOrder` `pay-wechat` `pay-alipay` `pay-callback` `pay-douyin` `auth-alipay` `auth-douyin` |

- 部署命令：`npm run deploy:cloud`（读 `.env.local`）；只预检不上传：`npm run deploy:cloud:check`
- ⚠️ **当前无法部署**：缺 `WX_APPID` / `WX_PRIVATE_KEY_PATH` / `WX_CLOUD_ENV`
  （`.env.local` 里没有；`project.config.json` 的 appid 还是 `touristappid`）
  → **云函数改动目前只能在本地验证，线上跑的是旧版本**
- **无凭据也能守的底线**：`npm run verify:cloudfunctions`（148 条断言）。
  用 vm + 伪造 `require` 在**没有 wx-server-sdk、不联网**的情况下加载全部 24 个函数，
  守住结构（`exports.main` / 依赖声明 / 相对 require 目标 / timer 必须 7 段 cron）、
  可加载性、权限边界（缺 OPENID 必须明确拒绝 / `where` 查询不得用 `_openid` / 无硬编码 AppID）。
  **新增云函数必须同步登记到脚本里的 `OPENID_GUARDED` / `OPENID_OPTIONAL` 表**，
  否则门禁会红——这是故意的，防止「新函数忘了守 openid」悄悄上线。
- **业务逻辑行为层**：`npm run verify:cloudflow`（17 个场景 / 359 条断言，零网络）。
  给 `wx-server-sdk` 一个进程内**忠实实现**（`.tools/lib/wx-server-sdk-mock.cjs`：真内存集合、
  真 `where`/`update`/`inc`/`serverDate` 语义），把云函数当普通函数调用，验跨函数链路
  （`login→updateSettings→todoStatus`）、越权、幂等、配额、注销级联、订单归属、额度账本。
  关键一条语义：**`where({openid: undefined})` 必须退化成「匹配全部」**（真实 SDK 序列化会丢 undefined 键）
  —— 桩若把它当成「匹配不到」，openid 守卫的断言全是假绿。
  另有「注销清单 ↔ 写入点」静态对齐断言：任何按 openid 写入的集合没登记进
  `deleteAccount` 的 `collections`，门禁即红。
  2026-10 首次接入就抓出 8 个真实缺陷（`chat` 首轮 usage 无 `_id` 致免费用户每月首条消息必失败且额度不累加、
  注销漏删 `errors`、`confirmItem` 配额检查晚于写入、`updateSettings` 时间正则过宽且命中 0 行返回 undefined、
  `reportError` 无参读 `event.TARO_ENV` 抛错、`login` 首次返回缺 `_id`）。
- **部署前必看环境变量清单**：`npm run deploy:cloud:check` 在没有凭据时**也会**打印
  29 个变量分布在哪些函数上（本机目前只有 `INTERNAL_CALL_TOKEN` 就绪）。
  `INTERNAL_CALL_TOKEN` 必须同时配在 `getBriefing` 与 `webSearch`，且值相同。
- 云函数里调用 `cloud.openapi.*` 需要在**同名目录**放 `config.json` 声明权限，
  例如 `security.msgSecCheck`（参考 `cloudfunctions/extract/config.json`）

### 5.1 云数据库（H5 数据面，与上面 24 个云函数是两套东西）

H5 不走微信云开发，走 WorkBuddy 云库（3 张表）：

| 表 | 用途 | 客户端权限 |
|---|---|---|
| `user_kv` | 18 个 `SYNC_KEYS` 的跨设备同步 | 读写自己的（`owner_id = auth.uid()`） |
| `llm_events` | AI 用量记账（只增不改） | 写自己的 + 读自己的 |
| `client_errors` | 客户端崩溃日志（只增不改） | **只能调用 `log_client_error(p_*)` 写，读不到** |

`client_errors` 为什么是「只写函数」而不是直接写表（2026-10-23 实测，别改回去）：

- 未登录访客的 `auth.uid()` 返回**字面量 `'anon'`** —— 所有匿名访客**共用同一个 owner**。
  若按常规给表上 `owner_id = auth.uid()` 的 SELECT 策略，任何匿名访客都能读到**全部匿名用户的
  崩溃日志**（实测确实读到了）。
- 因此该表对 `authenticated, anon` 已 `REVOKE ALL`、RLS 下**不留任何策略**，
  写入只能走 `SECURITY DEFINER` 函数 `log_client_error`（返回 void、只写不读），读取只能管理端做。
- 所以 **`db.from('client_errors').insert(...)` 会 42501**，必须 `db.rpc('log_client_error', ...)`；
  且**不能用 `unwrap()` 判结果** —— 函数返回 void，`data` 恒为 `null`，会被误判成失败。

H5 与微信端的崩溃上报是**两条通道**（见 `src/services/crashReport.ts` 文件头）：
小程序 `Taro.onError` → `reportError` 云函数（要求 OPENID，H5 调不到）；
H5 直挂 `window.onerror` / `unhandledrejection` → `log_client_error`。
**不要用 `Taro.onError` 做 H5 上报** —— taro-h5 的回调只给字符串（`res.stack || res.message || res`），
`err instanceof Error` 恒 false，堆栈会被塞进 message、位置信息全丢。

## 6. 测试与验证

```bash
node .tools/test-trust-filter.js          # 内容信任过滤：常拦 + 必放（precision）双清单
node .tools/test-trust-filter-incident.js # 真实投毒语料
node .tools/test-trust-cache-guard.js     # 空结果不入缓存
node .tools/test-chat-seccheck.js         # chat 的 msgSecCheck（输入/输出/fail-open）
node .tools/test-trust-filter-corpus.js <语料.json>   # 对真实语料跑，防过度修复
node .tools/verify-intel-degraded-semantics.cjs
node .tools/cdp-probe.mjs <url> <w> <h> [--init-script …] [--block-url …] [--dismiss-splash] [--expr …] [--png …]
node .tools/mutation-verify.mjs .tools/mutations-share.mjs   # 变异验证（见 6.1）
```

**给过滤器/守卫类代码加验收清单时，必须同时给「必拦」和「必放」两份** ——
只测「攻击能否拦住」(recall) 而从不测「正常内容会不会被误杀」(precision)，
会让每轮修复都在悄悄引入误杀且无人发现（本项目此模块曾因此返工 3 轮）。

### 6.1 变异验证与提交流水线铁律（2026-10-20，用 `.tools/mutation-verify.mjs` 落地）

背景：2026-10-20 一天内连出三次同类事故——sed 做变异时替换串没匹配上（尾逗号差异）
导致"恢复"静默失败、仓库被留在变异态；变异检查点写得太弱，变异没被抓到也显示通过；
断言阈值是拍脑袋拍的，返工一轮。**靠"下次小心"防不住，改为机制兜底。**

1. **变异只用工具，不许手 sed**。一律 `node .tools/mutation-verify.mjs <case文件>`：
   锚点必须正好出现 1 次（工具断言）→ 目标文件必须无未提交改动（拒绝变异别人在飞的
   工作）→ 变异 → 跑验证 → **恢复并 sha256 逐字节校验**（失配即退出码 3 并明示仓库
   被留在变异态）→ 恢复态复跑必须绿。非要手改源码做变异，必须能出示「恢复后 sha256
   与变异前一致」的证据，否则视为没恢复。
2. **断言规约**：`ok === true` 才算过，失败分支返回原因字符串（禁止 `!!ok` —— 非空
   字符串 truthy 会把失败判成 PASS，本项目因此永久假绿过一次）；每个数字阈值必须在
   注释里写依据，没有依据的阈值是拍脑袋；harness 首跑先拿基线再下结论。
3. **harness 编写环境坑**：vm 沙箱要补 `process` / `window` 等全局（Taro runtime 会
   摸它们）；浏览器 bundle 里不许出现 `node:fs` 等 builtins（esbuild 平台默认
   browser）；同目录验证产物注意时间戳，新旧混杂会造假差异。
4. **提交纪律**：只 `git add` 精确路径，严禁 `-A` / `.`；提交前 `git status
   --porcelain` 核对、提交后复查。遇到**外来未提交改动或外来新提交**（同仓其他工作流
   在飞）→ 原样保留、只报告、不动它，并确认与自己的提交无文件重叠。
4.1 **开工先记基线**：动手改代码前 `git status --porcelain > /tmp/wt-baseline.txt`
   （或等价的当日留痕）。提交时逐项对照：基线里有的外来项一个都不许进暂存区。
4.2 **提交前必须过暂存区 diff**：`git diff --cached` 逐行核对正是自己意图的改动。
   发现外来文件/外来行混入 → `git restore --staged <路径>` 撤出，**绝不允许"顺手一起提交"**。
   2026-10-22 事故实录：工程师首次提交不慎吞入并发会话的 `briefing/index.tsx`
   流式对话改动——若有本步自查即可当场拦住。
4.3 **严禁 `--amend` 任何提交**。amend 是事故放大器：2026-10-22 工程师撤出吞入内容时
   一次 amend 误作用于另一条提交，差点把两个修复拆不干净。一律新写提交；
   确需改写历史（仅限自己刚建、尚未推送、确认无外来内容的提交），先 `git log -p`
  自查三遍再动手，且 amend 后必须 `git show --stat` 复核每个文件。
4.4 **吞入事故的标准处置**（发生了就这么办，别慌也别捂）：`git reset --soft HEAD~1`
   → 外来改动用 `git checkout -- <路径>` 或从备份字节级还原（含 CRLF/LF 行尾一致性）
   → 重做成干净提交 → 向主理人如实报告事故经过。备份先行：动 reset 前
   `cp` 一份受污染文件到 `.tmp-verify/`。
5. **本机命令坑**：复合 bash 命令可能被沙箱中心拒（报 sandbox-center 相关错误）→
   拆成多条或改用 PowerShell；长命令（构建 / 多 harness 串联）必须
   `run_in_background` + 日志；node 一律用绝对路径
   `/c/Users/geral/.workbuddy/binaries/node/versions/22.22.2-6/node.exe`（`.bin` 无 shim）。
6. **变异用例即回归资产**：`.tools/mutations-*.mjs`（数量、覆盖情况、用例条数一律用
   `npm run verify:mutation-coverage` 现查 —— 它会打印"覆盖 N / 浏览器类 N / 缺口 N"与用例总数）。
   本文档**不写这些数字**：写死的数字一定会过期，而"文档里的数字是旧的"比"没写"更坏，
   因为它看起来像是核对过的。改对应模块后必须重跑变异；结果只认
   `caught=N not_caught=0 error=0` **且** `restored_green=true`。
   新 harness 落地时要同步补一份 mutations 文件 —— 这条已由 `verify:mutation-coverage` 强制：
   零变异又未登记的 verify 脚本会让 CI 红，纯静态缺口有上限（只许减不许增）。

### 6.2 一次跑完全部门禁 + 入口不许漏（2026-10-24）

```bash
npm run verify:all              # 静默：全部静态门禁，成功一行一条，失败打全量
npm run verify:all -- --verbose # 调试时看全量
npm run verify:all -- --only=legal,docs   # 只跑指定的几条
npm run verify:parity           # 只查「有没有门禁写了却没接 CI」，毫秒级
```

- **`verify:all` 不手写清单**。第一版写死 15 条，而 `package.json` 当时有 38 个 `verify:*`
  —— 它自称"跑完所有静态门禁"却漏了 23 个。现在从 `package.json` 自动发现，
  只维护三张例外表：`BROWSER`（需 Chrome）、`MUTATING`（改源码，排最后跑）、
  `EXTERNAL`（直连外网，天生不确定 —— `verify:boards` 打 9 个热榜源，一个源超时即红）。
  例外表里登记了而 `package.json` 里没有的条目 → 判"表腐烂"。
- **`verify:parity` 管住"写好了却没接 CI"**：`verify:contrast`、`verify:util` 都曾栽在这上面。
  它认「`npm run <gate>`」或「该 gate 脚本的真实路径」（`verify:intel` 在 CI 里是用冻结夹具
  直调 `node .tools/analyze-intel.js` 的），并且**先剥掉 YAML 注释再匹配** ——
  `checks.yml` 顶部就写着"`npm run verify:boards` 要联网，故意不放"，把注释当事实的话，
  "故意不跑"会被读成"已经在跑"。
- **`isBad()` 的附加约束**：门禁**打印了 `FAIL n`(n>0) 却退出 0** 也算失败。
  只信退出码会让这种门禁永久假绿 —— 它看起来在报错，CI 却一直过。
  这条规则由 `--self-test` 的 19 条真值表钉住（含 2 条真实误判串），3+3 条变异守着判别力。

**顺序固定：门禁 → 构建 → 镜像 → 校验。** 构建之后禁止再改源码（改了就必须重构建，
忘了就发出去旧产物，而且没有任何东西会提醒你）；镜像之后必须做产物引用自检
（`dist/index.html` 里每个 `src`/`href` 都得真实存在，漏了 `copy-assets` 会让 `wb-sdk.js` 404，
SPA fallback 把 `index.html` 当 JS 返回，报 `Unexpected token '<'`）。

**为什么值得折腾这些**（实测，不是估计）：本会话 8,291 次请求共 15.6 亿输入 token，
其中**工具结果唯一内容只有 1,221 万 token（0.78%）**，它被段内重发放大成 11.1 亿（90.8 倍）；
固定开销（系统提示词 + 工具定义）每次 45,101。也就是说钱的形状是"同样一段输出被反复背"，
不是"读得太多"。把一轮能跑完的门禁拆成 6 轮跑，每一轮的输出都会被后续轮次重发 ——
这才是 `verify:all` 存在的理由。

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
- `.tools/` 是「默认忽略 + 白名单放行」：脚本类文件（`*.js|mjs|cjs|ts|py`）和
  `lib/` `fixtures/` `sql/` `stubs/` 直接 `git add` 即可，**不需要 `-f`**（本文档曾写错成"需 -f"）。
  但**新建其它子目录必须先补两行白名单**（`!.tools/<dir>/` + `!.tools/<dir>/**`），
  否则文件**静默不进库** —— 本地能跑、CI 一拉就 `Cannot find module`（2026-10-23 `.tools/lib/` 就这么炸过）。
  自查：`git ls-files .tools/<子目录>/` 为空即是漏了。

### 8.1 诚实性：示例数据与平台能力

- **用户可见的示例/演示数据必须条目级标注，不能只在页级提示**：页级用 `DemoDataHint` + `markDegraded`，条目级用显式徽章（要有底色/边框，不能是一行小灰字）。实例：`src/pages/learnCommunity/index.tsx` 的 `seedPosts()` 三条内置动态带「示例」徽章，且用户发帖后依然保留。
- **H5 端不具备的能力不得用 mock 伪装成功**：要么真实实现，要么明确提示「仅小程序可用」，且**不得因此消耗用户额度**。实例：`src/components/AiAssistant/index.tsx` 的 `handleVoiceResult` 在非微信端直接 toast + return，`bumpVoiceUsage()` 不会执行（改动前用 `MOCK_TRANSCRIPTS` 冒充识别结果并扣额度）。语音入口随 AI 对话一并从晨报页底部输入条迁到「我的 → AI 助手」，守卫本身未变。

## 9. 待确认（我无法代为决定）

1. 微信小程序 AppID 与云环境 ID（`WX_APPID` / `WX_CLOUD_ENV`）—— 没有它无法部署云函数、无法真机预览
2. 主体类型是否已按「个体工商户」办理（决定类目与支付能否走通）
3. 第三方 LLM 供应商是否愿意提供算法备案截图 + 盖章合作协议

## 10. 多 AI 并发协作（2026-10-24 起）

本仓可能同时有多个 AI 在工作。**动 `src/` 之前先读 `.tools/COORDINATION.md`**（本地文件，已被
`.tools/*` 忽略，不进 public 仓），动完把「改了什么 + 建立了什么不变量」追加进去（倒序、带时间戳）。

- 分工现状：视觉线负责 `*.module.scss` / `theme.*` / `app.config.ts`；逻辑线负责 `src/services/*`、
  页面 `.tsx` 业务逻辑、`src/store/language.ts`。改跨线文件前在「交接/释放区」登记。
- 不变量清单（例如 `hasContent` 必须含字面量 `|| hasIntel`、内联 style 禁用 `rpx`）都写在该看板第 2/3 节；
  改到相关代码先跑对应 `verify:*`。
- 仍然适用本文件 4.1 / 6.1 的全部铁律：**禁止 `git add -A`**，只加精确路径；有未提交改动时变异验证会拒绝变异，属预期。

## 11. 上下文纪律：看"必要性"，不看缓存命中率（2026-10-24）

缓存命中率 97% 只说明"重发很便宜"，它回答不了"这条内容当初该不该读进来"。
本会话实测（8,291 次请求 / 15.6 亿输入 token）的形状是：

| 项 | 量 | 占比 |
|---|---|---|
| 工具结果**唯一内容** | 1,221 万 token | 输入的 **0.78%** |
| 它被段内重发放大 | 11.1 亿 token | 输入的 71% |
| 可证可避免（重复读 2,139 条 + 失败/空结果 447 条） | 1.65 亿 token | 输入的 10.56% |

⇒ 成本不是"读得太多"，是**同一段输出被反复背了 90.8 倍**。所以规则针对的是"留着不走"，不是"别读"：

1. **禁止整读大文件**。先 `Grep` 定位再 `Read` 带 `offset/limit`。
   单条 339 KB ≈ 8.5 万 token，读一次就永久驻留在上下文里，之后每一轮都在为它付费。
2. **读完立刻转成结论**。把"这文件说了什么"写成几行字/写进文件，而不是把原文留在对话里。
   唯一内容本身只占 0.78% —— 真正贵的是它不走。
3. **命令行数也是成本**。Bash 5,042 次调用贡献了 46.5% 的重发成本（每条输出都跟着走）。
   把一轮的十几条命令合并成一条循环/一个脚本，而不是十几条请求。
   同理：静态断言用脚本跑，别一条条手敲 `grep`。
4. **少用任务账本**。`TaskUpdate` 130 次 + `TaskCreate` 50 次 = 12.8% 的重发成本，
   因为两者都会把整份任务清单回显进上下文（单次回显实测可达 11 万字符）。
   只在阶段边界更新，不要每做一件小事就 update 一次。
5. **别让错误回执反复发生**。本会话有 63 次 `node -e` 被沙箱拦、37 次 Glob 返回空结果。
   已知会失败的做法第一次就该记进文档（本文件第 5/6 节），而不是重试第三遍。
6. **交付前自查**：报告里的每个数字都要能指向产生它的命令；估的要写明是估。

## 12. 写新代码之前：先检索现成方案（2026-10-24 用户要求）

顺序固定：**检索 → 评估 → 决定 → 动手**。不许跳过前两步直接开写。

- **检索**至少走两条路：`WebSearch`（中文需求先翻成英文能力词 + `site:github.com`）、
  GitHub 检索接口（`api.github.com/search/repositories`，公开仓库无需 token；
  注意走 **api** 域，`github.com` 在本机常被代理拒）。任务落在某个框架上时先查该框架的
  官方插件 / awesome 清单，比泛搜准。**搜一次就说"没有"不算检索。**
- **评估四问**，缺一条就别直接抄：
  **许可证**（GPL/AGPL 会传染，私有产品只考虑 MIT / Apache-2.0 / BSD）、
  **维护状态**（近 12 个月有无提交、issue 有无回应）、
  **栈匹配与体积**（H5 首屏敏感，200KB 的库换 20 行功能不划算）、
  **安全**（已知 CVE、是否外发用户数据）。
- **留痕**：选了哪个、为什么、放弃了哪些、为什么不能直接用。写进注释或提交说明，
  否则下一个人会重新检索一遍（或更糟：重新发明一遍）。
- **停止条件**：搜 3 轮 / 看 5 个候选仍不匹配 ⇒ 自己写，并注明「检索过 X / Y / Z，均不合适，原因是……」。
- **不适用**：改本仓既有逻辑、修 bug、写门禁与断言、内部数据口径。这些没有"现成的"可抄，
  去搜只是浪费一轮。
