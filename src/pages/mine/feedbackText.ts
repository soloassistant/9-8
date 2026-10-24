/**
 * 「我的」页新增表单的文案（意见反馈 + 天气城市），中英两版。
 *
 * ## 为什么文案不放在 `src/store/language.ts`
 *
 * 项目惯例是集中式 i18n（`t('mine.xxx')`）。这里例外，原因是**并行写入冲突**：
 * 本轮 `language.ts` 正由另一条会话持有未提交改动（`greet.*`），此刻往里插键，
 * 提交时只能连带把对方未完成的键一起入库（项目里已因此返工过一次）。
 *
 * 代价与约束（已登记 `.tools/COORDINATION.md`）：
 *   · 这是**临时位置**，`language.ts` 释放后应迁移为 `mine.fb*` 键并删除本文件；
 *   · 迁移前后行为一致：都按 `lang`（'zh' | 'en'）取串，不引入第三种语言。
 *
 * ## 类型白名单必须与云函数一致
 *
 * `FEEDBACK_TYPES` 的 id 与 `cloudfunctions/feedback/index.js` 的 `TYPES` 一一对应。
 * 云端对越界类型**不拒单**（归入 `other`，避免用户白填一遍），所以这里的不一致不会报错，
 * 只会让「账号与支付」的反馈被静默归到「其他」—— 更难发现，因此用 F11 断言逐项锁死。
 */

/** 与云函数 `TYPES` 严格一致，勿单边增删 */
export type FeedbackType = 'suggestion' | 'data' | 'account' | 'other';

export const FEEDBACK_TYPES: Array<{ id: FeedbackType; zh: string; en: string }> = [
  { id: 'suggestion', zh: '功能建议', en: 'Suggestion' },
  { id: 'data', zh: '数据有误', en: 'Wrong data' },
  { id: 'account', zh: '账号与支付', en: 'Account' },
  { id: 'other', zh: '其他问题', en: 'Other' }
];

/** 单个语言下的表单文案 */
export interface FeedbackCopy {
  title: string;
  intro: string;
  typeLabel: string;
  contentLabel: string;
  contentPlaceholder: string;
  contactLabel: string;
  contactPlaceholder: string;
  submit: string;
  submitting: string;
  service: string;
  /** H5（无 RPC 通道）在提交前就告知实际送达方式，避免点了才知道 */
  h5Note: string;
  /** 空内容：不弹原生 alert，就地 toast */
  emptyHint: string;
  /** 真正落库成功才可以说这句 */
  success: string;
  copiedTitle: string;
  copiedBody: string;
  copyFailedTitle: string;
  copyFailedBody: string;
}

export const FEEDBACK_TEXT: Record<'zh' | 'en', FeedbackCopy> = {
  zh: {
    title: '意见反馈',
    intro: '遇到问题、看到数据不对，或者想要什么功能，都可以直接写给我们。',
    typeLabel: '问题类型',
    contentLabel: '具体描述',
    contentPlaceholder: '例如：早上 8 点的日程被晨报卡片挡住了一半 / 这条热点的原文链接打不开',
    contactLabel: '联系方式（选填）',
    contactPlaceholder: '邮箱或手机号，方便我们回复你',
    submit: '提交',
    submitting: '提交中…',
    service: '需要人工客服？去复制邮箱或公众号 ›',
    h5Note: '网页版暂不能直接提交，点提交后会帮你复制好内容，粘贴发送到客服邮箱即可。',
    emptyHint: '请先写一下具体内容',
    success: '已收到，15 个工作日内答复',
    copiedTitle: '反馈内容已复制',
    copiedBody: '当前环境无法直接提交。请把复制的内容粘贴发送到客服邮箱，我们同样会在 15 个工作日内答复。',
    copyFailedTitle: '请手动发送',
    copyFailedBody: '复制失败了。请把刚才填写的内容手动发送到客服邮箱，并在主题里写上「意见反馈」。'
  },
  en: {
    title: 'Feedback',
    intro: 'Found a problem, saw wrong data, or want a feature? Write to us directly.',
    typeLabel: 'Type',
    contentLabel: 'Details',
    contentPlaceholder: 'e.g. my 8 AM event is half covered by the briefing card / the source link of this story does not open',
    contactLabel: 'Contact (optional)',
    contactPlaceholder: 'Email or phone so we can reply',
    submit: 'Submit',
    submitting: 'Sending…',
    service: 'Need a human? Copy our email or WeChat account ›',
    h5Note: 'The web version cannot submit directly. Tapping Submit copies your text so you can paste it into an email to support.',
    emptyHint: 'Please describe the issue first',
    success: 'Received — we reply within 15 business days',
    copiedTitle: 'Feedback copied',
    copiedBody: 'This environment cannot submit directly. Please paste the copied text into an email to our support address; we reply within 15 business days.',
    copyFailedTitle: 'Please send it manually',
    copyFailedBody: 'Copy failed. Please send what you wrote to our support email with the subject "Feedback".'
  }
};

/**
 * 天气城市手动设置（2026-10-24 新增）的文案。
 *
 * 为什么需要手动设置：`user-city` 此前**只有** GPS 逆地理编码会写（services/location.ts），
 * 用户拒绝定位或定位失败时永远是「北京」—— 天气显示的是**别的城市**，还完全静默。
 * 这比没有天气更误导，所以给了兜底入口。
 */
export const CITY_TEXT: Record<'zh' | 'en', {
  hint: string;
  placeholder: string;
  save: string;
  saving: string;
  empty: string;
  notFound: string;
  savedPrefix: string;
  saveFailed: string;
  defaultTag: string;
}> = {
  zh: {
    hint: '用于晨报里的那行天气。定位不准，或者不想开定位，就直接填城市名。',
    placeholder: '例如：杭州 / 深圳 / 成都',
    save: '保存',
    saving: '校验中…',
    empty: '请先输入城市名',
    notFound: '没查到这座城市，换个说法试试',
    savedPrefix: '已保存',
    saveFailed: '保存失败，请重试',
    defaultTag: '北京（默认）'
  },
  en: {
    hint: 'Used for the weather line in your briefing. Set it manually if location is off or inaccurate.',
    placeholder: 'e.g. Hangzhou / Shenzhen / Chengdu',
    save: 'Save',
    saving: 'Checking…',
    empty: 'Please enter a city',
    notFound: 'City not found — try another name',
    savedPrefix: 'Saved',
    saveFailed: 'Save failed, please retry',
    defaultTag: 'Beijing (default)'
  }
};
