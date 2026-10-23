/**
 * 登录页手机号可选的国际区号表。
 *
 * ⚠️ 为什么表里**没有 +1（美国 / 加拿大 / 所有 NANP 国家与地区）**：
 *   这不是漏写，而是当前云 SDK（`src/assets/wb-sdk.js`）的硬限制，实测证据如下。
 *
 *   把 SDK 放进 Node vm 里跑起来、桩掉 fetch 截获 `POST /.cloud/auth/v1/verification`
 *   的请求体后，"前端传入 → SDK 实际发出的 phone_number" 实测为：
 *
 *   | 前端传入         | SDK 实际发出                        |
 *   | ---------------- | ----------------------------------- |
 *   | 13800138000      | +86 13800138000                     |
 *   | +8613800138000   | +86 13800138000                     |
 *   | +85291234567     | +85291234567（原样透传）            |
 *   | +447911123456    | +447911123456（原样透传）           |
 *   | +886912345678    | +886912345678（原样透传）           |
 *   | +6591234567      | +6591234567（原样透传）             |
 *   | +819012345678    | +819012345678（原样透传）           |
 *   | +821012345678    | +821012345678（原样透传）           |
 *   | +14155550123     | **+86 14155550123**  ← 被改写成大陆号码 |
 *
 *   根因是 SDK 内部的 `normalizePhone`：先剥掉所有非数字字符；若以 `0086` 开头切掉 4 位；
 *   若以 `86` 开头且总长 13 位则切掉 2 位；随后 **`/^1\d{10}$/` 命中就返回 `+86 <数字>`，
 *   否则原样返回**。
 *
 *   北美 E.164 恒为「1 + 10 位」= 11 位以 1 开头的数字，剥掉 `+` 之后必然命中
 *   `/^1\d{10}$/` → 被静默改写成一个中国大陆号码。`14x` 是真实可分配的号段，
 *   于是 `+14155550123` 真的会把短信发给一个陌生的大陆用户。
 *
 *   任何能表达北美号码的写法，其"只剩数字"的形式都必然命中该正则，前端无法绕过。
 *   因此 **+1 绝对不能加回本表**（包括任何 NANP 国家/地区），除非 SDK 的归一逻辑改变。
 */
export interface DialCodeEntry {
  /** ISO 3166-1 alpha-2，仅作 key 与测试锚点，不进 UI */
  iso: string;
  nameZh: string;
  nameEn: string;
  /** 国际区号，**不带 `+`**（拼接时统一加） */
  code: string;
  /** 本地号码位数区间（不含区号） */
  minLen: number;
  maxLen: number;
  /** 额外形态约束；目前只有中国大陆用 */
  pattern?: RegExp;
}

/** 顺序即下拉顺序；中国大陆必须排第一，作为默认项。 */
export const DIAL_CODES: readonly DialCodeEntry[] = [
  { iso: 'CN', nameZh: '中国大陆', nameEn: 'China Mainland', code: '86', minLen: 11, maxLen: 11, pattern: /^1\d{10}$/ },
  { iso: 'HK', nameZh: '中国香港', nameEn: 'Hong Kong, China', code: '852', minLen: 8, maxLen: 8 },
  { iso: 'MO', nameZh: '中国澳门', nameEn: 'Macao, China', code: '853', minLen: 8, maxLen: 8 },
  { iso: 'TW', nameZh: '中国台湾', nameEn: 'Taiwan, China', code: '886', minLen: 9, maxLen: 9 },
  { iso: 'SG', nameZh: '新加坡', nameEn: 'Singapore', code: '65', minLen: 8, maxLen: 8 },
  { iso: 'MY', nameZh: '马来西亚', nameEn: 'Malaysia', code: '60', minLen: 9, maxLen: 10 },
  { iso: 'JP', nameZh: '日本', nameEn: 'Japan', code: '81', minLen: 10, maxLen: 11 },
  { iso: 'KR', nameZh: '韩国', nameEn: 'South Korea', code: '82', minLen: 9, maxLen: 11 },
  { iso: 'TH', nameZh: '泰国', nameEn: 'Thailand', code: '66', minLen: 9, maxLen: 9 },
  { iso: 'VN', nameZh: '越南', nameEn: 'Vietnam', code: '84', minLen: 9, maxLen: 10 },
  { iso: 'ID', nameZh: '印尼', nameEn: 'Indonesia', code: '62', minLen: 9, maxLen: 12 },
  { iso: 'PH', nameZh: '菲律宾', nameEn: 'Philippines', code: '63', minLen: 10, maxLen: 10 },
  { iso: 'IN', nameZh: '印度', nameEn: 'India', code: '91', minLen: 10, maxLen: 10 },
  { iso: 'AE', nameZh: '阿联酋', nameEn: 'United Arab Emirates', code: '971', minLen: 9, maxLen: 9 },
  { iso: 'GB', nameZh: '英国', nameEn: 'United Kingdom', code: '44', minLen: 10, maxLen: 10 },
  { iso: 'DE', nameZh: '德国', nameEn: 'Germany', code: '49', minLen: 10, maxLen: 11 },
  { iso: 'FR', nameZh: '法国', nameEn: 'France', code: '33', minLen: 9, maxLen: 9 },
  { iso: 'IT', nameZh: '意大利', nameEn: 'Italy', code: '39', minLen: 9, maxLen: 10 },
  { iso: 'ES', nameZh: '西班牙', nameEn: 'Spain', code: '34', minLen: 9, maxLen: 9 },
  { iso: 'NL', nameZh: '荷兰', nameEn: 'Netherlands', code: '31', minLen: 9, maxLen: 9 },
  { iso: 'RU', nameZh: '俄罗斯', nameEn: 'Russia', code: '7', minLen: 10, maxLen: 10 },
  { iso: 'AU', nameZh: '澳大利亚', nameEn: 'Australia', code: '61', minLen: 9, maxLen: 9 },
  { iso: 'NZ', nameZh: '新西兰', nameEn: 'New Zealand', code: '64', minLen: 8, maxLen: 10 },
  { iso: 'BR', nameZh: '巴西', nameEn: 'Brazil', code: '55', minLen: 10, maxLen: 11 }
];

/** 默认区号：中国大陆。与 DIAL_CODES[0] 保持一致。 */
export const DEFAULT_DIAL_CODE = '86';

/** 按区号查表（不带 `+`）。找不到返回 undefined，调用方据此判定「不支持的区号」。 */
export function findDialCode(code: string): DialCodeEntry | undefined {
  return DIAL_CODES.find((entry) => entry.code === code);
}

/** 该区号是否在支持列表内（本地留存值回读时的合法性校验）。 */
export function isSupportedDialCode(code: string): boolean {
  return findDialCode(code) !== undefined;
}
