/**
 * mutations-live-bridge.mjs —— 「线上 H5 通路」门禁的变异用例（2026-10-30）
 *
 * 背景：2026-10-30 线上实测发现「H5 端一次带倒 4 个功能」——
 * `invoke('webSearch')` 打的应用数据库里**根本不存在的** PG 函数（404 PGRST202），
 * 而它一直在 `dataSource.ts` 的 RPC_ALLOWLIST 里。每一次调用都是一发注定 404 的请求，
 * 还会把「webSearch」登记进降级表 ⇒ 热点页顶部亮出「当前为本地演示数据」，
 * 而页面上是 **412 条真实 RSS**（反向谎言）。
 *
 * 配套修的三条数据侧问题（配图 0% / 视频只有小程序能看到 / alsoFrom 7 条全是假信号）
 * 也在这道门禁里钉住。
 *
 * 每条变异都对应一种**真实退化**，且都必须让 `verify:live-bridge` 变红。
 * 特别提醒：判据如果只查「某个标识符还在」，把它改成「还在但不生效」的写法就能蒙混过关 ——
 * 所以下面第 2、3、8、11 条专门打这种假判据。
 */
export default [
  {
    label: '把 webSearch 放回 RPC_ALLOWLIST（应用库无此 PG 函数 ⇒ 每页白发一发 404）',
    file: 'src/services/dataSource.ts',
    from: "const RPC_ALLOWLIST = new Set(['chat', 'extract'])",
    to: "const RPC_ALLOWLIST = new Set(['webSearch', 'chat', 'extract'])",
    cmd: 'node .tools/verify-live-bridge.mjs'
  },
  {
    label: '白名单闸被短路（`if (false)` —— 未放行的名字也会发网络请求）',
    file: 'src/services/dataSource.ts',
    from: 'if (!RPC_ALLOWLIST.has(name)) {',
    to: 'if (false) {',
    cmd: 'node .tools/verify-live-bridge.mjs'
  },
  {
    label: 'apiVideoNews 的 H5 早退分支被反向（H5 落回必败的 rpc，板块又变成永不渲染）',
    file: 'src/services/api.ts',
    from: "export async function apiVideoNews(): Promise<HotspotNews[]> {\n  if (!isWeapp) {",
    to: "export async function apiVideoNews(): Promise<HotspotNews[]> {\n  if (isWeapp) {",
    cmd: 'node .tools/verify-live-bridge.mjs'
  },
  {
    label: 'apiGetVideoNews 的 H5 早退分支被摘掉（晨报页视频卡片又回到永不渲染）',
    file: 'src/services/api.ts',
    from: "export async function apiGetVideoNews(): Promise<VideoNewsItem[]> {\n  if (!isWeapp) {",
    to: "export async function apiGetVideoNews(): Promise<VideoNewsItem[]> {\n  if (false) {",
    cmd: 'node .tools/verify-live-bridge.mjs'
  },
  {
    label: '视频 url 退回 b23.tv 短链（前端白名单只认 bilibili.com/video/BV… ⇒ 视频被整条丢弃）',
    file: '.tools/fetch-data.js',
    from: "      url: 'https://www.bilibili.com/video/' + bvid,",
    to: '      url: it.url,',
    cmd: 'node .tools/verify-live-bridge.mjs'
  },
  {
    label: 'B站条目不再带封面（热点列表与视频卡片的图全空）',
    file: '.tools/boards-core.js',
    from: '      image: pic,',
    to: "      image: '',",
    cmd: 'node .tools/verify-live-bridge.mjs'
  },
  {
    label: '抽图少了一路（media:content）⇒ 带图覆盖悄悄掉一截',
    file: '.tools/fetch-data.js',
    from: '<media:content[^>]*url=',
    to: '<media:contentX[^>]*url=',
    cmd: 'node .tools/verify-live-bridge.mjs'
  },
  {
    // 2026-10-30：上面那条变异第一版是 NOT-CAUGHT —— 因为 C2 判的是
    // `includes('media:content')`，改成 `media:contentX` 之后子串还在 ⇒ 照样绿。
    // 补了行为层断言（C2b：真求值 pickImage，每路只给一个只含该路的块）之后才抓住。
    // 这一条再打「另一路」：enclosure 的「url 在 type 前」那种写法，
    // 源码里那句正则改一个字就会让一半 enclosure 源抽不到图。
    label: '抽图的 enclosure 路只认「type 在 url 前」（另一半 enclosure 源抽不到图）',
    file: '.tools/fetch-data.js',
    from: "/<enclosure[^>]*url=[\"']([^\"']+)[\"'][^>]*type=[\"'][^\"']*image/i",
    to: "/<enclosureXX[^>]*url=[\"']([^\"']+)[\"'][^>]*type=[\"'][^\"']*image/i",
    cmd: 'node .tools/verify-live-bridge.mjs'
  },
  {
    label: '机构表漏登记 NASA Science（同一家 NASA 的两个 feed 被当成两家媒体 ⇒ alsoFrom 假信号）',
    file: 'cloudfunctions/webSearch/cross-source.js',
    from: "  'NASA Science': 'NASA',",
    to: "  'NASA Science': 'NASA Science',",
    cmd: 'node .tools/verify-live-bridge.mjs'
  },
  {
    label: '降级横幅失去页面粒度（A 页的降级又会把横幅带到 B 页 ⇒ 真实数据被说成演示数据）',
    file: 'src/components/DemoDataHint/index.tsx',
    from: 'scope.indexOf(a) >= 0',
    to: 'true',
    cmd: 'node .tools/verify-live-bridge.mjs'
  },
  {
    label: '热点页不声明自己的 actions（横幅又变成全局的）',
    file: 'src/pages/library/index.tsx',
    from: "<DemoDataHint actions={['webSearch', 'getHotspot']} />",
    to: '<DemoDataHint />',
    cmd: 'node .tools/verify-live-bridge.mjs'
  },
  {
    label: 'AI 精选提示词两端漂移（前端改了一处没改云函数 ⇒ 两端口径不一致）',
    file: 'src/services/cloud.ts',
    from: '最多输出 20 条。',
    to: '最多输出 21 条。',
    cmd: 'node .tools/verify-live-bridge.mjs'
  },
  {
    label: '热点载荷把远端排到同源前面（首屏又变成一次跨域 + 一次 404 往返）',
    file: 'src/services/cloud.ts',
    from: 'const same = await fetchHotspotJson(SAME_ORIGIN_HOTSPOT_URL)',
    to: 'const same = await fetchHotspotJson(LIVE_HOTSPOT_URL)',
    cmd: 'node .tools/verify-live-bridge.mjs'
  }
];
