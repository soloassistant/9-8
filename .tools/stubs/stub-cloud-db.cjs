// cloudDb 的最小复刻：按 owner 隔离的 user_kv（服务端「新者赢」语义）。
// 行数据挂在 globalThis.__CLOUD_DB__，供 harness 断言「B 的 user_kv 没有 A 的 key」。
var DB = (globalThis.__CLOUD_DB__ = globalThis.__CLOUD_DB__ || { rows: {}, calls: [] });

function owner() {
  var s = globalThis.__CLOUD_SESSION__;
  return s && s.user && s.user.id;
}

module.exports = {
  kvGetAll: function () {
    if (globalThis.__KV_FAIL__) return Promise.resolve(null);
    var o = owner();
    if (!o) return Promise.reject(new Error('no session'));
    DB.fullReads = (DB.fullReads || 0) + 1;
    var bucket = DB.rows[o] || {};
    return Promise.resolve(
      Object.keys(bucket).map(function (k) {
        return { key: k, value: bucket[k].value, clientTs: bucket[k].clientTs };
      })
    );
  },
  kvGetVersions: function () {
    if (globalThis.__KV_FAIL__) return Promise.resolve(null);
    var o = owner();
    if (!o) return Promise.reject(new Error('no session'));
    DB.versionReads = (DB.versionReads || 0) + 1;
    var bucket = DB.rows[o] || {};
    return Promise.resolve(
      Object.keys(bucket).map(function (k) {
        return { key: k, clientTs: bucket[k].clientTs };
      })
    );
  },
  kvSetMany: function (items) {
    if (globalThis.__KV_FAIL__) return Promise.resolve(null);
    var o = owner();
    if (!o) return Promise.resolve(null);
    DB.rows[o] = DB.rows[o] || {};
    var written = 0;
    items.forEach(function (it) {
      var cur = DB.rows[o][it.key];
      if (!cur || it.ts > cur.clientTs) {
        DB.rows[o][it.key] = { key: it.key, value: it.value, clientTs: it.ts };
        written++;
      }
    });
    DB.calls.push({ owner: o, keys: items.map(function (i) { return i.key; }) });
    // 供「推送过程中账号被切换」用例：写入成功后触发一次会话变化
    if (typeof globalThis.__KV_AFTER_WRITE__ === 'function') {
      var fn = globalThis.__KV_AFTER_WRITE__;
      globalThis.__KV_AFTER_WRITE__ = null;
      fn();
    }
    return Promise.resolve(written);
  }
};
