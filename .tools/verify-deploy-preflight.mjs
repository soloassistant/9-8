/**
 * verify-deploy-preflight.mjs —— 云函数部署预检的分支回归
 *
 * 用法：node .tools/verify-deploy-preflight.mjs（等价 npm run verify:deploy）
 *
 * 为什么需要它：
 *   `.tools/deploy-cloud.mjs` 是唯一会把代码推上微信云的那条路，而它**无法在无凭据环境里
 *   端到端跑通**——所以过去只验证过「缺配置时 exit 2」这一个分支，剩下的分支
 *   （AppID 格式、密钥不是 RSA、环境 ID 写成环境名）从来没被执行过一次。
 *   这些分支恰恰是最贵的：它们失败的位置在「上传到一半」，会留下
 *   「前几个函数传上去了、后面全挂」的半残环境。
 *
 * 做法：用 DEPLOY_ENV_FILE 指向临时配置文件，把每个分支都真跑一遍，
 *   断言退出码 + 输出里必须出现的那句话。最后再跑一次真 .env.local，确认它如实反映现状。
 *   全程 --check 模式，不联网、不加载 miniprogram-ci、不上传。
 *
 * 断言纪律：只有 cond === true 才算 PASS；失败分支不得返回非空字符串。
 */
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, '.tools', 'deploy-cloud.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-preflight-'));

/** 期望的云函数个数**从磁盘现算**，不写死数字。
 *  写死会在每次新增云函数时假红（redeemCode 之后就从 25 漂到 26，门禁红了一轮才发现
 *  红的原因是「断言过期」而不是「部署脚本坏了」——这类假红会训练人忽略门禁）。
 *  口径与 deploy-cloud.mjs 一致：cloudfunctions/ 下含 index.js 的目录。 */
const FUNC_COUNT = fs.readdirSync(path.join(REPO, 'cloudfunctions'))
  .filter((n) => fs.statSync(path.join(REPO, 'cloudfunctions', n)).isDirectory()
    && fs.existsSync(path.join(REPO, 'cloudfunctions', n, 'index.js'))).length;

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond === true) {
    pass += 1;
    console.log('  PASS ' + name);
  } else {
    fail += 1;
    const d = detail == null ? '' : String(detail);
    failures.push(name + (d ? ' :: ' + d : ''));
    console.log('  FAIL ' + name + (d ? '  :: ' + d : ''));
  }
}

/** 跑一次部署脚本（--check），返回 { status, out } */
function runCheck(envFile) {
  const r = spawnSync(process.execPath, [SCRIPT, '--check'], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, DEPLOY_ENV_FILE: envFile }
  });
  return { status: r.status, signal: r.signal, out: (r.stdout || '') + (r.stderr || '') };
}

/** 写一个临时配置文件；files 里是额外落盘的附加文件 */
function writeEnv(name, lines) {
  const file = path.join(TMP, name + '.env');
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

/* ---------- 造两份真实密钥 ---------- */
const rsaKeyFile = path.join(TMP, 'private.rsa.key');
{
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  fs.writeFileSync(rsaKeyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), 'utf8');
}
const ecKeyFile = path.join(TMP, 'private.ec.key');
{
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  fs.writeFileSync(ecKeyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), 'utf8');
}
const notPemFile = path.join(TMP, 'not-a-key.txt');
fs.writeFileSync(notPemFile, 'this is not a private key\n', 'utf8');

const APPID = 'wx0123456789abcdef';
const CLOUD_ENV = 'cloud1-2gabcdef12345678';

/* ================= 分支 ================= */
console.log('云函数部署预检 —— ' + SCRIPT);

console.log('\n1. 完全没配置');
{
  const f = writeEnv('empty', ['# 什么都没有']);
  const r = runCheck(f);
  ok('exit 2', r.status === 2, '实际 ' + r.status);
  ok('提示三个缺失 key', ['WX_APPID', 'WX_PRIVATE_KEY_PATH', 'WX_CLOUD_ENV'].every((k) => r.out.includes(k)));
  ok('给出获取方式而不只是报错', r.out.includes('开发设置') && r.out.includes('云开发'));
  // 环境变量清单不依赖任何凭据（只是扫 cloudfunctions/ 下的 process.env.*），
  // 所以缺凭据时也必须能看到 —— 否则用户要等三个 credential 齐了才第一次知道要配什么。
  ok('缺凭据时也打印待配环境变量清单', r.out.includes('INTERNAL_CALL_TOKEN'));
  ok('清单标明这不是「云上已配」', r.out.includes('不代表云上已配'));
  ok('清单仍然 exit 2（不上传）', r.status === 2);
}

console.log('\n2. 只填了 AppID');
{
  const f = writeEnv('only-appid', ['WX_APPID=' + APPID]);
  const r = runCheck(f);
  ok('exit 2 且只提示剩下两个', r.status === 2 && !r.out.includes('WX_APPID 获取方式'), '实际 ' + r.status);
  ok('列出缺 WX_PRIVATE_KEY_PATH', r.out.includes('WX_PRIVATE_KEY_PATH'));
}

