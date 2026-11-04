/**
 * 购物类回复兜底（H5 直连 cloud.llm 用）。
 *
 * 为什么客户端也要有一份：`cloudfunctions/chat` 在服务端会对模型回复做禁语改写，
 * 但 H5 走的是 SDK 直连 `cloud.llm`，**不经过云函数**，原来没有任何后处理 ——
 * 同一句「已为你下单」在小程序被拦截、在 H5 却原样显示，属于安全口径不一致。
 * 这里与云函数同口径移植（仅保留回复侧兜底，输入侧仍由提示词约束）。
 */
const FORBIDDEN = [/已为你下单/, /已帮你购买/, /已锁定库存/, /已付款/, /代你支付/];
const ORDER_INTENT = /下单|购买|付款|代付|帮我买|帮我拍|替我买|代我买|给我买|直接买|拍下|加购|结算/;
const REFUSE =
  '我可以帮你查价、比价和汇总优惠，但下单付款需要你本人在购物平台完成，我不会代替你操作。';
const DISCLAIMER = '我只帮你查价和汇总信息，不会替你下单或付款。';

export function sanitizeShoppingReply(reply: string, message: string): string {
  const text = String(reply || '');
  if (!text) return text;
  if (FORBIDDEN.some((re) => re.test(text))) return REFUSE;
  const hasDisclaimer = text.includes(DISCLAIMER) || text.includes(REFUSE);
  const hitIntent = ORDER_INTENT.test(text) || ORDER_INTENT.test(String(message || ''));
  if (hitIntent && !hasDisclaimer) return `${text}\n${REFUSE}`;
  return text;
}
