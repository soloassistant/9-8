# 部署上线 Checklist（v1.0 体验版基线）

> 更新：2026-09-10 · 对应 PRD v2.0 · M6 上线前待办的执行版
> 顺序：①云函数 → ②数据库 → ③小程序后台 → ④密钥环境变量 → ⑤真机验证 → ⑥提审自查

## 1. 云函数部署（12 个，微信开发者工具逐个「上传并部署：云端安装依赖」）

| 云函数 | 作用 | 需要的环境变量 | 备注 |
|---|---|---|---|
| login | 静默登录+用户档案 | — | 手机号绑定阻塞于主体资质，现为 mock |
| extract | AI 提取+排班 | `LLM_API_KEY` | 已接 msgSecCheck |
| confirmItem | 提取确认入库+待办勾选 | — | — |
| getBriefing | 晨报聚合 | `SUBSCRIBE_TEMPLATE_ID`（可选） | 含定时触发器（见下） |
| **webSearch（新增）** | 热点 RSS 聚合 + 今日情报 | `WEATHER_KEY`（可选）、`WEATHER_LOCATION`（可选，默认北京）、`LLM_API_KEY` | 今日情报=订阅专属，日限额 10 次 |
| chat | 对话/深思/工作助手/购物查价 | `LLM_API_KEY`、`LLM_WEB_API_KEY`（联网比价） | — |
| updateSettings | 习惯设置 | — | — |
| getLibrary | 收藏+浏览历史 | — | — |
| getUsage | 免费额度 | — | — |
| shopping | 购物清单 CRUD | — | — |
| createOrder | 订阅下单 | — | 支付阻塞于商户号 |
| deleteAccount | 注销清数据 | — | 部署后可移除前端 mock 特判（src/services/cloud.ts） |

### webSearch 环境变量获取
- `LLM_API_KEY`：DeepSeek 开放平台（与 extract/chat 同一个 Key 即可）
- `WEATHER_KEY`：和风天气控制台（dev.qweather.com）→ 免费订阅 → 创建应用取 Key
- `WEATHER_LOCATION`：不填默认 `116.41,39.92`（北京）；填坐标 `经度,纬度` 或和风 LocationID

### getBriefing 定时触发器
- config.json 已声明 `cron: 0 30 7 * * * *`（每日 7:30），部署后在云开发控制台「触发器」确认已创建

## 2. 数据库集合（云开发控制台确认存在，权限「仅创建者可读写」）
users / events / todos / items / briefings / usage / history / shopping / hotspotCache（webSearch 首次运行自动创建）
- users 关键字段：`subscribed`（付费订阅）、`expiredAt`（到期时间）、`subscribeAccepted`（订阅消息授权）、`preferences`（偏好标签数组）

### 2.1 部署后必须人工核对：敏感集合权限

> 仓库没有权限的 IaC，离线门禁也不模拟安全规则（mock 明确不校验权限）——**这两项只能部署后进控制台逐条确认**，代码合并与 CI 全绿都不代表权限设对了。
> 两个集合由云函数首次写入时自动创建；`refund_attempts` 随退款幂等改动生效，`moderation_failures` 随内容安全 fail-closed 改动生效（对应分支未合并前控制台里可能还看不到集合，合并部署后再核对）。

- [ ] **`refund_attempts`**：权限必须为「仅创建者可读写」，或自定义 `{"read": false, "write": false}`
  - **怎么查**：云开发控制台 → 数据库 → `refund_attempts` → 右上「权限设置」；再用小程序端（真机/体验版）执行 `wx.cloud.database().collection('refund_attempts').get()`，应返回 0 条或 `database permission denied`；同一条查询在云函数里应能读到数据（说明只限制了客户端，管理端不受影响）。
  - **期望值**：客户端读不到任何一条；云函数可读写。
  - **最坏情况**：若误设「所有用户可读」，任意登录用户可枚举他人的 `openid` + 退款金额 + `orderId`/`refundNo`；若再设「可写」，还能删改 `status`，直接拆掉 `_id` 唯一性构成的退款并发闸门，为重复退款打开入口。

- [ ] **`moderation_failures`**：权限必须为「仅创建者可读写」，或自定义 `{"read": false, "write": false}`
  - **怎么查**：同上，集合名换成 `moderation_failures`；客户端 `get()` 应 0 条/拒绝，云函数可读写。
  - **期望值**：客户端读不到；该集合字段为 `openid` / `action` / `reason` / `errCode` / `detail` / `ts` / `textHash`。
  - **最坏情况**：可读会泄露用户标识与其提交内容的指纹（`textHash` 可被同内容关联/反推）；可写可伪造或清除内容审核失败记录，掩盖违规内容、破坏 fail-closed 的取证链。

## 3. 小程序后台配置
- [ ] **插件管理**：添加「微信同声传译」（provider `wx069ba97219f66d99`）；版本与 `src/app.config.ts` 一致（当前写 0.3.5，**以后台插件页显示的最新稳定版为准**，不一致就同步改 app.config.ts）
- [ ] **订阅消息**：申请模板 → 替换两处：`src/pages/briefing/index.tsx` 的 `SUBSCRIBE_TEMPLATE_ID`、getBriefing 云函数环境变量 `SUBSCRIBE_TEMPLATE_ID`
- [ ] **客服**：绑定企业微信 → 替换 `src/pages/mine/index.tsx` 的 `SERVICE_CORP_ID`
- [ ] **服务器域名**：无需配置（全部走云函数，无前端直连外网）
- [ ] 确认 `src/app.tsx` 的 `Taro.cloud.init` 环境 ID 与控制台环境一致

## 4. 真机验证清单（部署完必测）
- [ ] 收件箱：粘贴文字 → 提取 → 确认入库
- [ ] 晨报：数据展示、待办勾选、文字指令、按住说话（真机出转写文本才算通）
- [ ] 热点：资讯流有数据且**每条带来源**；断网/源失败时降级不白屏
- [ ] 日历：月视图打点、写入手机日历
- [ ] 悬浮球：可拖动、点击开面板
- [ ] 购物清单：添加/勾购/记价；AI 比价（需 LLM_WEB_API_KEY）
- [ ] 注销：设置页走通清数据

## 5. 提审合规自查（对照 PRD 第 7 节）
- [ ] 《小程序隐私保护指引》：转发内容、录音、openid、浏览历史
- [ ] 用户输入/AI 输出过 msgSecCheck（extract 已接；chat 依赖 LLM 侧审核说明）
- [ ] 联网资讯：仅摘要不转载正文，每条标注来源（webSearch 已内置）
- [ ] AI 生成内容标注「— AI 生成内容，仅供参考 —」（晨报/热点/情报已内置）
- [ ] 注销 ≤3 步+二次确认；协议/授权管理入口可达（settings 内置占位文案，**正式法务文案待替换**）
- [ ] 购物助理为兜底形态（不涉交易），界面标注「比价/代下单需资质升级中」

## 6. 已知外部阻塞（不影响本次递交）
| 项 | 阻塞原因 | 现状 |
|---|---|---|
| 强制手机号登录 | 企业主体+微信认证 | 体验版 mock |
| 微信支付 | 商户号 | createOrder mock |
| 购物比价/代下单 | 电商类目资质+平台 API | v1 兜底形态先行 |
| TabBar 真机图标 | 建议换 PNG | 现用 SVG，后置美化 |
| logo 上传后台 | 需导出 144×144 PNG | `src/assets/logo.svg` 已出稿 |
