/**
 * deploy-cloud.mjs —— 云函数一键部署（上线三件事 · 填空即用）
 *
 * 用法：npm run deploy:cloud（等价 node .tools/deploy-cloud.mjs）
 *
 * 配置来源：D:/Agent/.env.local（该文件为服务端本地文件，不会进小程序包），三个约定 key：
 *   WX_APPID=             小程序 AppID
 *   WX_PRIVATE_KEY_PATH=  代码上传密钥文件的绝对路径
 *   WX_CLOUD_ENV=         微信云开发环境 ID
 *
 * 缺任一配置：打印中文引导并以退出码 2 结束（不抛堆栈）。
 * 上传实现：miniprogram-ci 的 ci.Project + ci.cloud.uploadFunction（单函数粒度，逐个上传；
 * API 签名已对照 node_modules/miniprogram-ci/dist/@types/ci/cloud/uploadFunction.d.ts 核实）。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(ROOT, '.env.local');

/** 解析 key=value 风格的 .env.local（容忍注释、空行、引号包裹） */
function readEnvLocal(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq <= 0) continue;
      out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* 文件不存在按未配置处理 */ }
  return out;
}

const env = readEnvLocal(ENV_FILE);
const appid = env.WX_APPID || '';
const privateKeyPath = env.WX_PRIVATE_KEY_PATH || '';
const cloudEnv = env.WX_CLOUD_ENV || '';

/* ---------- 缺配置：中文引导分支（exit 2，不抛堆栈） ---------- */
const missing = [
  ['WX_APPID', appid,
    'mp.weixin.qq.com 用注册邮箱登录小程序后台 → 「管理 → 开发管理 → 开发设置」页首即 AppID（小程序 ID），复制粘贴'],
  ['WX_PRIVATE_KEY_PATH', privateKeyPath,
    '同一「开发设置」页 → 「小程序代码上传」小节 → 点击「生成」并下载代码上传密钥（.key 文件），保存到本机任意位置（建议放 D:/Agent 外的私有目录，切勿提交进仓库），此处填该文件的绝对路径；如已开启 IP 白名单，需把本机出口 IP 加入白名单或临时关闭'],
  ['WX_CLOUD_ENV', cloudEnv,
    'mp.weixin.qq.com → 「云开发」进入云开发控制台 → 首页环境列表中的「环境 ID」（形如 cloud1-2gabcdef12345678）']
].filter(([, v]) => !v);

if (missing.length) {
  console.log('✋ 缺少部署配置，本次不执行上传。请编辑 ' + ENV_FILE + '，逐行补齐以下 key（格式 key=value）：\n');
  for (const [k, , guide] of missing) {
    console.log('  · ' + k);
    console.log('    获取方式：' + guide + '\n');
  }
  console.log('补齐后重新运行：npm run deploy:cloud');
  process.exit(2);
}

if (!fs.existsSync(privateKeyPath)) {
  console.log('✋ 上传密钥文件不存在：' + privateKeyPath);
  console.log('   WX_PRIVATE_KEY_PATH 必须指向真实存在的密钥文件（下载自微信后台「开发设置 → 小程序代码上传 → 密钥管理」）。');
  process.exit(2);
}

/* ---------- 收集云函数：以 cloudfunctions/ 实际目录为准（含 index.js 才有效） ---------- */
const FN_DIR = path.join(ROOT, 'cloudfunctions');
const fns = fs.readdirSync(FN_DIR)
  .filter((n) => fs.statSync(path.join(FN_DIR, n)).isDirectory() && fs.existsSync(path.join(FN_DIR, n, 'index.js')))
  .sort();
if (!fns.length) {
  console.log('cloudfunctions/ 下没有可上传的函数（每个函数目录需含 index.js）。');
  process.exit(2);
}

/* ---------- 加载 miniprogram-ci 并逐个上传 ---------- */
try {
  const ciMod = await import('miniprogram-ci');
  const ci = ciMod.default ?? ciMod;

  const project = new ci.Project({
    appid,
    type: 'miniProgram',
    projectPath: ROOT,
    privateKeyPath,
    ignores: ['node_modules/**/*']
  });

  console.log('▲ 开始部署云函数 → 环境 ' + cloudEnv + '（appid ' + appid + '）');
  console.log('  待上传 ' + fns.length + ' 个：' + fns.join('、') + '\n');

  let ok = 0;
  const fails = [];
  for (const name of fns) {
    try {
      const r = await ci.cloud.uploadFunction({
        project,
        env: cloudEnv,
        name,                                  // remote 函数名 = 目录名
        path: path.join(FN_DIR, name),
        remoteNpmInstall: true                 // 云端安装依赖（函数目录有 package.json 时生效）
      });
      const kb = r && r.packSize != null ? Math.round(r.packSize / 1024) + ' KB' : '?';
      console.log('✅ ' + name + ' 上传成功（' + (r && r.filesCount != null ? r.filesCount + ' 个文件' : 'ok') + '，' + kb + '）');
      ok++;
    } catch (e) {
      console.error('❌ ' + name + ' 上传失败：' + (e && e.message ? e.message : String(e)));
      fails.push(name);
    }
  }

  console.log('-----------------------------------------');
  console.log('部署完成：成功 ' + ok + ' / 失败 ' + fails.length + '（共 ' + fns.length + '）');
  if (fails.length) {
    console.log('失败函数：' + fails.join('、'));
    console.log('常见原因：密钥过期 / IP 白名单限制 / 环境 ID 写错 / 函数名含非法字符。详见 docs/云函数部署指南.md');
    process.exit(1);
  }
} catch (e) {
  console.error('✋ miniprogram-ci 初始化失败：' + (e && e.message ? e.message : String(e)));
  console.error('   可尝试 npm install 修复依赖，或改走路径 B（微信开发者工具右键上传，见 docs/云函数部署指南.md）。');
  process.exit(1);
}
