# 上线级 UI 基线 · 晨报（U-01 ~ U-11）

- 仓库：`D:\Agent\晨报`（远端 `soloassistant/chenbao`，origin 名为 `9-8`）
- 基线 commit：`e6435b8`（origin/main，2026-11-05 fetch）
- 构建：worktree `D:\Agent\_wt\morning-u`，`builtAt=2026-11-05T07:08:43Z`（`dist/build-stamp.json`）
- 门禁：`verify:all` **65/65 通过**（首轮 64/65 是「构建与门禁并发」导致 `verify:site` 误红，dist 就绪后复跑全绿）
- 支付：`verify:paid` **105/105**；`verify:parity` **PARITY PASS**（仅门禁/CI 覆盖一致性，不含双端 UI 行为）
- 小程序：`taro build --type weapp` **构建成功**（`dist-weapp` 106 个文件）；**无微信开发者工具，运行时未测**

## 一、对表（U-01 ~ U-11）

| 项 | 实测数字 | 达标 | 严重度 | 证据 | 修法 | 预估行数 |
|---|---|---|---|---|---|---|
| U-01 首屏性能 | 首屏静态 gzip **340.9KB**（阈值 300KB）：app.js 234.6 / 506.js 61.9 / wb-sdk 19.5 / css 4.7 / html 4.5 / 图标 15.7。模拟 Fast 3G（1.6Mbps、RTT 560ms）首屏可用 **3.74s / 3.93s**（两次），FCP 1.32s；无网模拟 340ms | 否 | **P1** | CDP 实测（runtime.json） | app.js 拆包：把 library/trade/learn 模块 `dynamic import`，或收紧 vendor 分割；目标先减 45KB gzip | 60~120 |
| U-02 图片 | 20 条路由遍历：非空 src 且 `naturalWidth=0` 的破图 **0 张**；library 211 张图中 204 张为懒加载空 src（未进视口）、7 张已载（2 webp + 5 png）；已载 5 张 png 固有宽度 <400px（tabbar 图标，非内容图） | 部分 | **P2** | CDP 实测（runtime3.json） | 懒加载内容图补 `webp` + `srcset`；内容图尺寸需进视口后复测 | 20~40 |
| U-03 无障碍 | 触控热区：briefing 10/24、inbox 4/10、calendar 7/54、mine 0/21、trade 12/26、search 4/4 小于 44px（含内联标题链接，属 WCAG 豁免；真正的控件如返回箭头 33×33、顶部图标 37×37、语言 tab 73×38 不豁免）。键盘焦点：19 页中 8 页出现 1~2 个「Tab 到但无 outline/boxShadow」元素（inbox 4/5、prefs 3/5、assistant 3/5、library 4/5、search 4/5、shopping 4/5、ledger 4/5、sxm 3/5），全部是 `input/textarea`。aria：无名称可交互元素 6 个（calendar 1、prefs 1、trade 4） | 否 | **P1** | CDP 实测（Tab 事件 + `getComputedStyle`） | 给 `input/textarea` 补 `:focus-visible` outline；图标按钮最小 44×44；trade 4 个输入补 aria-label | 40~80 |
| U-04 双语 | EN 视图 UI 硬编码中文（修前）：inbox 48 字、shopping 33 字、learn 150 字（含课程名内容）、trade 31 字、briefing 127 字（含天气城市与资讯源名）。**已修 4 页**：inbox 48→8、shopping 33→0、learn 150→144（仅剩课程标题等内容）、trade 31→0；briefing 的「今日/当前/条相关资讯/来源/中文/分享」仍在 | 否（部分修复） | **P0** | CDP 实测（EN localStorage + `body.innerText` 扫 `[\u4e00-\u9fa5]`） | 已开分支 `fix/en-hardcoded-ui`；briefing/library 剩余 UI 词另拆 PR | 已改 41 行；剩余 ~60 |
| U-05 状态完整 | 空态：8 个页面用 `EmptyState`（shopping/sport/notify/inbox/library/ledger 等），冷态实测可见。失败态：断 API 后 briefing 直接显示「情报 0 条」（把失败伪装成空）；library 显示「云端功能暂不可用，当前为本地演示数据」但**无重试**；shopping 有独立 `loadFailed` 分支；ledger 本地数据无网络 | 否 | **P1** | CDP 实测（blockedURLs）+ 源码 | briefing 增加「加载失败 + 重试」；library 降级文案加重试按钮 | 50~90 |
| U-06 危险操作 | `showModal` 共 11 处；注销账号有「不可恢复」确认；**退出登录直接执行**（`mine/index.tsx` handleSignOut，点击即 `signOut()` 并 reLaunch，无确认） | 否 | **P1** | 源码 + 点击路径 | 退出登录加二次确认，文案写清「本地缓存保留、云端数据不删」 | 15~25 |
| U-07 主题 | 应用级暗色规则 **0 条**（`prefers-color-scheme` 仅出现在首屏骨架 `index.html`）；SCSS 裸 hex **274 处 / 29 个文件**（`theme.scss` 内 65 处是 token 定义，其余约 209 处为裸色值）；裸 `font-size` **65 处** | 否 | **P1**（暗色）/ **P2**（token） | 静态扫描 | 先做 `[data-theme=dark]` 变量覆盖（约 120 行），再按页替换裸色/裸字号 | 120~200 |
| U-08 输入 | invoice 文本框 `maxlength=2000`；注入 5806 字符 + emoji + 中文重复，页面不崩、值保留 5806（程序化注入绕过 maxlength；真实粘贴由浏览器截断）。登录校验、国际手机号有门禁覆盖 | 是（有边界） | **P2** | CDP 实测（runtime3.json） | 补粘贴超长（真实 paste）与 emoji 组合用例到门禁 | 20 |
| U-09 隐私 | 云函数 4 处 `console.log` 输出完整 `openid`：`auth-douyin` L83、`getBriefing` L539、`queryOrder` L392、`pay-callback` L650；客户端 `services/pay.ts` 只打「已获取」不打值。崩溃上报有脱敏（`sanitize`），但无云函数日志脱敏 | 否 | **P0** | 源码可证（云端未实测） | 统一 `maskId()`（前 6 + `***` + 后 4）；4 处调用各 1 行 | 20~30 |
| U-10 一致性 | `process.env.TARO_ENV` 分支 **29 处 / 14 个文件**；`verify:parity` 实际校验 CI 与本地门禁覆盖，不是 H5/小程序 UI 行为；小程序只完成构建，未跑真机/开发者工具 | 未测 | **P1** | 静态 + 门禁源码 | 建一个「双端文案/空态对照」静态门禁，再补开发者工具冒烟 | 单独 PR |
| U-11 合规触点 | 隐私政策/用户协议：首启 ConsentGate 全文展示，mine 可再次进入；账号注销（`account-delete`）、未成年人模式（`minor-mode`）、AI 合成标识均可达。**支付条款**：会员页有「到期与续费」状态卡，但购买前无「自动续费/退款/服务协议」前置说明或链接 | 部分 | **P1** | CDP 导航 + 源码 | 购买按钮上方加一行条款链接与续费说明 | 25~40 |

