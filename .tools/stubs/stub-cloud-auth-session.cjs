// cloudAuth 会话/数据库桩（A-1 门禁用）：只暴露 subscription 用到的两个读取入口。
module.exports = {
  getSession: async function () {
    return globalThis.__SESSION__ || null;
  },
  getCloudDatabase: async function () {
    return globalThis.__DB__ || null;
  }
};
