# 计划外改动评审 · v1.2 增量（2026-09-22）

> 评审人：高见远（架构师） · **只读评审**，未修改任何代码文件
> **评审快照时间：2026-09-22 12:23**（仓库在评审过程中被并发修改，tts.ts / briefing / location.ts / api.ts / language.ts 在 12:05–12:23 之间持续变化，本文所有结论以 12:23 快照为准，变动处已标注）
> 基线：`docs/design-increment-v1.2.md`（36 文件 / 10 任务 / 5 批次）、`docs/prd-increment-v1.2.md`（31 条）
> 核验手段：`git status` / `git diff` / 单文件 Read / `tsc --noEmit`（结果：**EXIT=0，0 错误**）

---

## 1. 结论摘要（先给答案）

| # | 结论 | 强度 |
|---|---|---|
| **1** | **`src/utils/learn.ts` 的 +47 行没有实现 D2 的任何一条**。它只做了两件事：① 练习最高分持久化（`drill` 字段 / `DrillKind` / `addDrillResult` / `getDrillScore`）；② 把打卡逻辑抽成 `checkInToday()`。L-01 冻结卡、L-02 补签、L-03 成就口径 **4 条验收标准 0 命中** → **D2 不能砍、不能大幅缩减，只能小幅缩减（约 −20 行 / 8%）**。 | 证据确凿 |
| **2** | **发现一个 P0 回归（计划外改动自带）**：`learn.ts:87-88`，`checkInToday()` 先写盘，紧接着 `writeLearnStore(store)` 又用**修改前的旧 store** 覆盖 →「标记认识单词」的打卡被抹掉，streak 永远不增长。**不先修这个 bug，D2 的「满 7 天发 1 张」永远发不出来**。 | 证据确凿 |
| **3** | **A2 已被别人做了约 80%**（`tts.ts` +264 行已含 V-05/V-06/V-07、`location.ts` 权限闸门、`briefing` C-02 弹窗 + scene 接线）。A2 只剩 2 处收尾：**① `sceneByHour()` 无人调用，夜间音色未接线；② 跟读慢速 `rate: 0.6` 被新加的 `clampRate()` 收敛到 0.9，慢速档已被静默废掉**。→ A2 从 +140 降到约 +30。 | 证据确凿 |
| **4** | **T00 前置批次已基本交付**（`language.ts` +316 / `permission.ts` 363 行新文件 / `PermissionDialog` 两个新文件 / `api.ts` +112），且 **A1、B1、C2 的依赖已就位**：麦克风弹窗底座现成、S-01 排班类型与 `apiApplyPlan` 现成、P-01 购物价位 API 现成。→ A1 −60、B1 −60、C2 −30。 | 证据确凿 |
| **5** | **VoiceButton 的 `asrLang` 与 A1 零冲突**（同一行的不同字段，`duration: 60000` 就是 A1 的 `VOICE_MAX_MS`）。**真正的冲突源是 `learnDetail`**：`SpeakingDrill.tsx:146` 用了 VoiceButton 却**没传 `asrLang`**，`langToAsr()` 是死代码 → 英语跟读拿中文 ASR 结果去比对，自动评分必然接近 0。修 1 行即可，但文件正在别人手上。 | 证据确凿 |

**一句话**：这批改动**不是「和 D2 重复劳动」，而是「提前交付了 T00 + A2，并顺手插了一个计划外的学习练习模式」**。真正需要处理的不是"砍任务"，而是"1 个 P0 回归 + 3 处跨批次副作用 + 1 个文件占用协调"。

---

## 2. 逐题回答

### Q1：`src/utils/learn.ts` 那 +44 行（现为 +47）到底实现了什么？

**答：与 D2 无关。它是「学习练习模式」的数据落地层 + 一次打卡逻辑抽取。D2 需要完整实现。**

#### 证据 1：`git diff src/utils/learn.ts` 的全部内容（47 行增量）

```diff
--- a/src/utils/learn.ts
+++ b/src/utils/learn.ts
@@ -21,8 +21,13 @@ export interface LearnStore {
   activeLang?: LearnLangId;
+  /** 练习统计（语法/听力/口语）：courseId -> 各类最高得分 */
+  drill?: Record<string, Record<DrillKind, number>>;
 }
+
+/** 练习类型：语法填空 / 听力选义 / 口语跟读 */
+export type DrillKind = 'grammar' | 'listening' | 'speaking';
...
+/** 今日打卡（幂等）：已打过返回 false，新打卡返回 true */
+export function checkInToday(): boolean {
+  const store = readLearnStore();
+  const today = dayjs().format('YYYY-MM-DD');
+  if (store.streak.days.includes(today)) return false;
+  store.streak.days = [...store.streak.days, today].slice(-DAY_LIMIT);
+  writeLearnStore(store);
+  return true;
+}
@@  markWords()
-  if (learned) {
-    const today = dayjs().format('YYYY-MM-DD');
-    if (!store.streak.days.includes(today)) {
-      store.streak.days = [...store.streak.days, today].slice(-DAY_LIMIT);
-    }
-  }
+  if (learned) checkInToday();
@@ 文末
+/** 记录一次练习成绩（取该课该类型历史最高分）；完成练习即自动打卡 */
+export function addDrillResult(courseId: string, kind: DrillKind, scorePct: number) { ... }
+/** 读取某课练习最高分（无记录返回 0） */
+export function getDrillScore(courseId: string, kind: DrillKind): number { ... }
```

