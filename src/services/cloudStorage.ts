/**
 * 头像上传（WorkBuddy 云存储，H5，2026-10-26）。
 *
 * 为什么用平台存储而不是微信云开发（用户指令「先用 WorkBuddy 的」）：
 * 微信云存储要云开发环境（WX_APPID 三件套未就绪，一直卡着），而 WorkBuddy 云服务的
 * storage 模块与本应用已在用的 auth / database / llm **共享同一个 client 与环境**，
 * 开通即用。代价是只在 H5 生效 —— 小程序端的 storage 走不到这个数据面
 * （需在小程序后台配 request 合法域名等外部条件），所以小程序端仍用本地 saveFile。
 *
 * 平台存储的三条硬约束（照 storage/code-generation.md，不自行发明）：
 *   · 路径必须是 `users/<自己的 uid>/...`（用 SDK 的 userPath 生成，**不接受外部拼的键**）；
 *   · **没有公开 URL** —— 读要换签名 URL（默认 600s，最长 3600s），签名属短时凭证，不落日志；
 *   · 存储只对**已登录**用户开放，未登录不能调（先判会话，再上传）。
 *
 * 失败语义：一律返回结构化结果（不抛），调用方据此给**具体**提示；
 * 绝不把失败当成功（本仓铁律：假成功比失败更糟）。
 */

import { compressImage } from '@/utils/imageCompress';
import { getCloudClient, getSession } from './cloudAuth';
import type { CloudStorageApi } from './cloudAuth';

/** 头像在本地/同步键里的取值前缀：`cloud:<对象键>` 表示「文件在云存储里」。
 *  emoji（如 🌅）与小程序端本地路径（wxfile://…）不带该前缀，读取侧据此分流。 */
export const AVATAR_CLOUD_PREFIX = 'cloud:';

/** **选图**上限（字节）：超过这个体积连解码都不做，直接拒绝 —— 避免把 50MB 的图塞进
 *  createImageBitmap 把浏览器卡死（解码内存约是文件体积的数十倍）。 */
export const AVATAR_RAW_MAX_BYTES = 8 * 1024 * 1024;

/** **上传**上限（字节）：压缩后仍超过它就不传。常态远低于此（512px 约 30–150KB），
 *  留着是兜底 —— 极端长图/高噪点图压缩后仍可能偏大。 */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

/** 允许的图片 MIME —— 只接受浏览器能直接显示的位图，挡掉 svg（可含脚本）与其它类型 */
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export type AvatarUploadResult =
  | { ok: true; path: string }
  | {
      ok: false;
      reason: 'not-h5' | 'no-session' | 'bad-type' | 'too-large' | 'too-large-compressed' | 'no-storage' | 'failed';
    };

function extOf(type: string): string {
  if (type === 'image/png') return 'png';
  if (type === 'image/webp') return 'webp';
  if (type === 'image/gif') return 'gif';
  return 'jpg';
}

/** 上传头像。成功后返回**对象键**（不含 `cloud:` 前缀，调用方自己加）。
 *
 *  体积两道闸：原始文件 > 8MB 直接拒（不解码，防卡死）；压缩后 > 2MB 再拒（极少数兜底）。
 *  压缩在会话判定**之后**做 —— 没登录就没必要花 CPU 解码一张大图。
 *
 *  **本函数永不抛**：整段包在 try 里，连 `getSession` / `getCloudClient` / `userPath` 都算在内。
 *  理由见下方 try 处的注释 —— 原实现只把 upload 包进 try，路径校验一抛就冒到调用方，
 *  用户点了上传什么都不发生（静默失败）。这是行为级用例 C2 锁住的那条。 */
