/**
 * 订阅消息模板 id 集中配置（上线三件事 · 前端侧）。
 *
 * 获取路径：微信公众平台（mp.weixin.qq.com）→ 功能 → 订阅消息 → 「选用模板」→
 * 选「一次性订阅」类型的模板 → 复制模板 id（形如 xxxxxxxxxxxxxxxxxx-xxxx）→ 粘贴到下方。
 *
 * 注意：云函数 getBriefing 侧通过环境变量 SUBSCRIBE_TEMPLATE_ID 读同一个 id，
 * 两处必须填同一个值（详见 docs/云函数部署指南.md 的「订阅消息模板 id 配置」一节）。
 *
 * 空串 = 未配置：promptSubscribe 对空串直接 noop（不弹窗、不计入统计），不影响现有行为。
 */
export const SUBSCRIBE_TEMPLATE_ID = '';