#### 证据 2：D2 需要的符号，在 `src/utils/learn.ts` 中**一个都不存在**（`grep` 全文 237 行）

| D2 需要的符号（设计文档 §3.2(8)，design 758-815） | 现状 | 证据 |
|---|---|---|
| `StreakDay` | ❌ 不存在；`streak` 仍是 `{ days: string[] }` | `learn.ts:25`、`learn.ts:102` |
| `StreakFreeze` | ❌ 不存在 | 全文无 `cards` / `grantedAtStreak` / `usedDates` |
| `MakeupRecord` | ❌ 不存在 | 全文无 `month` / `used` |
| `settleStreakOnOpen()` | ❌ 不存在 | — |
| `canMakeup()` / `makeupMissed()` | ❌ 不存在 | — |
| `getFreezeCards()` | ❌ 不存在 | — |
| `getStreak()` | ✅ **早已存在（非本次新增）** | `learn.ts:101-111` |

#### 证据 3：4 条验收标准逐条对照

| 验收标准（PRD L-01 / L-02） | 现状 | 证据 |
|---|---|---|
| 连续满 7 天发 1 张冻结卡 | ❌ 无任何发卡逻辑 | `learn.ts` 全文无 `7` 相关里程碑判断 |
| 最多持有 2 张 | ❌ | — |
| 每月 1 次补签额度 | ❌ | — |
| 可补最近 2 天内的漏打卡日 | ❌ | — |

**命中率 0 / 4。**

#### D2 剩余工作量

| 子项 | 原估 | 现估 | 说明 |
|---|---|---|---|
| 类型定义 `StreakDay` / `StreakFreeze` / `MakeupRecord` / `SettleResult` | ~30 | ~30 | 无变化 |
| `readLearnStore()` 归一化（旧 `string[]` → 新结构） | ~15 | ~15 | 无变化 |
| `settleStreakOnOpen()` 惰性结算 | ~70 | ~60 | `checkInToday()` 已抽出可复用，−10 |
| `getFreezeCards()` / `canMakeup()` / `makeupMissed()` | ~50 | ~50 | 无变化 |
| `achievements.ts` 口径统一（L-03） | ~10 | **0~10** | 见下文 R2：若采用"旁路元信息"方案，可 0 改动 |
| `pages/learn/index.tsx` UI（冻结卡徽标 + 补签按钮） | ~60 | ~50 | 该文件**已有 `useDidShow(refresh)`**（`learn/index.tsx:37`），接线极便宜，−10 |
| `pages/learn/index.module.scss` | ~40 | ~40 | 无变化 |
| **合计** | **+240 / ~50 改** | **+220 / ~55 改** | **缩减约 8%** |

> **补充证据**：`src/pages/learn/index.tsx`（196 行）与 `src/pages/learn/index.module.scss`（330 行）在 `git status` 中**均为未修改**，D2 的 UI 落点完全干净。

#### ⚠️ 但必须先修这个 P0 回归

```ts
// src/utils/learn.ts:80-90  markWords()
export function markWords(courseId: string, wordIds: string[], learned: boolean) {
  const store = readLearnStore();          // L81  ← 读到 store A（streak 不含今天）
  ...
  store.progress[courseId] = next;         // L86  内存里改 progress
  if (learned) checkInToday();             // L87  ← checkInToday 内部 read-modify-write，写盘：streak 含今天
  writeLearnStore(store);                  // L88  ← 用 store A 整体覆盖！streak 回到"不含今天"
  return next;
}
```

- `checkInToday()` 在 `learn.ts:70-77`，内部 `writeLearnStore(store)` 在 **L75**；
- `markWords` 的 `writeLearnStore(store)` 在 **L88**，写的是 **L81 读到的旧对象**；
- `Taro.setStorageSync(LEARN_STORE_KEY, store)`（`learn.ts:51-57`）是**整体覆盖**，不是 merge。

**结果：学生点「认识」→ progress 存下来了，但当天打卡被抹掉 → `isTodayCheckedIn()` 永远 false、`getStreak()` 永远不涨 → L-01「满 7 天发卡」、L-03「成就口径」全部失效。**

> 重构前是内联修改 `store.streak.days` 再统一写盘（见 diff 中被删掉的 6 行），**功能是正确的；这次抽取把它改坏了**。
> 反例对照：`addDrillResult()`（`learn.ts:223-232`）是「先 `writeLearnStore(store)`（L230）→ 再 `checkInToday()`（L231）」，顺序正确，**没有这个 bug**。
> 修法（二选一）：`checkInToday(store)` 改为接收 store 参数不自行写盘；或 `markWords` 在 `checkInToday()` 之后 `return` 前重新 `readLearnStore()`。**这是 D2 的开工前置条件。**

---

### Q2：`VoiceButton` 的文件争夺风险 —— `asrLang` 会不会与 A1 冲突？

**答：不会冲突，而且 `asrLang` 还帮 A1 省了 3 行。真正的风险不在这里，在 `learnDetail`。**

#### 证据 1：`asrLang` 只动了 1 行，与 A1 的改造点不在同一处

```tsx
// src/components/VoiceButton/index.tsx
24:  /** 识别语种：默认中文；英语跟读场景传 en_US（同声传译插件仅支持中英） */
25:  asrLang?: 'zh_CN' | 'en_US';
35:  export default function VoiceButton({ disabled = false, compact = false, asrLang = 'zh_CN', onResult }: VoiceButtonProps) {
147:      pluginRef.current.start({ lang: asrLang, duration: 60000 });
```

