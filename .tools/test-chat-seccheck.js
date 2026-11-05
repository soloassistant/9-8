/**
 * chat + extract 的 msgSecCheck 接线与 fail-closed 回归（RG-02）：A 违规输入 / B 输出侧 /
 * C 正常放行 / D 超时=拒绝+留证 / E 87014 与超时分开记 / F extract 同款。
 */
const path = require('path');
const Module = require('module');
const origLoad = Module._load;
const ROOT = path.resolve(__dirname, '..');

let calls = [];
let mode = 'normal'; // normal / timeout / violation
let writes = [];

const secCheck = async (opts) => {
  calls.push(opts);
  if (mode === 'timeout') {
    const e = new Error('request timeout');
    e.code = 'ETIMEDOUT';
    throw e;
  }
  if (mode === 'violation') {
    const e = new Error('errCode: 87014 msgSecCheck: 内容含有违法违规内容');
    e.errCode = 87014;
    throw e;
  }
  const risky = String(opts.content).includes('BAD');
  return { result: { suggest: risky ? 'risky' : 'pass', label: risky ? 20006 : 10001 } };
};

const q = (name) => {
  const node = {
    where: () => node,
    limit: () => node,
    orderBy: () => node,
    doc: () => node,
    get: async () => ({ data: [] }),
    update: async () => ({ stats: { updated: 1 } }),
    add: async (arg) => {
      const data = arg && arg.data;
      (Array.isArray(data) ? data : [data]).forEach((d) => writes.push({ collection: name, data: d }));
      return { _id: 'x' };
    }
  };
  return node;
};

const dbStub = { collection: (name) => q(name), command: { inc: (n) => n } };

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
    return {
      callLLM: async () => JSON.stringify({ reply: LLM_REPLY, action: 'chat', targetId: null, newTime: null }),
      callLLMWebSearch: async () => null
    };
  }
  return origLoad.apply(this, arguments);
};

let LLM_REPLY = '这是一段正常的回答';
const chat = require(path.join(ROOT, 'cloudfunctions', 'chat', 'index.js'));
const extract = require(path.join(ROOT, 'cloudfunctions', 'extract', 'index.js'));

let fail = 0;
const check = (name, cond, detail) => {
  if (!cond) fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const modRecords = () => writes.filter((w) => w.collection === 'moderation_failures').map((w) => w.data);
const reset = () => { calls = []; writes = []; mode = 'normal'; };

(async () => {
  console.log('\n=== A. risky 输入 → 拒答 ===');
  reset();
  const a = await chat.main({ message: 'BAD 帮我做点不该做的事' });
  check('A1 返回拒答话术', a && a.reply && a.reply.includes('我不能处理'), `reply=${a && a.reply}`);
  check('A2 action 保持 chat', a && a.action === 'chat', `action=${a && a.action}`);
  check('A3 msgSecCheck 被调用且收到用户输入', calls.length >= 1 && String(calls[0].content).includes('BAD'), `calls=${calls.length}`);
  check('A4 违规输入不消耗额度（未走到 LLM）', calls.length === 1, `calls=${calls.length}`);

  console.log('\n=== B. pass 输入 + risky 输出 → 输出侧拒答 ===');
  reset();
  LLM_REPLY = '这里包含 BAD 内容';
  const b = await chat.main({ message: '你好' });
  check('B1 最终 reply 被替换为拒答', b && b.reply && b.reply.includes('我不能处理'), `reply=${b && b.reply}`);
  check('B2 输出侧确实过检（有含 LLM 回复的调用）', calls.some((c) => String(c.content).includes('BAD')), `contents=${calls.map((c) => String(c.content).slice(0, 12)).join('|')}`);

  console.log('\n=== C. pass 输入 + pass 输出 → 正常返回 ===');
  reset();
  LLM_REPLY = '这是一段正常的回答';
  const c = await chat.main({ message: '你好' });
  check('C1 reply 原样返回', c && c.reply && c.reply.includes('正常的回答'), `reply=${c && c.reply}`);
  check('C2 输入与输出各过检一次', calls.length >= 2, `calls=${calls.length}`);
  check('C3 正常路径不写 failure 记录', modRecords().length === 0, `records=${modRecords().length}`);


  console.log('\n=== D. 超时 → fail-closed（拒绝 + 留证，不含原文） ===');
  reset();
  mode = 'timeout';
  const SENTINEL = '超时原文-SENTINEL-9527';
  const d = await chat.main({ message: SENTINEL });
  mode = 'normal';
  const dRecs = modRecords();
  check('D1 请求被拒绝（不给正常回复）', d && d.reply && !d.reply.includes(SENTINEL), `reply=${d && d.reply}`);
  check('D2 提示可理解且不冒充违规', d && d.reply.includes('暂时无法校验'), `reply=${d && d.reply}`);
  check('D3 写入恰好 1 条 failure 记录', dRecs.length === 1, `records=${dRecs.length}`);
  check('D4 记录含 openid/action/errCode/ts/hash 且 reason=unavailable', dRecs.length === 1 && dRecs[0].openid === 'test-openid' && dRecs[0].action === 'input' && dRecs[0].errCode === 'ETIMEDOUT' && Boolean(dRecs[0].ts) && dRecs[0].reason === 'unavailable', dRecs.length ? JSON.stringify(dRecs[0]) : 'no record');
  check('D5 记录不含原文，只有 hash', dRecs.length === 1 && !JSON.stringify(dRecs[0]).includes('SENTINEL') && /^[0-9a-f]{32}$/.test(dRecs[0].textHash), `textHash=${dRecs[0] && dRecs[0].textHash}`);

  console.log('\n=== E. 明确违规（87014 异常）→ 与「无法判定」分开记 ===');
  reset();
  mode = 'violation';
  const e = await chat.main({ message: '违规原文-VIOLATE-4242' });
  mode = 'normal';
  const eRecs = modRecords();
  check('E1 走「内容不能处理」话术，而不是「稍后再试」', e && e.reply.includes('我不能处理') && !e.reply.includes('暂时无法校验'), `reply=${e && e.reply}`);
  check('E2 记录 reason=violation / errCode=87014，且不含原文', eRecs.length === 1 && eRecs[0].reason === 'violation' && eRecs[0].errCode === 87014 && !JSON.stringify(eRecs[0]).includes('VIOLATE'), eRecs.length ? JSON.stringify(eRecs[0]) : 'no record');

  console.log('\n=== F. extract：超时同样 fail-closed + 留证 ===');
  reset();
  mode = 'timeout';
  const fErr = await extract.main({ content: '提取原文-EXTRACT-8888' }).then(() => null, (err) => err);
  mode = 'normal';
  const fRecs = modRecords();
  check('F1 extract 抛错拒绝', Boolean(fErr), fErr ? fErr.message : 'no throw');
  check('F2 错误信息可理解（不暴露内部错误码）', Boolean(fErr) && fErr.message.includes('暂时无法校验') && !fErr.message.includes('ETIMEDOUT'), fErr && fErr.message);
  check('F3 写入恰好 1 条 action=extract 的记录', fRecs.length === 1 && fRecs[0].action === 'extract' && fRecs[0].reason === 'unavailable', `records=${fRecs.length}`);
  check('F4 记录不含原文，只有 hash', fRecs.length === 1 && !JSON.stringify(fRecs[0]).includes('EXTRACT') && /^[0-9a-f]{32}$/.test(fRecs[0].textHash), `textHash=${fRecs[0] && fRecs[0].textHash}`);

  console.log(`\n######## 失败 ${fail} ########`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('harness error:', e);
  process.exit(1);
});
