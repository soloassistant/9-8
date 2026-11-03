/**
 * 腾讯云验证码（天御）接线层（2026-11-01，登录/注册发码路径的人机验证门槛）。
 *
 * 为什么存在：发码接口在平台侧且未登录可调（2026-10-31 探针实测：未登录 POST
 * /v1/verification → 200 发码）——短信轰炸烧的是真金白银的短信余额。
 * 本层是**前端门槛**：发码前先过一次人机验证。
 *
 * ⚠️ 诚实边界（两条，别拿它当硬防线）：
 *   ① 它挡不住绕过页面直接打接口的脚本——硬防线必须平台在 /v1/verification
 *      服务端按 IP 限流 + 校验票据（已提给平台，见 COORDINATION 2026-11-01 条目）；
 *   ② 本应用没有自有后端，ticket 无法做服务端二次校验（平台 verification 接口
 *      也不收票据），所以 ticket 只在本端消费（发码前必须先持有）。
 *
 * 配置位：CAPTCHA_APPID 为空 = 功能**完全关闭**，登录页行为与未接线时逐字节一致。
 * 申请：https://console.cloud.tencent.com/captcha（免费额度每月 1 万次），AppId 是数字串。
 * 仅 H5 生效；weapp 端未来走云函数代理发码时由服务端按 openid 限流（微信身份可追责）。
 */

const CAPTCHA_APPID = '';
const SCRIPT_SRC = 'https://turing.captcha.qcloud.com/TCaptcha.js';
const isH5 = process.env.TARO_ENV === 'h5';

export function captchaEnabled(): boolean {
  return isH5 && CAPTCHA_APPID !== '';
}

let scriptPromise: Promise<void> | null = null;
function loadTcaptchaScript(): Promise<void> {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const w = window as unknown as { TencentCaptcha?: unknown };
    if (w.TencentCaptcha) {
      resolve();
      return;
    }
    const s = document.createElement('script');
    s.src = SCRIPT_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      scriptPromise = null; // 允许下次重试
      reject(new Error('tcaptcha-script-failed'));
    };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

interface TencentCaptchaResult {
  /** 0 = 验证通过；非 0 = 用户关闭/验证失败 */
  ret: number;
  ticket: string;
  randstr: string;
}

/**
 * 发码前的人机验证闸。返回 true = 放行（两种情况：配置位关闭；或验证通过）。
 * 返回 false = 用户关闭了滑块/验证未通过——调用方**不发码**（静默返回，用户自己关的）。
 * 控件/脚本异常时**降级放行**：它是门槛不是闸门（硬防线在平台侧），不能因为
 * 第三方脚本抖动把所有用户的登录/注册全堵死——那种故障的代价大于轰炸风险。
 */
export async function ensureCaptchaPassed(): Promise<boolean> {
  if (!captchaEnabled()) return true;
  try {
    await loadTcaptchaScript();
  } catch (err) {
    console.error('[captcha] TCaptcha.js 加载失败，本次放行（门槛降级，平台侧限流兜底）');
    return true;
  }
  return new Promise<boolean>((resolve) => {
    try {
      const w = window as unknown as {
        TencentCaptcha: new (
          appid: string,
          callback: (r: TencentCaptchaResult) => void
        ) => { destroy: () => void };
      };
      const captcha = new w.TencentCaptcha(
        CAPTCHA_APPID,
        (r: TencentCaptchaResult) => {
          resolve(r.ret === 0 && !!r.ticket);
        }
      ) as { show: () => void; destroy: () => void };
      captcha.show(); // 官方契约：构造后必须显式 show() 才弹出滑块
    } catch (err) {
      console.error('[captcha] 控件异常，本次放行:', err);
      resolve(true);
    }
  });
}
