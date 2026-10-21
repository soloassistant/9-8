# 晨报模块 · 归档文件夹

> 生成日期：2026-10-21
> 本文件夹把「私人晨报助理」里**晨报功能的东西**集中收在一处，并逐项标出原位位置。

## ⚠️ 只读归档声明（先读这条）

- **唯一权威源是原位文件**：`src/` 与 `cloudfunctions/` 下的代码才是构建、部署、修改的入口。
- 本目录下的源码副本**仅供集中查阅**，改代码请回到原位文件，改完用文末「同步方式」刷新副本。
- 本目录不受 `tsconfig.json`（`include: ["src","types","config"]`）与 ESLint（`src/**`）管辖，副本不会污染编译与 lint。
- 「文档/」与「界面截图/」是原件副本/产物，可直接查看。

---

## 位置清单（标出位置）

### 1. 晨报页面 —— 原位 `src/pages/briefing/`

| 文件 | 本目录副本 | 职责 |
|---|---|---|
| `src/pages/briefing/index.tsx` | `源码/页面/index.tsx` | 晨报主页（问候语/今日日程/待办/收藏/今日情报/记账卡片/快捷指令/底部输入/订阅提醒/习惯守护） |
| `src/pages/briefing/index.module.scss` | `源码/页面/index.module.scss` | 晨报页样式（D1 快捷指令渐隐、输入浮层等） |
| `src/pages/briefing/index.config.ts` | `源码/页面/index.config.ts` | 页面配置（标题等） |

### 2. 晨报云函数 getBriefing —— 原位 `cloudfunctions/getBriefing/`

| 文件 | 本目录副本 | 职责 |
|---|---|---|
| `cloudfunctions/getBriefing/index.js` | `源码/云函数/index.js` | 服务端晨报聚合 + **定时批量推送** + 订阅消息下发。含：自适应信号(F21)、本周复盘(P1-G)、冷知识(X7)、周末轻量版(X6)、降价提醒(P-01)、今日情报挂载(attachIntel)、runScheduled 分桶推送 |
| `cloudfunctions/getBriefing/config.json` | `源码/云函数/config.json` | 触发器与 openapi 权限。**2026-10-21（P1a）**：单触发器 `morningBriefing(0 30 7)` 已拆为 `brief05~brief09` 五个整点 :30 分桶，配合用户 `briefingTime` 分流 |
| `cloudfunctions/getBriefing/package.json` | `源码/云函数/package.json` | 云端依赖声明 |

### 3. 前端数据与晨报算法 —— 原位 `src/data` / `src/utils`

| 文件 | 本目录副本 | 职责 |
|---|---|---|
| `src/data/getBriefing.ts` | `源码/前端数据/getBriefing.ts` | 前端晨报口径（与云函数同口径的降级/mock 实现） |
| `src/utils/adaptive.ts` | `源码/算法工具/adaptive.ts` | F21 自适应（爆满日/次日行程/高优待办），云函数内有同款内联版 |
| `src/utils/weeklyReview.ts` | `源码/算法工具/weeklyReview.ts` | P1-G 本周复盘统计，云函数内有同款内联版 |
| `src/utils/price.ts` | `源码/算法工具/price.ts` | P-01 降价提醒算法，云函数内有同款内联版 |

### 4. 情报供给（晨报与「热点」tab **共享**，非晨报专属）

| 文件 | 本目录副本 | 职责 |
|---|---|---|
| `cloudfunctions/webSearch/index.js` | `源码/情报供给-与热点tab共享/index.js` | 天气 + 偏好排序 RSS 情报接口；getBriefing 通过 `attachIntel` 调它（需 `INTERNAL_CALL_TOKEN` 同值） |
| `cloudfunctions/webSearch/news-trust.js` | `源码/情报供给-与热点tab共享/news-trust.js` | **信任过滤规则**（P0：小程序/H5/静态服务三链路共用这一份） |
| `cloudfunctions/webSearch/config.json` + `package.json` | 同名副本 | 配置与依赖 |
| `src/data/getHotspot.ts` | `源码/情报供给-与热点tab共享/getHotspot.ts` | 前端热点数据入口；另 `.tools/static-server.js` 的 `/api/hotspot` 与 hotspot fallback 数据由 `.tools/copy-assets.js` 恢复 |

### 5. 共享组件（晨报在用但**非专属**，未复制，仅标位置）

| 文件 | 与晨报的关系 |
|---|---|
| `src/components/EmptyState/index.tsx` | 空态组件；G1「空态 CTA → 去收件箱」在此实现 |
| `src/components/DemoDataHint/index.tsx` | G4 降级提示（mock 兜底时可见） |
| `src/components/Skeleton/index.tsx` | 加载骨架 |
| `src/components/HabitGuardBar/index.tsx` | 习惯守护条（晨报常驻） |
| `src/components/IntelGroupCard/index.tsx` | 情报分组卡片（今日情报区/热点tab 共用） |
| `src/components/AiAssistant/index.tsx` | 晨报页悬浮助手入口 |
| `src/components/ConsentGate/index.tsx` | 首启《服务协议与隐私政策》弹窗（视觉巡检截图里那层） |
| `src/components/Splash/index.tsx` | 开屏封面（不会自动关，须点击） |

### 6. 类型与文案键（未复制，仅标位置）