A1 要改的是**同文件里的另外 6 处**，与 L25 / L35 / L147 的 `asrLang` 字段无交集：

| A1 需求（design §3.2(1)，373-377） | 现有代码位置 | 与 asrLang 是否冲突 |
|---|---|---|
| V-01 松手后补录 200ms（`VOICE_TAIL_MS=200`） | `handleTouchEnd` **L157-180**，当前 `pluginRef.current.stop()` **立即调用**（L173） | ❌ 不冲突 |
| V-02 上滑 ≥80px 取消（`VOICE_CANCEL_PX=80`） | `handleTouchMove` **L153-155**，当前**不接收事件参数**，任何 move 都直接 `setCancelMode(true)` | ❌ 不冲突（但需新增 `startYRef`，见下） |
| V-03 `<500ms` 判误触（`VOICE_MIN_MS=500`） | 两处：`initFallbackRecorder` **L66** `duration >= 1`；`manager.onStop` **L104** `duration < 1`。两者都用 `Math.round((Date.now()-startAt)/1000)`，**秒级取整** | ❌ 不冲突（但两处都要改成原始 ms 比较） |
| V-04 60s 上限 + 10s 提醒（`VOICE_MAX_MS=60_000`） | **L147 / L149 的 `duration: 60000`** | ⚠️ **是同一个东西，见下** |
| 60s 到点自动发送 + 轻震动 | 无定时器，需新增 1s tick | ❌ 不冲突 |
| C-01 首次点击走麦克风权限弹窗 | `handleTouchStart` **L139-151**，当前无任何权限逻辑 | ❌ 不冲突 |

#### 证据 2：关于 `duration: 60000` 与 A1「60s 上限」的关系

**它们是同一个参数的两面，不是两个 60s。**

- `duration: 60000`（`VoiceButton:147` 插件 / `:149` RecorderManager）是**微信同声传译插件 / RecorderManager 的「最长录音时长」入参**，插件到点会自行 `stop` 并触发 `onStop`；
- A1 的 `VOICE_MAX_MS = 60_000`（design:374）是**状态机的硬上限常量**。

**A1 落地时的正确做法**：把 L147 / L149 的字面量 `60000` 替换为 `VOICE_MAX_MS`（常量化，QA 用例可直接引用），**保留插件自带的 60s 截断作为兜底**，另外用 1s tick 定时器只做两件事：**剩余 10s 时置 `voice.tenLeft` 提示 + 轻震动**、**到 60s 时把状态机推进到 `autoStop`**。不要把 `duration` 改小也不要改大，`asrLang` 保持在 `start({ lang: asrLang, duration: VOICE_MAX_MS })` 里不动。

#### 证据 3：A1 真正需要注意的 4 件事

1. **`handleTouchMove` 要改成接收事件**：现在是无参函数（L153），A1 必须改为 `(e) => { const y = e.touches[0].clientY; ... }`，并新增 `startYRef`（在 `handleTouchStart` 里记录 `e.touches[0].clientY`）。**这是 A1 唯一需要"改签名"的地方，与 `asrLang` 无关。**
2. **权限弹窗底座已经现成，别再写一遍**：`src/utils/permission.ts`（363 行，未提交的新文件）+ `src/components/PermissionDialog/` 已实现，`ensurePermission('microphone')` / `shouldShowDialog()` / `PERMISSION_TEXT` / `isDeniedDegraded()` / `openAppSetting()` 全部可用（`permission.ts:310 / 168 / 53 / 175 / 225`）。
3. **⚠️ `ensurePermission` 的返回值以实码为准，不要照设计文档写**：设计 §3.2(2)（design:474）写的是 `Promise<GrantResult>`（`'granted'|'denied'|'system-denied'`），**实码是 `Promise<boolean>`**（`permission.ts:310-332`）。若 A1 按设计写 `if (res === 'system-denied')`，TS 会报错且逻辑永远是 false。**请一律以实码为准，设计文档 3.2(2) 的签名作废。**
4. **VoiceButton 现在有 2 个使用点，回归要覆盖双路径**：
   - `src/pages/briefing/index.tsx:563` → `<VoiceButton compact disabled={sending} onResult={handleVoiceResult} />`（**compact 模式**，走默认 `zh_CN`）
   - `src/pages/learnDetail/SpeakingDrill.tsx:146` → `<VoiceButton onResult={...} />`（**非 compact 模式**）
   A1 改手势必须两条路径都过，尤其 `Math.max(duration, 2)` 的 H5 mock 分支（`VoiceButton:167`）不要被误伤。

#### 证据 4：真正的文件争夺点 —— `SpeakingDrill.tsx:146` 漏传 `asrLang`

```tsx
// src/pages/learnDetail/SpeakingDrill.tsx
 40:  const canAutoScore = langId === 'en';          // 英语课走转写自动评分
 73:  const handleVoiceResult = (transcript?: string) => {
 75:    if (canAutoScore && transcript) {
 76:      const pct = Math.round(speechSimilarity(line.example, transcript) * 100);   // 英文句子 vs 中文识别结果 → 必然 ~0
146:          <VoiceButton onResult={(res) => handleVoiceResult(res.transcript)} />   // ← 没传 asrLang，默认 zh_CN
```

```ts
// src/utils/learnDrills.ts
 26:  export function langToAsr(langId: LearnLangId): 'zh_CN' | 'en_US' {
 27:    return langId === 'en' ? 'en_US' : 'zh_CN';
 28:  }
```

