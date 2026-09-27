// 校验新增源（爱范儿/极客公园/钛媒体）的来源标注准确性：
// 1) 聚合接口中各源条目的链接域名是否匹配该源官网 2) 标题是否真的出现在该源 RSS 原文里
const FEEDS = {
  爱范儿: 'https://www.ifanr.com/feed',
  极客公园: 'https://www.geekpark.net/rss',
  钛媒体: 'https://www.tmtpost.com/feed/'
};
const DOMAIN = { 爱范儿: 'ifanr.com', 极客公园: 'geekpark.net', 钛媒体: 'tmtpost.com' };

function clean(s) {
  return (s || '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
async function get(u) {
  const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}

(async () => {
  const agg = await get('http://localhost:8137/api/hotspot').then((x) => JSON.parse(x));
  for (const [name, feed] of Object.entries(FEEDS)) {
    console.log('\n===== ' + name + ' =====');
    const raw = await get(feed);
    const rawTitles = new Set(
      (raw.match(/<item>[\s\S]*?<\/item>/g) || [])
        .map((b) => clean((b.match(/<title>([\s\S]*?)<\/title>/) || [])[1]))
        .filter(Boolean)
    );
    const items = agg.items.filter((it) => it.source === name);
    let domainOk = 0, titleOk = 0, domainBad = [];
    for (const it of items) {
      const url = String(it.url || '');
      if (url.includes(DOMAIN[name])) domainOk++; else domainBad.push(url.slice(0, 60));
      if (rawTitles.has(it.title)) titleOk++;
    }
    console.log(`聚合接口标注 ${name} 的条目: ${items.length}`);
    console.log(`链接域名匹配 ${DOMAIN[name]}: ${domainOk}/${items.length}${domainBad.length ? '  异常: ' + domainBad.join(' ; ') : ''}`);
    console.log(`标题能在源 RSS 原文找到: ${titleOk}/${items.length}`);
    for (const it of items.slice(0, 2)) console.log('  样本: 《' + it.title.slice(0, 26) + '》 ' + String(it.url).slice(0, 55));
  }
})();
