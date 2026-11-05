// entitlement 桩：A-1 门禁只测订单写入路径，不需要真权益回放（且避免把整条依赖链卷进来）。
module.exports = {
  refreshEntitlement: async function () {
    return { active: false, expiredAt: null, source: 'none' };
  }
};