`grep -rn "langToAsr" src` → **只有定义处 `learnDrills.ts:26`，零调用**。
`grep -rn "asrLang" src` → 只有 `VoiceButton:25 / 35 / 147`，**无调用方传入**。

**结论：`asrLang` 这条能力链路是"装了接口、没人接线"的半成品。英语跟读的自动评分当前必然给出接近 0 分的错误反馈。**修复只需 1 行（`asrLang={langToAsr(langId)}`），但文件在另一位工程师手上。

---

### Q3：`src/utils/tts.ts` 距 v1.2 规格还差多少？会不会破坏多语种链路？

**答：12:23 快照下，tts.ts 已被另一名工程师补到 428 行（+264），V-05 / V-06 / V-07 的核心已落地。只剩 2 处收尾。多语种链路不会被破坏（显式 `lang` 优先已保证）。**

> ⚠️ 该文件在评审期间被并发修改：12:05 快照为 225 行（只有 `TtsLang` / `TtsOptions{lang,rate}` / `isTtsLangSupported`），12:23 快照为 428 行。以下按**最新快照**评估；若团队看到的仍是旧版，请以「design §3.2(3) 全部未实现」计（A2 回到原估 +140）。

#### 证据 1：已实现的部分（12:23 快照）

| 项 | 位置 | 状态 |
|---|---|---|
| V-05 `TTS.RATE_MIN=0.9` / `RATE_MAX=1.1` / `RATE_DEFAULT=1.0`（原硬编码 1.05 已改） | `tts.ts:22-31` | ✅ |
| V-05 `clampRate()` 越界收敛 + `console.warn` | `tts.ts:125-136` | ✅ |
| V-05 `TTS_RATE_OPTIONS` 三档（D1「我的」页设置项用） | `tts.ts:66-70` | ✅（尚无调用方，留给 D1） |
| V-06 `TTS.GAP_MS=300` + H5 `setTimeout` / weapp `onEnded` 后延时 | `tts.ts:24`、`tts.ts:395` `gapTimer = setTimeout(requestNext, gapMs)` | ✅ |
| V-07 `TtsScene` + `TTS_SCENE_PROFILE`（briefing/news/follow/night 四场景） | `tts.ts:45`、`tts.ts:58-63` | ✅ |
| V-07 `resolveVoiceProfile()` / `TtsVoiceMode` / 偏好持久化 `mb_tts_voice` | `tts.ts:175-193`、`tts.ts:99-160` | ✅ |
| 多语种 `TtsLang`（中英日韩）+ `isTtsLangSupported()` | `tts.ts:42`、`tts.ts:116-122` | ✅ |
| weapp 兜底：ja/ko 回 `zh_CN`，不报错 | `tts.ts:325` | ✅ |
| `startSpeak(chunks, cb, opts?)` **三参签名** | `tts.ts:420` | ✅（与设计文档的二参方案不同，见下） |

#### 证据 2：还差什么（逐条）

| # | 缺口 | 证据 | 影响 |
|---|---|---|---|
| **1** | **夜间场景未接线**：`sceneByHour()`（22:00–07:00 → night）已导出但**零调用** | `grep -rn "sceneByHour" src` → 仅 `tts.ts:189` 定义处 | V-07「夜间音色」实际不生效。修：`briefing/index.tsx` 把 `{ scene: 'briefing' }` 改为 `{ scene: sceneByHour(dayjs().hour(), 'briefing') }`（当前在 `briefing/index.tsx` 约 L375-387 的 `startSpeak` 调用处） |
| **2** | **跟读慢速档被 `clampRate` 静默废掉** | `ListeningDrill.tsx:48` `{ lang: ttsLang, rate: slow ? 0.6 : 0.9 }`、`SpeakingDrill.tsx:51` 同；而 `clampRate`（`tts.ts:125-136`）会把 0.6 收敛成 0.9 并 `console.warn` | 用户点「🐢 慢速」听到的速度和正常档一样，且每次打 warn。见风险 R4 |
| 3 | 设计文档 `TtsSpeakOptions` 二参方案 vs 实码三参方案 | design:526 `startSpeak(chunks, options)`；实码 `tts.ts:420` `startSpeak(chunks, cb, opts?)` | **建议沿用实码三参**（理由见风险 R5），不要为对齐设计文档去改 3 个调用点 |
| 4 | weapp 无 `pitch` 入参 | 同声传译 `textToSpeech` 只有 `lang/tts/content` | 属设计预期内（design:493「weapp 无此参数时忽略」），**不算缺口** |

#### 证据 3：会不会破坏现有多语种发音链路？——**不会**，前提是保住两行优先级

```ts
// H5 分支：src/utils/tts.ts:278
utter.lang = opts?.lang || profile.lang || 'zh-CN';        // 显式 opts.lang 优先于场景表 ✅

// weapp 分支：src/utils/tts.ts:325
const pluginLang = (opts?.lang && WEAPP_TTS_LANGS[opts.lang]) || 'zh_CN';   // 显式优先，ja/ko 兜底中文 ✅
```

三条现有调用链都能被正确承接：
- `briefing/index.tsx` → `{ scene: 'briefing' }`，不传 `lang` → 走 `profile.lang = 'zh-CN'`（场景表默认）✅
- `ListeningDrill.tsx:48` → `{ lang: ttsLang, rate: ... }` → 显式 `lang` 覆盖场景表 ✅
- `SpeakingDrill.tsx:51` → 同上 ✅