console.log('\n3. AppID 填成「原始 ID / 名称」');
{
  const f = writeEnv('bad-appid', ['WX_APPID=gh_abcdef123456', 'WX_PRIVATE_KEY_PATH=' + rsaKeyFile, 'WX_CLOUD_ENV=' + CLOUD_ENV]);
  const r = runCheck(f);
  ok('exit 2', r.status === 2, '实际 ' + r.status);
  ok('指出 AppID 格式不对（不是笼统报错）', r.out.includes('WX_APPID 格式不对'));
}

console.log('\n4. 密钥路径指向不存在的文件');
{
  const f = writeEnv('missing-key', ['WX_APPID=' + APPID, 'WX_PRIVATE_KEY_PATH=' + path.join(TMP, 'nope.key'), 'WX_CLOUD_ENV=' + CLOUD_ENV]);
  const r = runCheck(f);
  ok('exit 2', r.status === 2, '实际 ' + r.status);
  ok('明确指出文件不存在', r.out.includes('指向的文件不存在'));
}

console.log('\n5. 密钥文件不是 PEM');
{
  const f = writeEnv('not-pem', ['WX_APPID=' + APPID, 'WX_PRIVATE_KEY_PATH=' + notPemFile, 'WX_CLOUD_ENV=' + CLOUD_ENV]);
  const r = runCheck(f);
  ok('exit 2', r.status === 2, '实际 ' + r.status);
  ok('指出不是 PEM 私钥', r.out.includes('不是 PEM 私钥'));
}

console.log('\n6. 密钥是 EC 私钥（PEM 合法但不是 RSA）');
{
  const f = writeEnv('ec-key', ['WX_APPID=' + APPID, 'WX_PRIVATE_KEY_PATH=' + ecKeyFile, 'WX_CLOUD_ENV=' + CLOUD_ENV]);
  const r = runCheck(f);
  ok('exit 2', r.status === 2, '实际 ' + r.status);
  ok('指出不是 RSA 私钥', r.out.includes('不是 RSA 私钥'));
  ok('带出实际类型便于排查', r.out.includes('ec'));
}

console.log('\n7. 环境 ID 填成环境名（含中文）');
{
  const f = writeEnv('bad-env', ['WX_APPID=' + APPID, 'WX_PRIVATE_KEY_PATH=' + rsaKeyFile, 'WX_CLOUD_ENV=我的晨报环境']);
  const r = runCheck(f);
  ok('exit 2', r.status === 2, '实际 ' + r.status);
  ok('指出环境 ID 格式不对', r.out.includes('WX_CLOUD_ENV 格式不对'));
}

console.log('\n8. 全部合法（--check 不上传）');
{
  const f = writeEnv('ok', ['WX_APPID=' + APPID, 'WX_PRIVATE_KEY_PATH=' + rsaKeyFile, 'WX_CLOUD_ENV=' + CLOUD_ENV]);
  const r = runCheck(f);
  ok('exit 0', r.status === 0, '实际 ' + r.status + (r.signal ? ' signal=' + r.signal : ''));
  ok('打印预检通过', r.out.includes('预检通过'));
  ok('列出 ' + FUNC_COUNT + ' 个待部署函数', r.out.includes(FUNC_COUNT + ' 个函数'), '磁盘上 ' + FUNC_COUNT + ' 个');
  ok('打印待配环境变量清单', r.out.includes('INTERNAL_CALL_TOKEN'));
  ok('未配置项被显式点名', r.out.includes('连本机都没有的'));
  ok('不把「本机有值」说成「云上已配」', r.out.includes('不代表云上已配'));
  ok('--check 绝不执行上传', r.out.includes('开始部署') === false);
}

console.log('\n9. 真 .env.local 的现状如实反映');
{
  // 不设 DEPLOY_ENV_FILE，走默认 .env.local
  const r = spawnSync(process.execPath, [SCRIPT, '--check'], { cwd: REPO, encoding: 'utf8', timeout: 60_000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const hasCreds = /^WX_APPID=\S+/m.test(fs.existsSync(path.join(REPO, '.env.local')) ? fs.readFileSync(path.join(REPO, '.env.local'), 'utf8') : '');
  ok('退出码与「是否已填凭据」一致', hasCreds ? r.status === 0 : r.status === 2, 'hasCreds=' + hasCreds + ' 实际 exit=' + r.status);
  if (!hasCreds) ok('缺凭据时明确告知缺哪些', out.includes('缺少部署配置'));
}

console.log('\n' + '-'.repeat(60));
console.log('PASS ' + pass + ' / FAIL ' + fail + '（共 ' + (pass + fail) + ' 条断言）');
if (fail > 0) {
  console.log('\n失败明细：');
  for (const f of failures) console.log('  · ' + f);
  process.exit(1);
}
console.log('部署预检分支回归：全绿');
