# RSS 内容源尽调报告（2026-10-21）

## 方法论（与生产完全同口径）

- 抓取/解析**不使用自造桩**：直接由 `.tools/vet-feeds.js` 从 `.tools/static-server.js`
  （预览侧：全局 fetch、8s 超时、只认 `<item>`、只认 `pubDate`、每源 10 条、7 天新鲜度闸门）
  与 `cloudfunctions/webSearch/index.js`（云函数侧：`https.get` 仅 https、硬编码 `setEncoding('utf8')`、
  6s 超时、`<item>`/`<entry>` 均认、pubDate/updated/published、取前 12 条、7 天闸门）
  抽取同名函数源码执行，评测标准与生产逐字符一致。
- 判据四层递进：①可达性（HTTP/是否 feed）→ ②可解析（条数+标题非空）→ ③编码（UTF-8 字节合法性，
  云函数侧硬解 utf8）→ ④新鲜度（最新条目距今天数，7 天闸门，**决定性判据**）。
- 每个候选**实测两轮**（识别偶发抖动，仅两轮均通过才计入采纳）；两轮不一致的单列人工判读
  （本轮未出现）。
- feed 路径不靠猜：先 autodiscovery 读首页 `<link rel="alternate">`，拿不到再退到常见路径探测一次。
- 所有通过的源再用 WebFetch 实际抓取一次正文内容，判定语言与内容质量（写入 candidates 的 notes）。
- 判负标准不放宽：抓取失败 / 解析失败 / 非 feed / 最新条目早于 2026-09 的一律如实记为失败或陈旧。

## 类目结果

### 文化娱乐：7 / 11 通过

通过：Variety、Hollywood Reporter、Billboard、Rolling Stone、Pitchfork、Stereogum、IndieWire
（全部 en-US，两轮 10/10 存活，最新条目均为当天）。

头部行业源（Variety / Hollywood Reporter）抓取稳定、小时级更新，是类目标杆；Billboard 覆盖音乐产业
（部分正文带付费墙，标题摘要可读）；Rolling Stone 深度好但 ⚠️ feed 混有时政新闻，采纳需精选层过滤；
Pitchfork / Stereogum / IndieWire 分别补足音乐权威、独立音乐博客、独立电影评论三个维度。

失败 4 个：Deadline（两轮 >8s 超时）、Vulture（404，rss 已下线）、摩登天空（STALE，最新 34.6 天前）、
国家大剧院（200 但无 feed）。**结论：文化娱乐类目质量由头部英文行业源完全撑起，中文候选（国家大剧院、
摩登天空）均不可用，"国产文化源"缺口依旧，与 2026-09-28 得出的"中文垂直媒体已大面积下线 RSS"一致。**

### 科学/天文/食品营养：11 / 12 通过

通过：NASA 新闻发布、NASA 快讯、Scientific American、Science News、ScienceDaily、Phys.org、
Space.com、EarthSky、Smithsonian、环球科学、NutritionFacts.org。

官方一手源（NASA 两个 feed）权威性最高且小时级更新；老牌科普（SciAm / Science News / Smithsonian）
深度好；聚合源（ScienceDaily / Phys.org）时效极高但深度参差，作广度补充。**环球科学是本轮唯一通过的
中文科学源（约日更，前次记录的"半月更"已改善），但 10 条仅 5 条存活，低频风险仍在。**

失败 1 个：Nature（nature.rss 是 RSS 1.0/RDF 结构，生产解析器把 `<items>` 资源容器当 `<item>` 抽出，
标题恒空——生产里就是空白卡片，与权威性无关，属结构不兼容）。

### 环境/自然/气候/动物：3 / 12 通过

通过：NASA Science（science.nasa.gov 全站 feed，替补覆盖 climate）、中外对话（已迁移 dialogue.earth）、
Yale Environment 360。

