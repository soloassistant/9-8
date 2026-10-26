/**
 * 头像压缩（H5，2026-10-26）。
 *
 * 为什么需要它：手机上拍的照片常见 3–8MB、4000px 起步，而头像显示尺寸最大也就 128rpx。
 * 原图直传有三个代价 —— 上传慢（弱网会卡住用户）、流量浪费、每次进页面换签名 URL 后
 * 还要再下一遍大图。缩到 512px 边长后通常 30–150KB，视觉上没有区别。
 *
 * 三条设计约束：
 *   · **绝不放大**：`scale = min(1, maxEdge / max(w,h))`，小图原样通过；
 *   · **保留格式**（PNG 仍编 PNG）—— PNG 转 JPEG 会把透明背景变黑，头像常带透明边；
 *   · **失败一律返回原图**：压缩是优化不是功能，任何一步不支持/抛错都不能让上传失败。
 *     「返回原图」在语义上等于「没压缩」，调用方只需看体积，不需要知道走没走压缩。
 *
 * 为什么 GIF 跳过：canvas 只会编出第一帧，重编码等于把动图变成静图 —— 静默降级不能接受。
 * （头像用动图是少数，但「少数」不是「可以悄悄弄坏」的理由。）
 */

/** 压缩后最长边（px）。头像显示最大约 128rpx≈64px，512 对 2x/3x 屏也足够。 */
export const AVATAR_MAX_EDGE = 512;

/** JPEG/WebP 的编码质量。0.85 在同尺寸下肉眼难辨，体积约为 1.0 的四成。 */
export const AVATAR_QUALITY = 0.85;

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  release(): void;
}

/** 解码成可绘制的图源。优先 `createImageBitmap`（不占 DOM、能 close 立即释放），
 *  老浏览器退回 `Image` + objectURL。两条路都失败返回 null（调用方原样返回）。 */
async function decode(file: File): Promise<Decoded | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file);
      return {
        source: bmp,
        width: bmp.width,
        height: bmp.height,
        release: () => {
          try {
            bmp.close();
          } catch {
            /* 老实现没有 close —— 忽略 */
          }
        }
      };
    } catch {
      /* 某些浏览器对 Blob 入参支持不全 → 落到 Image 路径 */
    }
  }
  if (typeof document === 'undefined' || typeof Image === 'undefined') return null;
  const url = URL.createObjectURL(file);
  const img = await new Promise<HTMLImageElement | null>((resolve) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => resolve(null);
    el.src = url;
  });
  if (!img) {
    URL.revokeObjectURL(url);
    return null;
  }
  return {
    source: img,
    width: img.naturalWidth,
    height: img.naturalHeight,
    release: () => URL.revokeObjectURL(url)
  };
}

/** 把图片缩到最长边 ≤ maxEdge 并重新编码。
 *  返回**原图**的条件：GIF / 非浏览器环境 / 解码失败 / 画布不可用 / 编出来反而更大。
 *  调用方只需按 `.size` 判断，不用区分「压过」和「没压」。 */
export async function compressImage(file: File, maxEdge: number = AVATAR_MAX_EDGE): Promise<File | Blob> {
  // 动图重编码会丢帧 —— 宁可不压
  if (file.type === 'image/gif') return file;
  // 小程序端（无 document）不会调到这里；真调到也不做任何事
  if (typeof document === 'undefined') return file;

  let decoded: Decoded | null = null;
  try {
    decoded = await decode(file);
    if (!decoded) return file;
    const { width: srcW, height: srcH } = decoded;
    if (!srcW || !srcH) return file;

    // min(1, …) 保证只缩不放
    const scale = Math.min(1, maxEdge / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(decoded.source, 0, 0, w, h);

    // 编码格式沿用原格式：PNG 保持 PNG（透明不丢），JPEG/WebP 用 quality
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, file.type, AVATAR_QUALITY);
    });
    // 没变小就用原图 —— 二次编码只会掉画质，不该为了「压过了」而付出代价
    if (!blob || blob.size >= file.size) return file;
    return blob;
  } catch {
    return file;
  } finally {
    decoded?.release();
  }
}
