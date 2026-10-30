/**
 * Service Worker —— 让重复访问不再依赖不稳定的源站（2026-10-30）
 *
 * 为什么要它：
 *   实测线上把 157 KB 的分包同一文件两次请求，一次 1.39s、一次 **18.8s**（TTFB 就 11s）；
 *   而 616 KB 的主包只要 1.0–1.7s。差距与文件大小无关 —— 是托管环境偶发卡住某个请求。
 *   网关又不给 Cache-Control，浏览器只能每次重新下载。
 *   ⇒ 砍包体治不了这个病，唯一能治的是「第二次起不再问服务器要」。
 *
 * 策略（刻意保守）：
 *   · `/js/`、`/css/` —— 文件名带内容哈希，**内容不可变**，cache-first。这是收益的主体。
 *   · 导航请求（打开页面）—— network-first，失败/超时才回落缓存。保证用户永远能拿到新版本。
 *   · `api/hotspot.json` —— stale-while-revalidate（先给旧的，后台换新的）。
 *   · 其余（`assets/wb-sdk.js` 这类**无哈希**文件、图片等）—— 直接放行，不进缓存。
 *     无哈希文件一旦被缓存就会永久钉住旧版本，这是 SW 最经典的坑。
 *
 * 版本与更新：
 *   VERSION 由构建脚本注入（取构建输入哈希）。新版本发布 → index.html 变了 →
 *   浏览器发现 sw.js 内容变了 → 装新 SW → activate 时删掉旧 cache。
 *   导航走 network-first，所以即使缓存里是旧 index.html，用户也先看到新版本。
 */

const VERSION = '__BUILD_VERSION__';
const CACHE = 'wb-shell-' + VERSION;

/** 首次安装：只预热入口 HTML，其余按需缓存（不做全量 precache，避免装到一半失败） */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.add(new Request('/', { cache: 'reload' }))).catch(() => {})
  );
  // 立刻接管，不等旧页面关闭（配合导航 network-first，不会把用户钉在旧版本）
  self.skipWaiting();
});

/** 新版本接管：删掉所有旧 cache */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

const isHashedAsset = (url) => /\/js\/[^/]+\.[0-9a-f]{8,}\.js$/.test(url.pathname)
  || /\/css\/[^/]+\.[0-9a-f]{8,}\.css$/.test(url.pathname);
const isHotspotData = (url) => url.pathname === '/api/hotspot.json';

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // ① 内容哈希资源：cache-first，命中直接返回，根本不发网络请求
  if (isHashedAsset(url)) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }))
    );
    return;
  }

  // ② 导航：network-first。用户永远先看到最新 HTML；断网时才回落缓存
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('/', copy));
          }
          return res;
        })
        .catch(() => caches.match('/').then((hit) => hit || Response.error()))
    );
    return;
  }

  // ③ 热点数据：先给缓存，同时后台更新（离线也有内容可看）
  if (isHotspotData(url)) {
    event.respondWith(
      caches.match(req).then((hit) => {
        const net = fetch(req).then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }).catch(() => hit || Response.error());
        return hit || net;
      })
    );
    return;
  }

  // ④ 其余一律不拦：无哈希文件（wb-sdk.js 等）被永久缓存比慢更糟
});
