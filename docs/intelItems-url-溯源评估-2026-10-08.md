# `intelItems` 补 `url` 溯源 —— 评估报告

> 日期：2026-10-08　　状态：**仅评估，未改代码**（按交接单要求不动冻结类型）
> 关联：`cloudfunctions/webSearch/index.js`、`src/types/index.ts`、`src/utils/intelGroups.ts`、`src/pages/briefing/index.tsx`

---

## 一、结论先说

**这是个划算的小改动，但有一条路径做不到，必须明确取舍。**

- 免费档 / 订阅降级档（`fallbackIntel`）→ **可以补 `url`，改动小、无风险**
- 订阅档正常 LLM 摘要（`summarize`）→ **补不了**，除非让 LLM 自己吐 URL，而那会引入幻觉链接

建议只做前者，后者保持现状并在下文案上区分。

---

## 二、现状：UI 已经预留了入口，只是没有可点的东西

这是最关键的事实——**前端早就在做"引用"这件事了，只差数据**：

`src/pages/briefing/index.tsx`

| 行 | 内容 |
|---|---|
| 1136 | `citeHint={t('briefing.intelCiteHint')}` — 文案「查看引用来源」 |
| 1137 | `onCiteClick={(itemIndex) => handleCiteClick(gi, itemIndex)}` |
| 767-777 | `handleCiteClick` → `Taro.showModal({ content: \`${ref.text}\n\n来源：${ref.source}\` })` |

所以现在用户点「查看引用来源」，得到的是**一段纯文本弹窗**，没有任何链接。

`src/utils/intelGroups.ts:58` 的 `IntelSourceRef` 只有 `{ text, source }`，`normalizeRef`（:123）也只取这两个字段 —— **即使云端下发了 `url`，前端也会静默丢掉**。

对照 `HotspotNews`（`src/types/index.ts:159`）**本来就带 `url`**，且热点页已在用。也就是说 URL 在「抓取 → 缓存」这一段是有的，**是在 `fallbackIntel` 拼装 `intelItems` 时被丢弃的**。

---

## 三、要改哪些地方（最小改动集）

| # | 位置 | 改动 | 风险 |
|---|---|---|---|
| 1 | `webSearch/index.js` `fallbackIntel()` | 返回值加 `url: n.url` | 无。`fallbackIntel` 收到的 `newsItems` 就是 `toNews()` 的产物，**本来就带 `url`** |
| 2 | `types/index.ts` `BriefingIntel.intelItems` | 加 `url?: string` | **低**。可选字段 = 纯增量；旧前端不读它照样跑 |
| 3 | `intelGroups.ts` `IntelSourceRef` | 加 `url?: string` | 无 |
| 4 | `intelGroups.ts` `normalizeRef()` | 透传 `url`，**并校验** | 需注意：这是信任边界，见下 |
| 5 | `briefing/index.tsx` `handleCiteClick` | 有 `url` 时改为打开链接，否则回退原弹窗 | 无 |

**双端契约风险评估：低。** `url` 是可选字段且只增不改：

- 小程序端与 H5 端共用同一份 `BriefingIntel` 定义，任一端先升级都不会因缺字段而崩
- `normalizeRef` 对缺 `url` 的条目必须**保留该条目**而不是整条丢弃 —— 否则一条没 url 的资讯会凭空消失
- 旧的缓存数据（`hotspotCache` 里的历史记录）没有 `url`，走同一套透传逻辑时自然为空，前端回退到纯文本弹窗即可

### 3.1 `normalizeRef` 的 URL 校验必须加

`normalizeRef` 是信任边界：云端返回的 `url` 会直接进 `Taro.setClipboardData` 或外链打开。

**必须校验**（参照 `cloudAuth` 对 `CLOUD_ENDPOINT` 的处理思路——不信任任何外部输入）：

- 只接受 `http:` / `https:`；`javascript:` / `data:` / `file:` 一律丢弃
- 长度上限（与 `text` 同样做 `clampText` 截断）
- 非法值**降级为 `undefined`**，保留条目本身

---

## 四、做不到的那条路径：LLM 摘要

`summarize()`（`webSearch/index.js:723`）把 `ranked` 喂给 LLM，要求返回 `{ text, source }[]`，然后：

```js
.map((it) => ({ text: clampByCodePoint(it.text, INTEL_ITEM_TEXT_MAX), source: String(it.source || '综合') }))
```

**`url` 在这里被丢弃，而且补不回来。** 原因：

1. LLM 会对条目**重排、合并、改写**，返回的 item 与输入的 `ranked` **不是 1:1**，无法按下标回填
2. 让 LLM 自己输出 URL → **幻觉链接**。用户点进去是死链或钓鱼站，而这是「可信信息」类产品，代价远高于少一个链接

**建议**：LLM 路径保持无 `url`，前端在无 `url` 时回退纯文本弹窗（现有行为）。不要为了「每条都有链接」而去 prompt LLM 生成 URL。

---

## 五、收益评估

| 维度 | 评估 |
|---|---|
| 用户价值 | 中。竞品（Perplexity / NotebookLM / 豆包）都能点原文，我们只能看文字，**可信度感知上有差距** |
| 合规价值 | **中**。当前「来源：量子位」只显示媒体名，用户无法自行核验原文；补 `url` 后可核验，对「AI 生成内容需可溯源」的监管口径是正向的 |
| 改动成本 | **低**。5 处，其中 3 处是一行 |
| 风险 | 低（前提是 §3.1 的 URL 校验做了） |

---

## 六、建议执行顺序

1. 先做 `fallbackIntel` 加 `url` + `normalizeRef` 透传与校验（免费档立刻可用，零风险）
2. 再做 `handleCiteClick` 分支（有链接开链接，无链接回退弹窗）
3. `types/index.ts` 的可选字段**与前端同一次提交**，不要只改一边

---

## 七、明确不做

- ❌ 不改 `summarize` 的 prompt 去让 LLM 生成 URL（幻觉风险，见 §四）
- ❌ 不把 `url` 设为必填（旧缓存会全线失效）
- ❌ 不在 `normalizeRef` 里因 `url` 非法而丢弃条目
