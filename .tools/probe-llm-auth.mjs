#!/usr/bin/env node
/**
 * probe-llm-auth.mjs —— AI 通路鉴权双态探针（2026-10-31）。
 *
 * 背景：48 组门禁全是静态/渲染级，「带真会话的 AI 调用链」零覆盖——用户实测
 * 「AI 助理不工作」时无法自查。本探针补这一条：
 *   · 匿名腿（总是跑）：未登录调 llm 必须返回 404 request_route_not_allowed
 *     （平台按会话收敛 AI 通路；返回 200/其他 = 平台行为变了，要重新评估）
 *   · 登录腿（可选，需真实测试账号）：设置环境变量 WB_TEST_ID / WB_TEST_PASSWORD 后，
 *     用 SDK 同款 /v1/signin 换真会话 → 调 llm → 断言非 404（200/429/额度类业务码皆可，
 *     唯独不能再是 request_route_not_allowed）。缺凭据时 SKIP 并说明，不算失败。
 *
 * 用法: node .tools/probe-llm-auth.mjs [--base <url>]
 * 退出码: 0 = 匿名腿符合预期（登录腿被跳过时也 0）；1 = 任一已跑的腿不符合预期
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const KEY = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'services', 'cloudAuth.ts'), 'utf8').match(/wbpk_[A-Za-z0-9_]*/)[0];
const H = (process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : '').replace(/\/$/, '') || 'https://48f86dcd48e3462dbe897b5fce534551.app.workbuddy.host';
const call = async (method, p, body, token) => {
  const res = await fetch(H + p, {
    method,
    headers: { Origin: H, 'X-Wb-Webapp-Access-Key': KEY, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.text()).slice(0, 200) };
};
(async () => {
  let bad = 0;
  console.log(`目标：${H}`);
  const anon = await call('POST', '/.cloud/llm/v1/chat/completions', { model: 'probe', messages: [{ role: 'user', content: 'ping' }] });
  const anonOk = anon.status === 404 && /request_route_not_allowed/.test(anon.body);
  console.log(`匿名腿: ${anon.status} ${anon.body.slice(0, 90)} → ${anonOk ? 'PASS（未登录被平台收敛，符合预期）' : 'FAIL（平台行为变化，重新评估！）'}`);
  if (!anonOk) bad += 1;

  const id = process.env.WB_TEST_ID;
  const pwd = process.env.WB_TEST_PASSWORD;
  if (!id || !pwd) {
    console.log('登录腿: SKIP（未设 WB_TEST_ID / WB_TEST_PASSWORD —— 提供真实测试账号后重跑即可补上登录态断言）');
  } else {
    const signin = await call('POST', '/.cloud/auth/v1/signin', { username: id, password: pwd });
    let token = null;
    try { token = JSON.parse(signin.body).access_token || null; } catch { /* ignore */ }
    if (!signin.status.toString().startsWith('2') || !token) {
      console.log(`登录腿: FAIL（登录失败 ${signin.status} ${signin.body.slice(0, 80)}）`);
      bad += 1;
    } else {
      const authed = await call('POST', '/.cloud/llm/v1/chat/completions', { model: 'probe', messages: [{ role: 'user', content: 'ping' }] }, token);
      const authedOk = authed.status !== 404 || !/request_route_not_allowed/.test(authed.body);
      console.log(`登录腿: ${authed.status} ${authed.body.slice(0, 90)} → ${authedOk ? 'PASS（登录后 AI 通路可达）' : 'FAIL（登录后仍 404 = 平台未按会话放行）'}`);
      if (!authedOk) bad += 1;
    }
  }
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => { console.error('probe error:', e.message); process.exit(2); });
