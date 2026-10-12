# 云函数凭据待办清单（可直接转发 workbuddy）

>生成时间：2026-10-12
> 用途：本项目 12 个云函数（`D:\Agent\cloudfunctions\*`）**一行都还没部署过**，本轮安全修复全部只存在于源码。
> 下面每一项都是部署的**硬前置**，缺一项 `npm run deploy:cloud` 就会失败或功能不通。

---

## 一、必须由你（workbuddy / 微信公众平台）提供，我这边无法生成

### 1. 小程序 AppID

| 项 | 值 |
|---|---|
| 变量名 | `WX_APPID` |
| 格式 | `wx` + 16 位十六进制，例如 `wx1234567890abcdef` |
| 来源 | 微信公众平台 → 小程序 → 开发管理 → 开发设置 → AppID |
| 当前状态 | `project.config.json` 里是 `touristappid`（游客测试号），无法上传、无法调用 `wx.cloud`、无法提审 |
| 填入位置 | `D:\Agent\.env.local` |

>⚠️ 当前主体**还没注册**。这一项在主体注册完成前拿不到，因此**本清单其余所有部署动作现在都无法执行**。

### 2. 小程序代码上传密钥（私钥）

| 项 | 值 |
|---|---|
| 变量名 | `WX_PRIVATE_KEY_PATH` |
| 格式 | 一个**文件路径**，指向 `private.<appid>.key` 文件（不是密钥内容本身） |
| 来源 | 微信公众平台 → 开发管理 → 开发设置 → 小程序代码上传 → 生成并下载 |
| 填入位置 | `D:\Agent\.env.local` |

>🔒 **私钥文件不要贴进对话，也不要提交进仓库。** 只要把文件放到本机，然后在 `.env.local` 里写它的路径即可。

### 3. 云开发环境 ID

| 项 | 值 |
|---|---|
| 变量名 | `WX_CLOUD_ENV` |
| 格式 | 云开发控制台 → 环境 → 环境 ID，形如 `morning-briefing-1a2b3c` |
| 来源 | 微信开发者工具 → 云开发 → 环境列表 |
| 填入位置 | `D:\Agent\.env.local` |

---

## 二、本轮新增、必须由你决定取值的环境变量

### 4. `INTERNAL_CALL_TOKEN`（**本轮安全修复引入，不配就会静默失效**）

| 项 | 值 |
|---|---|
| 变量名 | `INTERNAL_CALL_TOKEN` |
| 作用 | `getBriefing` 定时任务要代传 openid 调 `webSearch`。修复前这个身份是**客户端随便填什么就算什么**（H5 可读他人档案、消耗他人额度）；修复后必须带配对令牌才放行 |
| 填法 | 自己生成一串随机值，例如 `openssl rand -hex 24` 或任意 32+ 位随机串 |
| 填入位置 | **两处**，且必须完全相同：<br>① `getBriefing` 云函数的环境变量<br>② `webSearch` 云函数的环境变量 |
| 不配的后果 | `getBriefing` 每天 07:30 的定时晨报情报**静默失败**（控制台会打`INTERNAL_CALL_TOKEN 未配置` 的 error 日志），页面表现为「情报一直是空的」 |

> **这是本轮唯一一个「不配也不报错、但功能就是坏的」项**，请务必配。

---

## 三、云函数自身还需要的环境变量（既有，本次一并核对）

这些变量原本就在代码里被读取，但**从未配置过**，会导致对应功能静默降级：