- **类型**：`src/types/index.ts` —— 日程 `ScheduleEvent`、待办 `TodoItem`、提取结果 `ExtractResult`、收藏等晨报页直接消费的结构。
- **文案**：`src/store/language.ts` 中 `briefing.*` 键共 **64 个**（中英双语各一套），覆盖：问候/空态/各 section 标题/快捷指令/订阅/定位/记账卡片/情报标注/自适应/朗读等：
  ```
  briefing.adaptiveBusy / adaptiveFocus / adaptiveTrip / aiTag / audioPlay / audioStop /
  briefing.chatHint / deepPlaceholder / deepToggle / degraded /
  briefing.emptyCta / emptyHint / emptyTitle / goSubscribe / inputPlaceholder /
  briefing.intelCiteHint / intelDegradedGroup / intelFreeNote / intelGroupLead / intelRawNote /
  briefing.ledgerCount…（ledgerIncome/ledgerLess/ledgerMore/ledgerNoRecord/ledgerNoRecordHint/ledgerSame/ledgerToday/ledgerViewAll/ledgerYesterday）/
  briefing.loadFailed / loadLabel / locateBtn / locateDenied / located / locating /
  briefing.quickDone / quickHot / quickNote / quickSchedule /
  briefing.sectionFav / sectionIntel / sectionLedger / sectionToday / sectionTodo / streak /
  briefing.subscribe / subscribeBanned / subscribeFail / subscribeHint
  ```
  （完整以 `grep -o "'briefing\.[^']*'" src/store/language.ts | sort -u` 为准）

### 7. 界面截图 —— `界面截图/`

- `briefing-视觉巡检-2026-10-21.png` —— 2026-10-21 用 `.tools/visual-pass.mjs` 真机（headless Chrome 154，414×896，登录态桩 + 关协议弹窗）截的晨报页。
- 生成命令：`node .tools/visual-pass.mjs briefing`（静态服务 `node .tools/static-server.js` 起在 8137）。
- 巡检时核对了《问题总表》D/G/A 系列；A5 脱敏、G1 空态 CTA、G5 引导、D4/D5、D8、D6 均实测在位。

### 8. 文档 —— `文档/`

| 文件 | 内容 |
|---|---|
| `文档/晨报会话-LLM实跑-2026-10-20.md` | 晨报对话接真 cloud.llm 的实测记录（含 60s 超时/熔断设计依据） |
| `文档/晨报页底部输入区-三处缺陷-根因与修复-2026-10-09.md` | 底部输入区缺陷根因与修复 |
| `文档/视觉走查与缺陷清单-2026-10-12.md` | D 系列视觉缺陷清单 |
| `文档/问题总表与解决方法.md` | 全项目问题总表（D/G/A/C 系列，页面交互的权威核对表；资料库另有同名单） |
| `文档/云函数部署指南.md` | getBriefing 等云函数部署三步（P0 入口） |

外部参考（资料库）见 `参考资料.md`。

---

## 部署状态（P0 / P1a，2026-10-21）

- **P1a 已完成代码并推送**（`f5edece`）：`brief05~brief09` 分桶 + `runScheduled` 按 `briefingTime` 分流。
- **P0 仍阻塞**：云函数未部署（线上跑旧版）。`.env.local` 缺 `WX_APPID` / `WX_PRIVATE_KEY_PATH` / `WX_CLOUD_ENV`，`project.config.json` 的 appid 仍是 `touristappid`。补齐后 `npm run deploy:cloud` 全量上传，P0（信任过滤/免费情报/msgSecCheck）与 P1a 一并生效。
- 部署后还需在云函数控制台配置环境变量（`INTERNAL_CALL_TOKEN` 在 getBriefing 与 webSearch **须同值**、`SUBSCRIBE_TEMPLATE_ID`、`PRICE_ALERT_TEMPLATE_ID`）。

## 最近变更（2026-10-21）

| 提交 | 内容 |
|---|---|
| `f5edece` | P1a：定时推送尊重 briefingTime（分桶触发器 + 分流） |
| `8fdc553` | cloudLlm.ts 3 处非空断言收口（Task #205） |
| `d45b860` | D2 修复（placeholder 改「说点什么…」）+ `.tools/visual-pass.mjs` 视觉巡检工具 + 建本归档文件夹 |
| 续修 | 晨报订阅提示条遮挡修复（`.subscribeTip` z-index:910，重拍验证）+ 清理空目录 settings/index + 驱动预置协议同意注入（详见 `参考资料.md`） |

## 同步方式（改完原位代码后刷新副本）

```bash
cd D:/Agent
cp src/pages/briefing/index.tsx src/pages/briefing/index.module.scss src/pages/briefing/index.config.ts 晨报/源码/页面/
cp cloudfunctions/getBriefing/index.js cloudfunctions/getBriefing/config.json cloudfunctions/getBriefing/package.json 晨报/源码/云函数/
cp src/data/getBriefing.ts 晨报/源码/前端数据/
cp src/utils/adaptive.ts src/utils/weeklyReview.ts src/utils/price.ts 晨报/源码/算法工具/
cp cloudfunctions/webSearch/index.js cloudfunctions/webSearch/news-trust.js cloudfunctions/webSearch/config.json cloudfunctions/webSearch/package.json 晨报/源码/情报供给-与热点tab共享/
cp src/data/getHotspot.ts 晨报/源码/情报供给-与热点tab共享/
```