**⚠️ A2 收尾时唯一不能动的就是这两行的「显式 `opts.lang` 优先」顺序** —— 一旦改成「场景表优先」，日语/韩语课会被强制读成中文，`learnDetail/index.tsx:35` 的 `isTtsLangSupported` 前置拦截（隐藏发音按钮）也会失去意义。

#### 证据 4：300ms 停顿对「≤3 分钟晨报」的影响（可忽略）

`briefing/index.tsx` 的播报稿按句分块，`splitTtsChunks` 上限 110 字/块；一份典型晨报约 20–40 块 → 增加 6–12s，相对 180s 上限有充足余量。**无需为此调整块大小。**

---

### Q4：三个 Drill 组件 + `learnDrills.ts` 会不会占用 D2 的文件？`learnDetail` 要不要绕开？

**答：`learnDetail` 目录与 D2 完全无交集，不需要绕开。D2 唯一被"同文件共存"的是 `src/utils/learn.ts`，但两者改的是不同层（drill 字段层 vs streak 层），冲突面可控。**

#### 证据 1：文件占用矩阵

| D2 的目标文件（design:110-112） | git 状态 | 被计划外改动触碰？ | 结论 |
|---|---|---|---|
| `src/utils/learn.ts` | **M（+47）** | ✅ 是，但只加了 `drill` 字段 + `DrillKind` + `addDrillResult` / `getDrillScore` + 抽取 `checkInToday` | **同文件共存，非冲突**（见证据 3） |
| `src/utils/achievements.ts` | **未修改**（174 行，git clean） | ❌ 否 | 干净 |
| `src/pages/learn/index.tsx` | **未修改**（196 行，git clean） | ❌ 否 | 干净 |
| `src/pages/learn/index.module.scss` | **未修改**（330 行，git clean） | ❌ 否 | 干净 |
| `src/pages/learnDetail/*`（3 个 Drill + index） | **新增 / M** | ✅ 是 | **与 D2 无交集**：D2 改的是 `pages/learn/*`，不是 `pages/learnDetail/*` |
| `src/utils/learnDrills.ts` | **新增（195 行）** | ✅ 是 | 与 D2 无交集（纯练习题生成器，见证据 2） |

#### 证据 2：`learnDrills.ts` 的内容（195 行，纯派生逻辑，不碰 streak）

```
:14  langToTts(langId) -> TtsLang          // 课程语种 → TTS 语种
:26  langToAsr(langId) -> 'zh_CN'|'en_US'  // 课程语种 → ASR 语种（死代码，见 Q2）
:81  buildGrammarQuestions(course)          // 例句挖空 + 3 干扰项
:118 buildListeningQuestions(course)        // 听音选义
:147 buildSpeakingLines(course)             // 跟读句清单
:177 speechSimilarity(expected, actual)     // Dice 系数评分
```

**它只 import `data/learn` 和 `tts` 的 `TtsLang` 类型，不 import `utils/learn`。** 与 D2 的 streak 域零耦合。

#### 证据 3：`learn.ts` 同文件共存的分层判断

```
LearnStore（learn.ts:23-29）
├── progress      ← 旧有，D2 不动
├── streak.days   ← 旧有，【D2 要动】string[] → 结构化
├── activeLang    ← 旧有，D2 不动
└── drill         ← 计划外新增，D2 不动          ← 新增字段层
```

**两者改的是 `LearnStore` 的不同字段**，且 `readLearnStore` 各自做了独立的兜底（`learn.ts:40` 的 streak、`learn.ts:42` 的 drill），互不覆盖。**冲突面 = 0，前提是 D2 不要整体重写 `LearnStore` 接口。**

#### 证据 4：⚠️ 但有一处**隐性耦合**必须处理

`checkInToday()`（`learn.ts:73`）、`isTodayCheckedIn()`（`learn.ts:115`）、`getStreak()`（`learn.ts:102`）三处**都假设 `streak.days` 是 `string[]`**：

```ts
 73:  if (store.streak.days.includes(today)) return false;                    // checkInToday
102:  const days = new Set(readLearnStore().streak.days);                     // getStreak
115:  return readLearnStore().streak.days.includes(dayjs().format('YYYY-MM-DD'));  // isTodayCheckedIn
```

设计文档 §3.2(8) 的方案是「旧数据 `string`，新数据 `StreakDay`，读取时统一归一化」。**一旦按此执行，这三处会全部失效**——而 `checkInToday()` 恰恰是计划外新增的。

> **架构修订建议（R2）**：D2 改为**「保持 `streak.days: string[]` 不变 + 旁路元信息」**方案 —— 冻结日 / 补签日照常以字符串日期写进 `days[]`，另建 `streakMeta: { freeze: StreakFreeze; makeup: MakeupRecord; frozenDates: string[]; makeupDates: string[] }` 记录标记。
> **收益**：`checkInToday` / `isTodayCheckedIn` / `getStreak` 三处 **0 改动**；`achievements.ts` 因已调用 `getStreak()`（`achievements.ts:48`）而自动获得统一口径，**L-03 变成 0 改动**；回归面从"整个学习模块"缩小到"learn.ts 新增函数 + learn 页 UI"。
> **代价**：`StreakDay` 类型改为"元信息查询函数"（如 `isFrozenDate(date)`）而非数据结构本体。这是我对原设计的一处正式修订，请团队确认。

---