export async function uploadAvatar(file: File): Promise<AvatarUploadResult> {
  if (process.env.TARO_ENV !== 'h5') return { ok: false, reason: 'not-h5' };
  if (!ALLOWED_TYPES.includes(file.type)) return { ok: false, reason: 'bad-type' };
  if (file.size > AVATAR_RAW_MAX_BYTES) return { ok: false, reason: 'too-large' };

  try {
    const session = await getSession();
    const uid = session?.user?.id;
    if (!uid) return { ok: false, reason: 'no-session' };

    const client = await getCloudClient();
    const storage = client?.storage;
    if (!storage) return { ok: false, reason: 'no-storage' };

    // 缩到 512px 再传（失败/不适用时原样返回，不影响上传）
    const payload = await compressImage(file);
    if (payload.size > AVATAR_MAX_BYTES) return { ok: false, reason: 'too-large-compressed' };

    // 路径由 SDK 帮助函数生成（users/<uid>/avatars/...），不接受外部传入的完整键。
    // 文件名带时间戳 —— 不做同名覆盖（旧文件由 deleteAvatar 显式删，避免 upsert 语义歧义）。
    // 扩展名按**实际上传的负载**取：压缩后格式沿用原格式，但以 payload.type 为准更稳。
    //
    // ⚠️ userPath 必须在 try 内：SDK 在**发请求之前**就校验路径并抛 CloudStoragePathError
    //    （storage/code-generation.md「Path validation throws … before a request is sent」）。
    //    放在 try 外时，这个异常会一路冒到调用方那个没有 catch 的 async 回调里 ——
    //    结果是**点了上传什么都不发生**（无提示、无日志去向），正是本仓最忌讳的静默失败。
    const path = storage.userPath(uid, `avatars/${Date.now()}.${extOf(payload.type || file.type)}`);

    const res = await storage.upload(path, payload, { contentType: payload.type || file.type, cacheControl: '86400' });
    if (res.error) {
      // console.error 而非 warn：warn 会被生产构建剔除，线上零痕迹（本仓铁律）
      console.error('[cloudStorage] upload avatar failed:', res.error.code || '', res.error.message || '');
      return { ok: false, reason: 'failed' };
    }
    return { ok: true, path };
  } catch (err) {
    console.error('[cloudStorage] upload avatar threw:', String((err && (err as Error).message) || err));
    return { ok: false, reason: 'failed' };
  }
}

/** 把存储里的头像换成可显示的 URL（签名，最长 1 小时）。
 *  返回 null 表示取不到 —— 调用方回退默认头像，**不要**用空 src 硬渲染。 */
export async function resolveAvatarUrl(path: string): Promise<string | null> {
  if (process.env.TARO_ENV !== 'h5') return null;
  const client = await getCloudClient();
  const storage = client?.storage;
  if (!storage) return null;
  try {
    const res = await storage.createSignedUrl(path, 3600);
    if (res.error || !res.data) {
      console.error('[cloudStorage] signed url failed:', res.error?.code || '', res.error?.message || '');
      return null;
    }
    // SDK 版本间字段命名有 signedUrl / signedURL 两种，取到一个即可；都没有就如实失败
    return res.data.signedUrl || res.data.signedURL || null;
  } catch (err) {
    console.error('[cloudStorage] signed url threw:', String((err && (err as Error).message) || err));
    return null;
  }
}

/** 删除旧头像文件（换头像时调用）。失败只留痕、不影响本次更换成功与否 ——
 *  最坏结果是一个孤儿文件，不该让「换头像」这一步因此失败。 */
export async function deleteAvatar(path: string): Promise<boolean> {
  if (process.env.TARO_ENV !== 'h5') return false;
  const client = await getCloudClient();
  const storage: CloudStorageApi | undefined = client?.storage;
  if (!storage) return false;
  try {
    const res = await storage.remove([path]);
    if (res.error) {
      console.error('[cloudStorage] delete avatar failed:', res.error.code || '', res.error.message || '');
      return false;
    }
    return true;
  } catch (err) {
    console.error('[cloudStorage] delete avatar threw:', String((err && (err as Error).message) || err));
    return false;
  }
}
