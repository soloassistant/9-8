/**
 * mutations-boot-path.mjs —— 首屏关键路径门禁的变异用例（2026-10-30）
 *
 * 背景：2026-10-30 线上实测「用户打开页面 30 秒还卡在骨架屏」。根因是
 * 「投递侧单请求首字节长尾（20–31 秒）」×「我们自己的 defer 链把第三方 SDK
 * 串在主包前面」两件事叠加。这道门禁守的就是第二件事，以及骨架不许再撒谎。
 *
 * 每条变异都对应一种**真实退化**，且都必须让 `verify:boot-path` 变红。
 * 特别提醒：判据如果只查「某个标识符/字符串还在」，那么把它改成
 * `if (false && inBoot)` / `is-stall-x` 这类「还在但不生效」的写法就能蒙混过关 ——
 * 所以下面第 6、7、9、10 条专门打这种假判据。
 */
export default [
  {
    label: 'SDK 被放回 defer 链（SDK 一卡，整个应用卡住 —— 实测 30 秒起）',
    file: 'src/index.html',
    from: '<script async src="./assets/wb-sdk.js"></script>',
    to: '<script defer src="./assets/wb-sdk.js"></script>',
    cmd: 'node .tools/verify-boot-path.mjs'
  },
  {
    label: 'SDK 去掉 async（退化回同步阻塞：下载完才执行）',
    file: 'src/index.html',
    from: '<script async src="./assets/wb-sdk.js"></script>',
    to: '<script src="./assets/wb-sdk.js"></script>',
    cmd: 'node .tools/verify-boot-path.mjs'
  },
  {
    label: 'SDK 被换成外部 CDN（大陆被墙 ⇒ window.WorkBuddyCloud 永不定义）',
    file: 'src/index.html',
    from: 'src="./assets/wb-sdk.js"',
    to: 'src="https://cdn.jsdelivr.net/npm/wb-sdk.js"',
    cmd: 'node .tools/verify-boot-path.mjs'
  },
  {
    label: 'SDK 卡住时的重注入兜底被摘掉（长尾命中就只能干等 8 秒后报错）',
    file: 'src/services/cloudAuth.ts',
    from: "  const el = document.createElement('script');",
    to: '  const el = null as unknown as HTMLScriptElement;',
    cmd: 'node .tools/verify-boot-path.mjs'
  },
  {
    label: 'SDK 重试去掉 cache-busting（重试又命中同一个被缓存的坏响应）',
    file: 'src/services/cloudAuth.ts',
    from: "  el.src = src + (src.includes('?') ? '&' : '?') + 'r=' + Date.now();",
    to: '  el.src = src;',
    cmd: 'node .tools/verify-boot-path.mjs'
  },
  {
    label: '启动期豁免被短路（`if (false && inBoot)` —— 整页重载又回来了）',
    file: 'src/app.tsx',
    from: 'if (inBoot) {',
    to: 'if (false && inBoot) {',
    cmd: 'node .tools/verify-boot-path.mjs'
  },
  {
    label: '启动期分支被改成别的条件（不再拦住整页重载）',
    file: 'src/app.tsx',
    from: 'if (inBoot) {',
    to: 'if (neverHappens) {',
    cmd: 'node .tools/verify-boot-path.mjs'
  },
  {
    label: '骨架不再报真实下载进度（退回只会转圈的假进度）',
    file: 'src/assets/boot-skeleton.html',
    from: "performance.getEntriesByType('resource')",
    to: "performance.getEntriesByType('navigation')",
    cmd: 'node .tools/verify-boot-path.mjs'
  },
  {
    label: '「卡住」态加了但不会真的加上（classList.add 改名字）',
    file: 'src/assets/boot-skeleton.html',
    from: "skel.classList.add('is-stall');",
    to: "skel.classList.add('is-stall-x');",
    cmd: 'node .tools/verify-boot-path.mjs'
  },
  {
    label: '「失败」态加了但不会真的加上（classList.add 改名字）',
    file: 'src/assets/boot-skeleton.html',
    from: "skel.classList.add('is-fail');",
    to: "skel.classList.add('is-fail-x');",
    cmd: 'node .tools/verify-boot-path.mjs'
  },
  {
    label: '骨架的重试去掉 cache-busting（重试绕不开被缓存的坏响应）',
    file: 'src/assets/boot-skeleton.html',
    from: "'r='+Date.now()",
    to: "'r='",
    cmd: 'node .tools/verify-boot-path.mjs'
  },
  {
    label: '骨架里又写回 id="app"（产物出现两个 id ⇒ 滚到底整屏空白）',
    file: 'src/assets/boot-skeleton.html',
    from: '<div class="bs-prog">正在下载页面资源…</div>',
    to: '<div class="bs-prog" id="app">正在下载页面资源…</div>',
    cmd: 'node .tools/verify-boot-path.mjs'
  }
];