### Q5：修订后的任务工作量重估与合并建议

#### 5.1 工作量表

| 任务 ID | 原估改动量 | **现估** | 结论 | 依据（文件 + 行号） |
|---|---|---|---|---|
| **T00**<br/>i18n 基线 + 权限底座 + API 签名 | +520 | **已交付**（实际 language +316 / permission.ts 363 行新 / PermissionDialog ×2 新 / api.ts +112） | **关闭** | `language.ts` 已含 `voice.*`(16) / `perm.*`(24) / `plan.*`(32) / `memory.*`(8) / `learn.freeze*+makeup*`(`zh` 357-364、`en` 742-749) 全部 zh+en 双语；`en` 被 `Record<keyof typeof zh, string>`(`language.ts:398`) 约束且 **tsc EXIT=0** → 双语完整。`permission.ts` / `PermissionDialog` / `api.ts` 的 `apiApplyPlan` + `apiShoppingSetTargetPrice` + `ShoppingItem.lastNotifiedPrice` 与 design:82 逐项吻合 |
| **A1**<br/>语音手势状态机 + 按钮改造 | +260 / ~120 改 | **+190 / ~130 改** | **照做（小幅缩减）** | 缩减：C-01 麦克风弹窗底座现成（`permission.ts:310` + `PermissionDialog`），省掉自建底座 ~60 行；`asrLang` 已存在省 3 行。<br/>增加：手势逻辑实际要改 6 处（`VoiceButton:66 / 104 / 139-151 / 153-155 / 157-180 / 147,149`），需新增 `startYRef` + 1s tick 定时器；回归要覆盖 compact + 非 compact 双路径 |
| **A2**<br/>TTS 调参 + 位置权限合规 | +140 / ~40 改 | **+30 / ~15 改** | **缩减为收尾项** | 已完成：`tts.ts` +264（V-05/06/07 全在，`tts.ts:22-31 / 58-70 / 125-136 / 175-193 / 246 / 395`）；`location.ts` +12 权限闸门（`location.ts:15-24`，`ensurePermission('location')` 前置）；`briefing/index.tsx` C-02 全链路（弹窗 / 降级提示条 / 去设置）+ `{ scene: 'briefing' }` 接线。<br/>剩余 2 项：① `sceneByHour` 未接线（夜间音色不生效）；② 跟读慢速 0.6 被 clamp（见 R4） |
| **B1**<br/>排班逻辑 + 记忆模块 + chat 云函数 | +380 / ~30 改 | **+320 / ~30 改** | **照做（小幅缩减）** | `api.ts` 已交付 S-01 最小类型集 `SlotCandidate` / `PlanProposal` / `PlanApplyEvent` / `PlanApplyPayload` / `PlanApplyResult` + `apiApplyPlan()`（`api.ts:131-226`），且文件内注释明确「B1 的 `schedule.ts` 直接 import，本文件不再重复定义富类型」→ `schedule.ts` 省掉 API 签名部分 ~60 行 |
| **B2**<br/>AI 对话 UI + 收件箱 | +330 / ~80 改 | **+330 / ~80 改** | **照做** | 目标文件 `AiAssistant/*`、`inbox/index.tsx` 全部 git clean，无交集 |
| **C1**<br/>热点反馈 + 屏蔽清单 | +300 / ~60 改 | **+300 / ~60 改** | **照做** | 目标文件 `blocklist.ts`（新）、`library/*` 全部 git clean；文案 `library.blockTitle` 等已就位（`language.ts:302-309`） |
| **C2**<br/>购物降价提醒 + 广告分隔 | +260 / ~70 改 | **+230 / ~70 改** | **照做（小幅缩减）** | `api.ts` 已交付 `apiShoppingSetTargetPrice` / `apiShoppingClearTargetPrice` / `ShoppingItem.lastNotifiedPrice`（`api.ts:236` diff 段、`api.ts:261-278`）→ 省 ~30 行 |
| **D1**<br/>订阅锁价 + 注销 + 记忆管理 + TTS 设置项 | +340 / ~90 改 | **+340 / ~90 改** | **照做，且可提前开工** | 依赖 A2 的 TTS 常量**已就绪**（`TTS_RATE_OPTIONS` `tts.ts:66`、`saveTtsPrefs` `tts.ts:155`、`getTtsPrefs` `tts.ts:139`），D1 不再被 A2 阻塞 |
| **D2**<br/>学习 Streak 容错 | +240 / ~50 改 | **+220 / ~55 改** | **照做，不可砍、不可大幅缩减** | 见 Q1：4 条验收 0 命中；可省的只有「`checkInToday` 已抽出 −10」「`learn/index.tsx:37` 已有 `useDidShow` −10」「采用 R2 旁路方案后 `achievements.ts` −10」，合计 ≈ −20 行（8%） |

#### 5.2 合并建议

