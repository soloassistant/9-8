/** 日志脱敏：保留首尾各 4 位，中间用 * 代替；长度不足 8 位则全掩。 */
function maskId(id) {
  const s = id == null ? '' : String(id);
  if (!s) return '';
  if (s.length <= 8) return '*'.repeat(s.length);
  return s.slice(0, 4) + '*'.repeat(s.length - 8) + s.slice(-4);
}

module.exports = maskId;
