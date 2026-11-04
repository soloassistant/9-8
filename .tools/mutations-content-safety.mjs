// 变异用例：X11 H5 AI 内容安全（harness: .tools/verify-content-safety.mjs）
export default [
  {
    label: '删掉「侵害未成年人」红线（护栏漏一类）',
    file: 'src/utils/contentSafety.ts',
    from: "  { category: 'minor', re: /(未成年|儿童|幼女|萝莉)[^。\\n]{0,12}(裸照|色情|性行为|性交|视频)/ },",
    to: "  /* MUT: minor rule removed */",
    cmd: 'node .tools/verify-content-safety.mjs'
  },
  {
    label: '归一化不再去零宽字符（可绕过）',
    file: 'src/utils/contentSafety.ts',
    from: "    .replace(/[\\u200b-\\u200f\\u202a-\\u202e]/g, '')",
    to: "    .replace(/x/g, 'x') /* MUT */",
    cmd: 'node .tools/verify-content-safety.mjs'
  },
  {
    label: 'AI 对话输入护栏被短路',
    file: 'src/components/AiAssistant/index.tsx',
    from: 'if (isH5 && !screenContent(content).ok) {',
    to: 'if (false) { /* MUT */',
    cmd: 'node .tools/verify-content-safety.mjs'
  },
  {
    label: 'AI 对话流式输出绕过护栏',
    file: 'src/components/AiAssistant/index.tsx',
    from: 'setMsgContent(sid, safeReply(streamed.reply));',
    to: 'setMsgContent(sid, streamed.reply); /* MUT */',
    cmd: 'node .tools/verify-content-safety.mjs'
  },
  {
    label: '收件箱输出护栏被短路',
    file: 'src/pages/inbox/index.tsx',
    from: 'isH5 && reply && !screenContent(reply).ok',
    to: 'false /* MUT */',
    cmd: 'node .tools/verify-content-safety.mjs'
  }
];