| 建议 | 说明 |
|---|---|
| ✅ **A2 收尾并入 A1，由同一人串行做** | 两者文件集完全互斥（A1：`voiceGesture.ts` 新 + `VoiceButton/*`；A2 收尾：`briefing/index.tsx` + `tts.ts` + `learnDetail` 慢速档 2 行）。合并后 A 批从"2 人并行各 140/260 行"变成"1 人串行 ~220 行"，减少 1 次交接与 1 次冲突窗口。<br/>⚠️ 但 A2 收尾里的 `ListeningDrill.tsx:48` / `SpeakingDrill.tsx:51` 慢速档 2 行**必须等 learnDetail 的占用释放**，不能抢。 |
| ✅ **D1 与 D2 保持并行（不建议合并）** | 文件完全互斥（`mine/*` vs `learn/*`）。不合并的理由：D2 开工前必须先修 `learn.ts:87-88` 的 P0 回归，需要独立的验收门禁；合并会让这个前置修复被淹没在 D1 的 340 行里。 |
| ❌ **不建议合并 B1+B2** | 设计已定 B2 依赖 B1 的 `schedule.ts` / `memory.ts`，串行关系真实存在。 |
| ❌ **不建议合并 C1+C2** | 两者可并行，合并只会拉长关键路径。 |
| ➖ **D2 是否可砍？—— 不可** | L-01 / L-02 是 P0（PRD 31 条中 22 条 P0 里的 2 条）。且 D2 是当前**唯一**还没有任何代码落地的 P0 任务（T00/A2 部分、B1/C2 的 API 层都已有人推进），砍掉等于把 P0 缺口留在 v1.2 里。 |

---

## 3. 风险与建议

### 3.1 风险清单（按严重度排序）

| ID | 级别 | 风险 | 证据 | 处置 |
|---|---|---|---|---|
| **R1** | 🔴 高 | **`learn.ts` 文件争夺**：计划外已 +47 行，D2 还要改同文件，且**另一位工程师仍在 edit 中**（评审期间 learn.ts 从 +44 变 +47） | `git status` M；12:05 与 12:23 两次快照行数不同 | **D2 必须排在该工程师提交之后开工**；开工前先 `git diff src/utils/learn.ts` 复核一次 |
| **R2** | 🔴 高 | **打卡被覆盖的 P0 回归**：`markWords` 的 `checkInToday()`（L87）写入被 `writeLearnStore(store)`（L88）用旧对象覆盖 → streak 永不增长 | `learn.ts:81/87/88`、`learn.ts:75`、`learn.ts:51-57`（整体覆盖写盘） | **列为 D2 的开工前置条件（T-D2-0）**；修法见 Q1。验收：点「认识」后 `isTodayCheckedIn()` 必须为 true |
| **R3** | 🔴 高 | **`StreakDay` 结构升级会连带破坏 3 处**：`checkInToday`(L73) / `getStreak`(L102) / `isTodayCheckedIn`(L115) 都假设 `days: string[]` | 见 Q4 证据 4 | **采用「旁路元信息」方案**（保留 `days: string[]`，新增 `streakMeta`），三处 0 改动，`achievements.ts` 也 0 改动 |
| **R4** | 🟡 中 | **跟读慢速档被 `clampRate` 静默废掉**：`rate: 0.6` 被收敛成 0.9 | `ListeningDrill.tsx:48`、`SpeakingDrill.tsx:51` vs `tts.ts:125-136` | 二选一，请 PM 定：**(a)** 慢速改 0.9 / 正常改 1.0（符合 V-05，但需改 learnDetail 占用区 2 行）；**(b)** V-05 只约束「我的页三档设置」，跟读慢速豁免 clamp（需 `tts.ts` 加 `allowWideRate`）。**我倾向 (a)** —— 0.6 与 0.9 的听感差异在短句上不明显，而破坏 V-05 的代价更大 |
| **R5** | 🟡 中 | **`permission.ts` 实码 API ≠ 设计文档**：`ensurePermission` 返回 `boolean` 而非 `GrantResult`；`PERMISSION_TEXT` 是常量而非 `getPermissionCopy()` 函数 | `permission.ts:310-332`、`permission.ts:53-72` vs design:461-481 | **A1 / D1 / C1 一律以实码为准**，`design-increment-v1.2.md` §3.2(2) 的签名正式作废。建议把这条写进团队共享知识 |
| **R6** | 🟡 中 | **`SpeakingDrill` 漏传 `asrLang`，`langToAsr` 是死代码** → 英语跟读自动评分必然接近 0 | `SpeakingDrill.tsx:146` / `:75-79`；`grep langToAsr` 仅定义处 | 1 行修复 `asrLang={langToAsr(langId)}`；**归入 A1 收尾**，但需与 learnDetail 占用者协调时序 |
| **R7** | 🟡 中 | **`tts.ts` 签名与设计文档不一致（三参 vs 二参）** | `tts.ts:420` vs design:526 | **维持实码三参**，不要为对齐文档去改 3 个调用点（`briefing` / `ListeningDrill:39` / `SpeakingDrill:46`），其中 2 个在 learnDetail 占用区 |
| **R8** | 🟢 低 | **`sceneByHour()` 已导出但零调用**，夜间音色不生效 | `grep -rn "sceneByHour" src` → 仅 `tts.ts:189` | A2 收尾接线：`{ scene: sceneByHour(dayjs().hour(), 'briefing') }` |
| **R9** | 🟢 低 | **仓库正在被并发修改**，本评审为 12:23 快照 | tts.ts 225→428 行、briefing 从 clean→+8 净增、location.ts 新增修改、api.ts/language.ts 行数变化 | 任何人开工前 **先跑一次 `git status` + `tsc --noEmit`**；若 tsc 非 0，先找当前改动者 |

### 3.2 建议的执行顺序

