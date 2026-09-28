// 直接调用 DailyHotApi 各 route 的 handleRoute 来验证板块可用性 —— 不启 HTTP 服务、不占端口。
//
// 为什么可以这样做：每个 route 文件都 `export const handleRoute = ...`，只依赖第一个参数的
// `c.req.query()`（部分板块连这个都不用，形如 `async (_: undefined, noCache) => ...`）。
// 给一个只实现 `req.query()` 的假 ctx 就能拿到该板块的真实处理结果，**等价于请求 /weibo 等端点**，
// 但不引入常驻进程、不占端口。
//
// 断言两条（都是硬门槛）：
//   1) 每个板块条数 > 0
//   2) 每个板块耗时 < 8000ms
// 第 2 条尤其不能放宽：static-server.js 的 fetchText 超时就是 8000ms，超了等于上线即失败。
// （实测教训：GitHub Trending 返回 200 且有 9 条，但单次 11.8s，正是被这条挡掉才没被误采纳。）
//
// 本文件不直接跑，由 .tools/verify-boards.js 用 DailyHotApi 自带的 tsx 包装调用：
//   tsx --tsconfig <DailyHotApi>/tsconfig.json .tools/board-probe.ts   （cwd 必须是 DailyHotApi）

// routes 基路径按本文件位置推导，避免硬编码盘符
const BASE = new URL('./DailyHotApi/src/routes/', import.meta.url).href;

/** fetchText 的超时上限：超过即上线必失败 */
const MAX_MS = 8000;

/** 当前生产注册的全部 9 个板块（见 .tools/static-server.js 的 hotBoard 清单） */
const ROUTES: Array<[string, string]> = [
  ['weibo', '微博热搜'],
  ['zhihu', '知乎热榜'],
  ['baidu', '百度热点'],
  ['douyin', '抖音热点'],
  ['bilibili', 'B站热榜'],
  ['hellogithub', 'HelloGitHub'],
  ['guokr', '果壳'],
  ['dgtle', '数字尾巴'],
  ['douban-movie', '豆瓣电影'],
];

interface ProbeResult {
  name: string;
  label: string;
  ok: boolean;
  count?: number;
  titles?: string[];
  ms?: number;
  reason?: string;
}

/** 假的最小 ctx：路由只在需要时读 req.query()，其余（env/json）给占位 */
function fakeCtx() {
  return { req: { query: () => undefined }, env: {}, json: (x: unknown) => x };
}

async function probe(name: string, label: string): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    const mod = await import(BASE + name + '.ts');
    const fn = mod.handleRoute || mod.default;
    if (typeof fn !== 'function') {
      console.log(`  ${label.padEnd(11)} ${name.padEnd(15)} ✗ 未导出 handleRoute`);
      return { name, label, ok: false, reason: 'no handleRoute' };
    }
    // 只传假 ctx，不传 noCache —— 与参考做法（.tmp-verify/diverse-verify.ts）一致。
    // 注意不要传 noCache=true：那会走 DailyHotApi 的 delCache()，在 Redis 不可达时
    // `redis.del` 要重试 5 次 × 2s 退避 ≈ 9s，这段与上游无关的停滞会把 8000ms 门槛读数污染成假失败。
    // 不传 noCache 时每个 route 在本进程内仍是首次调用（NodeCache 无旧值）→ 依然真实打上游。
    const out = await fn(fakeCtx());
    const list = Array.isArray(out?.data) ? out.data : [];
    const titles = list.slice(0, 3).map((d: { title?: string; name?: string }) =>
      String(d?.title || d?.name || '').slice(0, 24));
    const ms = Date.now() - t0;
    const countOk = list.length > 0;
    const timeOk = ms < MAX_MS;
    const ok = countOk && timeOk;
    const flag = ok ? '✓' : '✗';
    const why = ok ? '' : (countOk ? ` 超时(≥${MAX_MS}ms)` : ' 条数为 0');
    console.log(`  ${label.padEnd(11)} ${name.padEnd(15)} ${flag} 条数=${String(list.length).padEnd(4)} ${String(ms).padEnd(6)}ms${why}  ${titles.join(' | ')}`);
    return { name, label, ok, count: list.length, titles, ms };
  } catch (e) {
    const ms = Date.now() - t0;
    const reason = String((e && e.message) || e).slice(0, 160);
    console.log(`  ${label.padEnd(11)} ${name.padEnd(15)} ✗ 失败 ${ms}ms — ${String(reason).slice(0, 110)}`);
    return { name, label, ok: false, ms, reason };
  }
}

(async () => {
  console.log('[boards] 直接调用 route 处理函数验证板块（不启服务、不占端口）：\n');
  const results: ProbeResult[] = [];
  // 串行执行：避免同时打爆多个上游，也让耗时读数可信
  for (const [name, label] of ROUTES) results.push(await probe(name, label));

  const okList = results.filter((r) => r.ok);
  console.log('\n可用: ' + okList.length + '/' + results.length);

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log('失败明细（条数必须 >0，耗时必须 <' + MAX_MS + 'ms）：');
    for (const r of failed) {
      const why = r.reason ? r.reason : (r.count === 0 ? '返回 0 条' : `耗时 ${r.ms}ms ≥ ${MAX_MS}ms`);
      console.log('  ✗ ' + r.name + ' — ' + why);
    }
  }

  console.log('\nJSON=' + JSON.stringify(results));
  process.exit(failed.length ? 1 : 0);
})();
