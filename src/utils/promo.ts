/**
 * H5 促销码兑换引擎（2026-10-25，用户需求「搞一个兑换码的地方来兑换 pro」）。
 *
 * ## 为什么 H5 只能做「促销码」而不是「一码一用兑换码」（平台能力边界，如实）
 *
 * 一码一用需要**跨用户原子标记**（谁先兑谁占坑）—— WorkBuddy 云库的 RLS 只允许
 * 读写自己的行，做不到「用户 A 把码标记为已用、用户 B 就兑不了」。微信云开发可以
 * （`cloudfunctions/redeemCode` 已实现一码一用版，待部署），但 H5 调不到微信云函数。
 *
 * 所以 H5 走**促销码模式**：码 = 促销活动凭证，**可多人使用**、有活动截止日，
 * 前端只存 SHA-256 哈希（明文码不进包，不能从包里反推出码）。商业语义就是
 * 「活动期内拿到码的人都开 PRO」—— 与一码一用的「定向发放」不同，UI 文案明确说促销码。
 *
 * ## 防什么 / 不防什么（诚实）
 * - 防：从安装包提取明文码（只有哈希）；过期码/错码（校验）；活动结束后兑换（截止日）。
 * - 不防：拿到码的人把码告诉别人 —— 促销码语义下这不是漏洞，是传播。
 * - 本地存储的订阅凭证可被用户自己改 —— 但 H5 的 PRO 权益执行点（收藏配额/角标）
 *   本来就在本地（云端执行的额度在 H5 不经过），威胁模型一致，没有变差。
 */

import Taro from '@tarojs/taro';

/** H5 订阅凭证存储键（本地；来源只能是促销码兑换成功，见 redeemPromo） */
const H5_SUB_KEY = 'h5-subscription';

/** 促销码活动表：hash = SHA-256(码明文) 的十六进制小写。
 *  码由 .tools/promo-gen.mjs 生成（明文不进仓库），格式 PRO-XXXX-XXXX。 */
interface PromoDef {
  hash: string;
  /** 兑换成功后开通天数 */
  planDays: number;
  /** 活动截止日 'YYYY-MM-DD'（含当天）—— 过期后此码不可再兑换 */
  goodUntil: string;
}

export const PROMO_CODES: PromoDef[] = [
  // 首发活动码（2026-10-25 由 .tools/promo-gen.mjs 生成）：30 天 PRO，2026-12-31 截止。
  // 明文码不进仓库（防从包里反推没意义——哈希单向，但码要控制发放节奏）。
  { hash: 'c50a410675acc8f8e689ce23cd3c231c990e81f255e07621afe6c1515cd0b0c5', planDays: 30, goodUntil: '2026-12-31' },
  // 订阅链路验证码（2026-10-28）：兑换后订单落 orders 表，可全链路实测「兑换→订单→恢复」
  { hash: 'd3f960f8e093f102aee5615c9e5b230e0eded015ce939a4edde6844971fcf143', planDays: 30, goodUntil: '2027-01-31' }
];

/** 兑换结果 */
export interface PromoResult {
  ok: boolean;
  /** 失败原因（调用方据此 toast，不猜） */
  reason?: 'format' | 'unknown' | 'expired';
  /** 成功时的新到期日 'YYYY-MM-DD' */
  expiredAt?: string;
  days?: number;
}

/* ---------------- SHA-256（公有域算法的标准实现，无依赖） ---------------- */