```
第 0 步（前置，串行）
  └─ T-D2-0：修 learn.ts:87-88 打卡被覆盖的 P0 回归   ← 与当前占用者协调，等其提交后立即做
            验收：tsc EXIT=0 + 点「认识」后 isTodayCheckedIn() === true

第 1 步（并行 2 条）
  ├─ A 批（1 人串行）：A1 语音手势 + A2 收尾
  │    A1：voiceGesture.ts(新) → VoiceButton/index.tsx+scss → 双路径回归
  │    A2 收尾：briefing sceneByHour 接线 → （等占用释放后）learnDetail 慢速档 + asrLang 1 行
  └─ B1 → B2（串行）：schedule.ts / memory.ts / chat 云函数 → AiAssistant / inbox

第 2 步（并行 2 条）
  ├─ C1：blocklist.ts / library
  └─ C2：price.ts / shopping / cloud.ts / data / getBriefing

第 3 步（并行 2 条，D1 可提前到与第 2 步并行）
  ├─ D1：subscription.ts / mine / legal.ts / getUsage   ← TTS 常量已就绪，不再等 A2
  └─ D2：learn.ts（streak 容错，旁路元信息方案）+ learn 页 UI   ← 必须在 T-D2-0 之后

第 4 步
  └─ T99：全量回归 + tsc EXIT=0 + 真机双端（weapp / H5）
```

### 3.3 给工程师的共享知识（3 条硬约束）

1. **`ensurePermission()` 返回 `boolean`**，不是设计文档里的 `GrantResult`。判断"是否已进入降级态"用 `isDeniedDegraded(name)`（`permission.ts:175`），判断"是否还该弹窗"用 `shouldShowDialog(name)`（`permission.ts:168`）。
2. **`startSpeak()` 是三参** `startSpeak(chunks, callbacks, opts?)`，且 **`opts.lang` 必须优先于场景表的 `lang`**（`tts.ts:278` / `tts.ts:325`），否则日韩课程会被读成中文。
3. **改 `learn.ts` 的 streak 结构时，不要动 `streak.days` 的类型**（保持 `string[]`），冻结 / 补签标记走旁路 `streakMeta`。理由：`checkInToday`(L73) / `getStreak`(L102) / `isTodayCheckedIn`(L115) 三处强依赖 `string[]`。

---

## 4. 未确认项

| 项 | 状态 | 原因 |
|---|---|---|
| `src/types/index.ts` 是否需要新增 v1.2 共享类型 | **未确认** | 该文件当前 git clean；design:71 把它列为 T00 公共文件之一，但 T00 任务表（design:1185）未含它。B1 开工时需确认 `ScheduleEvent` 等类型是否够用 |
| `deliverables/` 新增目录的内容与归属 | **未确认** | 评审范围外，未读取 |
| 3 个 tsc 错误（`LearnLangId` 未导出 / `langToTts` 未使用 / en 缺 29 个 `learn.*` key） | **已修复** | 12:10 与 12:23 两次 `tsc --noEmit -p tsconfig.json` 均为 **EXIT=0**；`langToTts` 现已在 `learnDetail/index.tsx:34` 使用；`LearnLangId` 由 `learn.ts:11` `export type { LearnLangId }` 转出；`en` 字典受 `Record<keyof typeof zh, string>`（`language.ts:398`）约束，缺 key 必报错，故 tsc 通过即证明已补齐 |
| 计划外「学习练习模式」是否有对应 PRD 需求 | **未确认** | 31 条 PRD（`prd-increment-v1.2.md`）中未见语法/听力/口语练习相关条目，疑似需求源外插入。建议 team-lead 与 PM 确认是否补需求、是否计入 v1.2 验收范围 |

---

## 5. 评审后补记（12:31 快照 · 仓库继续变化）

落盘本评审后再次 `git status`，发现 **A1 已经开工**：

| 新增/变化 | 内容 | 对上表的影响 |
|---|---|---|
| `src/utils/voiceGesture.ts`（**新，206 行**） | 已导出 `VoiceGestureState`(L14) / `VoiceGestureEvent`(L33) / `GESTURE` 常量组(L45) / `isCancelDistance`(L73) / `isDurationEnough`(L78) / `isMaxReached`(L83) / `shouldWarnRemaining`(L88) / `reduceVoiceGesture`(L121) / `overlayKey`(L175) / `VOICE_TRANSITIONS`(L186) | **A1 的纯逻辑层已完成** |
| `src/components/VoiceButton/index.tsx` | `grep "voiceGesture\|reduceVoiceGesture\|startYRef\|VOICE_"` → **空，尚未接线** | A1 剩余 = VoiceButton 接线 + scss + 麦克风权限弹窗接线 + 双路径回归 |
| `src/pages/briefing/index.module.scss` | 新增修改（应为 C-02 提示条样式） | 与 A2 收尾相关，非 A1 |

**A1 现估再下调**：`+190 / ~130 改` → **约 `+90 / ~130 改`**（`voiceGesture.ts` 的 206 行已由他人交付，A1 只剩接线层）。

> ⚠️ **但请注意 A1 现在有了新的文件争夺点**：`src/components/VoiceButton/index.tsx` 与 `src/pages/briefing/index.tsx` 同时被 A1（VoiceButton 接线）与 A2 收尾 / C-02 提示条占用。**建议 A1 与 A2 收尾明确由同一人串行完成**（见 5.2 合并建议），否则这两个文件会互相覆盖。

**重申**：本文档全程只读，未修改任何代码文件；`git status` 中新增的唯一文件是 `docs/review-outofscope-2026-09-22.md`。`tsc --noEmit` 在 12:10 / 12:23 / 12:31 三次均为 **EXIT=0**。