### 证据等级说明

- **运行时实测（当前 HEAD `e6435b8`）**：U-01/U-02/U-03/U-04/U-05/U-08（本地 dist + CDP，模拟器口径）。
- **源码可证**：U-06/U-09/U-11 部分、U-07 静态计数。
- **未测**：小程序运行时、真实云环境（openid 日志的实际采集链路）、支付条款在支付面板中的展示。
- 门禁 `verify:all` 的 65 条**不覆盖**上述任何一条的运行时判定（首屏体积、暗色、44px、EN 中文、失败态均无门禁）。

## 二、P0 清单（按严重度）

1. **P0-1 U-04 EN 硬编码中文（4 个核心页）** — 已修。
   - 分支 `fix/en-hardcoded-ui`（commit `e55d29b`），diff **+30 / -11 = 41 行**，6 个文件。
   - 改法：`inbox` 引导文案、`shopping` 计数/空态/失败态、`learn` 语种 tab、`trade` 品种名全部走 i18n（`nameEn` 字段）。
   - 变异证明：把 `inbox.howToH5` 的英文值改回中文后重建，行为检查 **3/4 FAIL**（inbox zhChars 48、命中 `群里的会议`）；还原后 **4/4 PASS**。未用 grep，检查读的是页面 `innerText`。
   - 分支质量：`verify:all` **65/65**、`tsc --noEmit` 0、改动文件 eslint 0。
   - 状态：**分支已推送**；PR **未创建**——本机无 `gh`，`git credential fill` 取不到 API token（`/repos` 返回 401），仅能推送分支。
   - 一键开 PR：<https://github.com/soloassistant/chenbao/compare/main...fix/en-hardcoded-ui>
2. **P0-2 U-09 云函数日志明文 openid（4 处）** — 未修。
   - 原因：真实云环境/调用链不可达，按「禁止 grep 冒充行为验证」的规则，无法给出行为级变异证明，故不开 PR。
   - 修法见上表；建议与「日志脱敏门禁」拆成两笔。

## 三、P1 / P2（等确认后再动）

- P1：U-01 首屏 340.9KB / 3.9s；U-03 焦点与热区；U-05 失败态与重试；U-06 退出登录确认；U-07 暗色主题；U-10 双端一致性；U-11 支付条款前置；U-04 briefing/library 残留。
- P2：U-02 懒加载图片尺寸/格式；U-07 209 处裸色值 + 65 处裸字号；U-08 粘贴边界用例。

## 四、命令与产物

```
# 基线（worktree D:\Agent\_wt\morning-u，HEAD e6435b8）
node .tools/verify-all.mjs          # 65/65
node .tools/verify-paid-entitlement.js  # 105/105
node .tools/verify-all.mjs --parity     # PARITY PASS
node node_modules/@tarojs/cli/bin/taro build --type h5
node node_modules/@tarojs/cli/bin/taro build --type weapp  # dist-weapp 106 files
```

实测原始数据：`D:\Agent\.tmp-u-audit\runtime.json`、`runtime2.json`、`runtime3.json`、`runtime4.json`、`check-en.json`。