| 变量名 | 所属云函数 | 缺失后果 |
|---|---|---|
| `WEATHER_KEY` | webSearch | 晨报天气模块不可用 |
| `WEATHER_LOCATION` | webSearch | 无此变量时回落到默认坐标 `116.41,39.92`（北京），**不是你的城市** |
| `LLM_API_KEY` | webSearch / chat / extract | 订阅档 AI 摘要失效，降级为原始 RSS |
| `LLM_BASE_URL` | 同上 | 默认 deepseek |
| `LLM_MODEL` | 同上 | 默认 `deepseek-chat` |
| `LLM_WEB_API_KEY` | webSearch / chat | 全网搜索与情报提炼失效 |
| `LLM_WEB_BASE_URL` | 同上 | 默认阿里云 dashscope |
| `LLM_WEB_MODEL` | 同上 | 默认 `qwen-plus` |
| `LLM_VISION_API_KEY` | extract | 图片内容提取失效 |
| `LLM_VISION_BASE_URL` | extract | 默认智谱 |
| `LLM_VISION_MODEL` | extract | 默认 `glm-4v-flash` |
| `SUBSCRIBE_TEMPLATE_ID` | getBriefing | 订阅消息推送发不出 |
| `PRICE_ALERT_TEMPLATE_ID` | getBriefing | 降价提醒发不出 |

> 这些 `.env.local` 里目前**一个都没有** —— 只有 3 个 `CODEFIX_LLM_*`。所以现状是：云函数就算部署上去，也基本处于「什么都不工作」的状态。

---

## 四、`.env.local` 应有的完整形状（自己填，不要发给我）

```ini
# ---- 部署凭据（微信）----
WX_APPID=wx........................
WX_PRIVATE_KEY_PATH=D:\Agent\secrets\private.wx....................key
WX_CLOUD_ENV=....................

# ---- 本轮新增：云函数内部调用令牌（两个云函数必须同值）----
INTERNAL_CALL_TOKEN=<随机 32+ 位字符串>

# ---- 天气 ----
WEATHER_KEY=<和风天气 Key>
WEATHER_LOCATION=<经度,纬度>

# ---- LLM ----
LLM_API_KEY=...
LLM_BASE_URL=...
LLM_MODEL=...
LLM_WEB_API_KEY=...
LLM_WEB_BASE_URL=...
LLM_WEB_MODEL=...
LLM_VISION_API_KEY=...
LLM_VISION_BASE_URL=...
LLM_VISION_MODEL=...

# ---- 订阅消息模板 ----
SUBSCRIBE_TEMPLATE_ID=...
PRICE_ALERT_TEMPLATE_ID=...
```

---

## 五、部署与验证（填完之后我来跑）

```powershell
cd D:\Agent
npm run deploy:cloud
```

**验证判据（部署后逐条看，不要只看命令退出码）：**

1. `npm run deploy:cloud` 退出码为 `0`（当前实测为 `2`）
2. 云函数控制台里 `getBriefing` / `webSearch` 等 12 个函数状态为「正常」
3. `getBriefing` 的**定时触发器**仍存在（`cloudfunctions/getBriefing/config.json` 里 `0 30 7 * * * *`）
4. 真机/模拟器登录后打开晨报，确认：
   - 情报区块**有内容**（若为空 → `INTERNAL_CALL_TOKEN` 没配或两边不同值）
   - 天气区块有内容（若为空 → `WEATHER_KEY` 没配）
   - 订阅档能出 AI 摘要（若只有原始 RSS → `LLM_WEB_API_KEY` 没配）
5. 调用一次注销账号，确认 `users / events / todos / items / briefings / usage / shopping / orders / user_prefs / user_affinity / newsFeedback` 十一个集合全部清空（修复前只删 7 个）

---

## 六、当前阻塞摘要

| 阻塞项 | 谁能解 | 现状 |
|---|---|---|
| 主体注册（个人/个体户/企业） | 用户本人 | **未注册** —— 这是一切的根，卡住后面全部 |
| AppID | 注册后微信公众平台 | 拿不到 |
| 私钥 | 拿到 AppID 后 | 拿不到 |
| 云环境 ID | 创建云开发环境后 | 拿不到 |
| `INTERNAL_CALL_TOKEN` | 任何人，随机串 | **现在就配**，不依赖主体 |
| 其余 LLM / 天气 key | 用户自己的账号 | 取决于是否有免费额度 |

> **`INTERNAL_CALL_TOKEN` 是唯一现在就能配的**，其余全部卡在主体注册上。