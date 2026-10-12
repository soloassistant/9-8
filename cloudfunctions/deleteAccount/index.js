const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

/** 注销账号：删除用户全部数据（F18 合规硬门槛） */
exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) throw new Error('no openid');

  // 注销范围（F18 合规硬门槛）：必须覆盖**所有**按 openid 存储用户数据的集合，漏一个
  // 就等于「已注销」的用户数据仍留在云端。以下集合逐一对照 cloudfunctions/ 下
  // `db.collection(...)` 的实际写入点确认过，均含 openid 字段：
  //   users      login / getUsage / updateSettings / webSearch
  //   events     confirmItem / chat
  //   todos      confirmItem / chat
  //   items      confirmItem / getUsage
  //   briefings  getBriefing（定时 + 首次打开落库）
  //   usage      chat / getUsage / webSearch（LLM 额度账本）
  //   shopping   chat / getBriefing
  //   orders     createOrder
  //   user_prefs    chat savePrefs / getPrefs
  //   user_affinity chat saveAffinity / getAffinity
  //   newsFeedback  webSearch feedback
  //   history    早期版本遗留，当前无写入点；保留以清理历史存量，集合不存在时忽略
  const collections = [
    'users',
    'events',
    'todos',
    'items',
    'briefings',
    'usage',
    'shopping',
    'orders',
    'user_prefs',
    'user_affinity',
    'newsFeedback',
    'history'
  ];
  // ⚠️ 2026-10-12 修：原来 catch 只 console.warn 就继续，末尾**无条件** `return { code: 0,
  // data: { deleted: true } }` —— 于是任何真实失败（权限被拒 / 超时 / 单集合写入失败）都会被
  // 报告成「已删除全部」。实测：令 orders 访问抛权限错误时，用户的 3 条订单原样保留，
  // 接口仍返回 deleted:true。**这比抛错更糟 —— 用户会以为《隐私政策》承诺的「删除全部数据」完成了。**
  //
  // 但也不能简单地「有 catch 就算失败」：collections 里的 `history` 是早期版本遗留集合，
  // 多数用户根本没有这个集合，那样会让所有老用户都看到「注销失败」。
  // 所以必须**区分「集合不存在」与「真实错误」**，且认不出的错误一律按真实失败处理
  // （宁可多报一次失败，也不能把还在的数据说成已删）。
  const isCollectionMissing = (err) => {
    const code = err && (err.errCode || err.code);
    const msg = String((err && err.message) || err || '');
    return code === -502005 || /collection not exist|集合不存在|not exists/i.test(msg);
  };

  let deleted = 0;
  const failed = [];
  for (const name of collections) {
    try {
      const res = await db.collection(name).where({ openid: OPENID }).remove();
      deleted += (res.stats && res.stats.removed) || 0;
    } catch (err) {
      if (isCollectionMissing(err)) {
        // 集合尚未创建 = 本来就没有数据可删，不算失败
        console.info(`[deleteAccount] collection ${name} not exists, skipped`);
        continue;
      }
      console.error(`[deleteAccount] collection ${name} remove FAILED:`, err && err.message);
      failed.push(name);
    }
  }

  console.info(
    `[deleteAccount] openid=${OPENID} removed=${deleted} failed=${failed.join(',') || 'none'}`
  );
  if (failed.length) {
    // 如实报告部分失败；客户端 services/cloud.ts:313 会把 code!==0 抛成异常 → 页面显示「注销失败」
    return {
      code: -1,
      message: `部分数据删除失败：${failed.join(',')}`,
      data: { deleted: false, removed: deleted, failed }
    };
  }
  return { code: 0, data: { deleted: true, removed: deleted } };
};
