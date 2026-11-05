export interface CourseSourceMeta {
  title: string;
  intro: string;
  duration: string;
  source: string;
}

/**
 * 课程源内容卡的元数据解析。
 *
 * 本轮没有灵犀的课程接口，调用方传 null；未来接上接口后，请求失败或字段缺失
 * 也必须整体回落到本地文案 —— 不允许渲染空标题、空来源，让用户看到一张空卡。
 */
export function resolveCourseMeta(
  remote: Partial<CourseSourceMeta> | null,
  fallback: CourseSourceMeta
): CourseSourceMeta {
  const pick = (value: string | undefined, fb: string) =>
    typeof value === 'string' && value.trim() ? value.trim() : fb;
  return {
    title: pick(remote?.title, fallback.title),
    intro: pick(remote?.intro, fallback.intro),
    duration: pick(remote?.duration, fallback.duration),
    source: pick(remote?.source, fallback.source)
  };
}
