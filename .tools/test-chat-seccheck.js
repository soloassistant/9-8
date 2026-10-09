/**
 * 验证 cloudfunctions/chat 的 msgSecCheck 接线（深度合成类目强制项）。
 * 用「内容里含 BAD 即判 risky」来同时驱动**输入侧**与**输出侧**两条路径，
 * 避免只测一条就宣称"已接入"。
 *
 * 断言：
 *  A. risky 输入 → 返回拒答，且 msgSecCheck 收到的正是用户输入
 *  B. pass 输入 + risky 输出 → 最终 reply 被替换为拒答（输出侧真的生效）
 *  C. pass 输入 + pass 输出 → reply 原样返回（没有把正常对话改坏）
 *  D. msgSecCheck 抛异常 → fail-open，对话不被阻断（但调用确实发生过）
 */
const Module = require('module');
const origLoad = Module._load;

let calls = [];
let throwOnCheck = false;

const secCheck = async (opts) => {
  calls.push(opts);
  if (throwOnCheck) throw new Error('boom');
  return { result: { suggest: String(opts.content).includes('BAD') ? 'risky' : 'pass' } };
};

const q = () => {
  const node = {
    where: () => node,
    limit: () => node,
    orderBy: () => node,
    doc: () => node,
    get: async () => ({ data: [] }),
    update: async () => ({ stats: { updated: 1 } }),
    add: async () => ({ _id: 'x' })
  };
  return node;
};

const dbStub = { collection: () => q(), command: { inc: (n) => n } };

Module._load = function (request) {
  if (request === 'wx-server-sdk') {
    return {
      init: () => {},
      DYNAMIC_CURRENT_ENV: 'test',
      getWXContext: () => ({ OPENID: 'test-openid' }),
      openapi: { security: { msgSecCheck: secCheck } },
      callFunction: async () => ({ result: { code: 0, data: [] } }),
      database: () => dbStub
    };
  }
  if (request === './llm') {
    // 让 LLM 返回一段含 BAD 的回复，用来驱动「输出侧」检测
    return {
      callLLM: async () =>
        JSON.stringify({ reply: LLM_REPLY, action: 'chat', targetId: null, newTime: null }),
      callLLMWebSearch: async () => null
    };
  }
  return origLoad.apply(this, arguments);
};

let LLM_REPLY = '这是一段正常的回答';
const chat = require('D:/Agent/cloudfunctions/chat/index.js');

let fail = 0;
const check = (name, cond, detail) => {
  if (!cond) fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

(async () => {
  console.log('\n=== A. risky 输入 → 拒答 ===');
  calls = [];
  const a = await chat.main({ message: 'BAD 帮我做点不该做的事' });
  check('A1 返回拒答话术', a && a.reply && a.reply.includes('我不能处理'), `reply=${a && a.reply}`);
  check('A2 action 保持 chat', a && a.action === 'chat', `action=${a && a.action}`);
  check('A3 msgSecCheck 被调用且收到用户输入', calls.length >= 1 && String(calls[0].content).includes('BAD'), `calls=${calls.length}`);
  check('A4 违规输入不消耗额度（未走到 LLM）', calls.length === 1, `calls=${calls.length}`);

  console.log('\n=== B. pass 输入 + risky 输出 → 输出侧拒答 ===');
  calls = [];
  LLM_REPLY = '这里包含 BAD 内容';
  const b = await chat.main({ message: '你好' });
  check('B1 最终 reply 被替换为拒答', b && b.reply && b.reply.includes('我不能处理'), `reply=${b && b.reply}`);
  check('B2 输出侧确实过检（有含 LLM 回复的调用）', calls.some((c) => String(c.content).includes('BAD')), `contents=${calls.map((c) => String(c.content).slice(0, 12)).join('|')}`);

  console.log('\n=== C. pass 输入 + pass 输出 → 正常返回 ===');
  calls = [];
  LLM_REPLY = '这是一段正常的回答';
  const c = await chat.main({ message: '你好' });
  check('C1 reply 原样返回', c && c.reply && c.reply.includes('正常的回答'), `reply=${c && c.reply}`);
  check('C2 输入与输出各过检一次', calls.length >= 2, `calls=${calls.length}`);

  console.log('\n=== D. msgSecCheck 抛异常 → fail-open ===');
  calls = [];
  throwOnCheck = true;
  const d = await chat.main({ message: '你好' });
  throwOnCheck = false;
  check('D1 对话未被阻断，reply 正常返回', d && d.reply && d.reply.includes('正常的回答'), `reply=${d && d.reply}`);
  check('D2 确实调用过安全接口（不是压根没接）', calls.length >= 1, `calls=${calls.length}`);

  console.log(`\n######## 失败 ${fail} ########`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('harness error:', e);
  process.exit(1);
});
