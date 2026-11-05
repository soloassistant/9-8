// 变异用例：退款幂等 R4（harness: .tools/verify-funds-idempotency.mjs）
// 每个 case 的 from 都必须在目标文件里**正好出现一次**（工具会断言）。
export default [
  {
    label: '确定性派生改回随机数（重试可能打第二笔）',
    file: 'cloudfunctions/refundOrder/index.js',
    from: `  return \`R\${safe}-\${String(attempt).padStart(2, '0')}\`.slice(0, 64);`,
    to: "  return `refund_${safe}_${Date.now()}`;",
    cmd: 'node .tools/verify-funds-idempotency.mjs'
  },
  {
    label: '去掉「调用前落库」（并发会同时发起）',
    file: 'cloudfunctions/refundOrder/index.js',
    from: "    await db.collection(ATTEMPTS).add({ data: Object.assign({ _id: meta.refundNo }, meta) });",
    to: "    void meta.refundNo;",
    cmd: 'node .tools/verify-funds-idempotency.mjs'
  },
  {
    label: '删掉「仅支持全额退款」判断（部分退款被静默按全额执行）',
    file: 'cloudfunctions/refundOrder/index.js',
    from: "  if (refundAmountFen !== undefined && refundAmountFen !== null && Number(refundAmountFen) !== orderAmount) {",
    to: "  if (false) {",
    cmd: 'node .tools/verify-funds-idempotency.mjs'
  }
];