function sha256Hex(msg: string): string {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const bytes: number[] = [];
  for (let i = 0; i < msg.length; i++) {
    const c = msg.charCodeAt(i);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  // 64 位长度只支持到 2^32（促销码场景远够；超长输入哈希错也不影响安全——码本身短）
  for (let i = 24; i >= 0; i -= 8) bytes.push(0);
  for (let i = 24; i >= 0; i -= 8) bytes.push((bitLen >>> i) & 0xff);

  const w = new Array<number>(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = (bytes[off + i * 4] << 24) | (bytes[off + i * 4 + 1] << 16) | (bytes[off + i * 4 + 2] << 8) | bytes[off + i * 4 + 3];
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  return H.map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

/** 码格式：PRO-XXXX-XXXX（X = 大写字母/数字，防手滑小写自动转大写） */
const PROMO_RE = /^PRO-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(base: string, days: number): string {
  const d = new Date(base + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 读当前 H5 订阅凭证；无/过期返回 null（过期即失效，不编造「还订阅着」） */
export function readH5Subscription(): { subscribed: true; expiredAt: string } | null {
  try {
    const v = Taro.getStorageSync(H5_SUB_KEY) as { expiredAt?: string } | '';
    if (!v || typeof v.expiredAt !== 'string') return null;
    if (v.expiredAt < todayStr()) return null; // 到期日当天仍有效（与云函数口径一致）
    return { subscribed: true, expiredAt: v.expiredAt };
  } catch (err) {
    console.error('[promo] read subscription failed:', err);
    return null;
  }
}

/**
 * 按天数顺延本地订阅凭证（叠加口径与 redeemPromo 一致：未过期从到期日起算）。
 * 供订阅恢复（orders 表回放）使用 —— 兑换与恢复走同一条叠加路，口径不分叉。
 */
export function extendH5Subscription(days: number): string | null {
  if (!Number.isFinite(days) || days <= 0) return null;
  const current = readH5Subscription();
  const base = current ? current.expiredAt : todayStr();
  const expiredAt = addDays(base, Math.round(days));
  try {
    Taro.setStorageSync(H5_SUB_KEY, { expiredAt, redeemedAt: todayStr() });
  } catch (err) {
    console.error('[promo] extend subscription failed:', err);
    return null;
  }
  return expiredAt;
}

/**
 * 直接把本地凭证写到指定到期日（订阅恢复用：云端订单回放出的到期日可能
 * 早于今天很久 —— extendH5Subscription 的「从今天起算」口径不适用于恢复场景）。
 * 只允许写到不早于今天的日期（过期日不落盘，readH5Subscription 会如实判 null）。
 */
export function setH5SubscriptionExpiry(expiredAt: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiredAt) || expiredAt < todayStr()) return false;
  try {
    Taro.setStorageSync(H5_SUB_KEY, { expiredAt, redeemedAt: todayStr() });
    return true;
  } catch (err) {
    console.error('[promo] set subscription expiry failed:', err);
    return false;
  }
}

/**
 * 兑换促销码。成功写本地凭证并返回新到期日；同一码重复兑换按**续期叠加**处理
 * （促销语义：活动期再兑一次多送 N 天 —— 不叠加会让「复制粘贴两次」的用户困惑）。
 *
 * `codes` 参数是**门禁测试注入口**：生产调用不传（用 PROMO_CODES 真表）；门禁传自造码表
 * 测全行为 —— 真实明文码绝不写进 public 仓库的测试代码（哈希表在包里没关系，明文不行）。
 */
export function redeemPromo(input: string, codes: PromoDef[] = PROMO_CODES): PromoResult {
  const code = input.trim().toUpperCase();
  if (!PROMO_RE.test(code)) return { ok: false, reason: 'format' };
  const hit = codes.find((p) => p.hash === sha256Hex(code));
  if (!hit) return { ok: false, reason: 'unknown' };
  if (todayStr() > hit.goodUntil) return { ok: false, reason: 'expired' };

  // 续期叠加：已有未过期凭证 → 在其到期日上顺延；否则从今天起算
  const current = readH5Subscription();
  const base = current ? current.expiredAt : todayStr();
  const expiredAt = addDays(base, hit.planDays);
  try {
    Taro.setStorageSync(H5_SUB_KEY, { expiredAt, redeemedAt: todayStr() });
  } catch (err) {
    console.error('[promo] persist subscription failed:', err);
    return { ok: false, reason: 'unknown' };
  }
  return { ok: true, expiredAt, days: hit.planDays };
}

/** 供门禁直接验证哈希实现（固定测试向量："abc" 的 SHA-256，公有域标准值） */
export function _sha256HexForTest(msg: string): string {
  return sha256Hex(msg);
}