这是本轮最惨烈的子池：**12 个候选 9 个失败**。官方组织中，WWF / 中外对话（旧域首页）/ NIH 类站点
对生产 UA 一律 403，UNEP / NatGeo / NASA Climate（旧路径）/ Harvard Health 已 404；
Guardian 环境与 BBC 两轮 >8s 超时且复核轮直接连接失败（跨境网络不可达，非体积问题）；
ZooBorns 已停更 420.8 天；WHO 虽权威但 feed 最新条目 10.87 天前，超 7 天闸门。
动物（animals）子类**全军覆没**——ZooBorns 停更、NatGeo 404、无其他可用候选。

中外对话是边缘通过（最新 5.47 天前、10 条仅 3 条存活，踩 7 天闸门边缘），且内容涉环境政策报道，
采纳需走 [audit] 与信任过滤；Yale E360 一周约 3-4 更，深度好但条数少。

### 健康/心理/运动科学：4 / 13 通过

通过：Psychology Today、Runner's World、Outside、Men's Health。

心理类由 Psychology Today（持证专家博客聚合，每日 15-20 篇）独立撑起——APA（404）、Verywell Mind
（402）、NIH 双 feed（403 全站反爬）全部不可用；健康官方源颗粒无收（NIH/WHO/NHS/Harvard Health 全军覆没，
项目现有"健康"类目实际只能靠科普/杂志型源）。运动科学由 Hearst 旗下 Runner's World / Men's Health +
Outside 覆盖，⚠️ Outside 含装备联盟营销内容需过滤。

## 失败原因分布（48 个候选，23 个失败）

| 失败原因 | 数量 | 明细 |
|---|---|---|
| HTTP 403（官网反爬） | 6 | WWF、Mongabay、IFLScience、Inside Climate News、NIH 新闻、NIH News in Health |
| HTTP 404（feed 路径失效/下线） | 7 | Vulture、NASA Climate(旧路径)、UNEP、National Geographic、ScienceDaily 健康(slug)、Harvard Health、APA |
| HTTP 402（反爬拦截） | 1 | Verywell Mind |
| TIMEOUT（>8s） | 3 | Deadline、Guardian 环境、BBC 科学与环境 |
| STALE（冻结源） | 3 | 摩登天空(34.6 天)、WHO(10.87 天)、ZooBorns(420.8 天) |
| 200 但非 feed | 2 | 国家大剧院（HTML）、NHS（202 空响应） |
| 结构不兼容 | 1 | Nature（RSS 1.0/RDF，生产解析器标题恒空） |

## 采纳清单速览

- 文化娱乐 7 源 → `culture-out.json`
- 科学大类 18 源 → `science-out.json`（science 7 / astronomy 3 / food 1 / environment 2 / climate 1 / health 1 / psychology 1 / sports 2，NASA Science 与 Physics 类源存在子类重叠，组装时按 tag 去重）
- 中文源仅 1 个通过（环球科学）；果壳/丁香园等本轮未再送测（2026-09-28 已实测确认无 feed，
  果壳内容已由 DailyHotApi `/guokr` 板块覆盖，豆瓣影视由 `/douban-movie` 板块覆盖）

## 维护建议（防回填，可直接抄进源清单注释）

勿再添加/勿回填：Deadline（超时）、Vulture（404）、Nature（RDF）、WWF/UNEP/Mongabay/IFLScience/
Inside Climate News（403）、National Geographic/NASA Climate 旧路径/ScienceDaily 健康 slug/Harvard Health/APA（404）、
Guardian 环境/BBC（跨境超时）、WHO（10.87 天陈旧）、ZooBorns（停更）、Verywell Mind（402）、
国家大剧院/NHS（非 feed）。

## 顺带发现（非本轮交付范围，仅供决策）

1. 自检生产源清单时发现 **芥末堆本轮单次 8755ms**，已超过云函数侧 6s 上限（预览侧 8s 内），
   连续 2 次失败会进 30 分钟冷却——已上线源的超时隐患，建议后续复跑 `npm` 无此脚本时手动执行
   `node .tools/vet-feeds.js` 观察。
2. 什么值得买（此前 2026-10-13 记录返回 HTML 落地页）本轮两轮均正常解析出 10 条，疑已恢复或间歇性。
