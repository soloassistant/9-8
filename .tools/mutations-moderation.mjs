// 变异用例：RG-02 内容安全 fail-closed（harness: .tools/test-chat-seccheck.js）
const CMD = 'node .tools/test-chat-seccheck.js';

export default [
  { label: 'chat：异常分支改回 fail-open', file: 'cloudfunctions/chat/index.js', from: '    return { ok: false, reason: verdict.reason };', to: '    return { ok: true }; /* MUT */', cmd: CMD },
  { label: 'chat：删掉 failure 记录写入', file: 'cloudfunctions/chat/index.js', from: '    await recordModerationFailure(openid, action, verdict.reason, verdict.errCode, verdict.detail, text);', to: '    /* MUT: record removed */', cmd: CMD },
  { label: 'extract：异常分支改回 fail-open', file: 'cloudfunctions/extract/index.js', from: '    return { ok: false, reason: verdict.reason };', to: '    return { ok: true }; /* MUT */', cmd: CMD },
  { label: 'extract：删掉 failure 记录写入', file: 'cloudfunctions/extract/index.js', from: '    await recordModerationFailure(openid, verdict.reason, verdict.errCode, verdict.detail, content);', to: '    /* MUT: record removed */', cmd: CMD }
];
