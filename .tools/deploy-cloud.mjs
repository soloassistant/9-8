/**
 * deploy-cloud.mjs —— 云函数一键部署（上线三件事 · 填空即用）
 *
 * 用法：
 *   npm run deploy:cloud           正常部署（预检全过才上传）
 *   npm run deploy:cloud:check     只做预检 + 打印待配环境变量清单，不上传
 *
 * 配置来源：D:/Agent/晨报/.env.local（该文件为服务端本地文件，不会进小程序包），三个约定 key：
 *   WX_APPID=             小程序 AppID
 *   WX_PRIVATE_KEY_PATH=  代码上传密钥文件的绝对路径
 *   WX_CLOUD_ENV=         微信云开发环境 ID
 *
 * 缺任一配置：打印中文引导并以退出码 2 结束（不抛堆栈）。
 * 格式不对：同样 exit 2，但给出**具体哪里不对**（AppID 位数 / 密钥不是 RSA 私钥 / 环境 ID 像环境名）。
 *   这一步存在的理由：这些错误原本要等 ci.cloud.uploadFunction 真发请求才暴露，
 *   而上传是逐个函数跑的 —— 配置错会留下「前 3 个传上去了、后面全失败」的半残环境。
 * 上传实现：miniprogram-ci 的 ci.Project + ci.cloud.uploadFunction（单函数粒度，逐个上传；
 * API 签名已对照 node_modules/miniprogram-ci/dist/@types/ci/cloud/uploadFunction.d.ts 核实）。
 *
 * 上传完成后会打印「还需在控制台配置哪些环境变量」——逐个函数扫描 process.env 得出。
 * 这补的是既有待办清单里最危险的那类缺口：函数传上去了但 env 没配，
 * 表现为「部署成功、功能全空」，而且不报错。
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 允许用 DEPLOY_ENV_FILE 指向另一份配置文件 —— 只为让预检各分支可被自动化验证，
// 不必去改真 .env.local（里面还有 LLM 密钥）。
const ENV_FILE = process.env.DEPLOY_ENV_FILE
  ? path.resolve(process.env.DEPLOY_ENV_FILE)
  : path.join(ROOT, '.env.local');

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
const CHECK_ONLY = process.argv.includes('--check');

/* ---------- 缺配置：中文引导分支（exit 2，不抛堆栈） ---------- */
const missing = [
  ['WX_APPID', appid,
    'mp.weixin.qq.com 用注册邮箱登录小程序后台 → 「管理 → 开发管理 → 开发设置」页首即 AppID（小程序 ID），复制粘贴'],
  ['WX_PRIVATE_KEY_PATH', privateKeyPath,
    '同一「开发设置」页 → 「小程序代码上传」小节 → 点击「生成」并下载代码上传密钥（.key 文件），保存到本机任意位置（建议放 D:/Agent/晨报 外的私有目录，切勿提交进仓库），此处填该文件的绝对路径；如已开启 IP 白名单，需把本机出口 IP 加入白名单或临时关闭'],
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

/* ---------- 格式预检：把「要等上传才暴露」的错误提前到本地 ---------- */
const formatProblems = [];

if (!/^wx[0-9a-fA-F]{16}$/.test(appid)) {
  formatProblems.push(
    `WX_APPID 格式不对：「${appid}」—— 应为 wx + 16 位十六进制（共 18 个字符）。` +
      '常见错误：把「小程序名称」或「原始 ID（gh_ 开头）」当成 AppID。'
  );
}

if (!fs.existsSync(privateKeyPath)) {
  formatProblems.push(
    `WX_PRIVATE_KEY_PATH 指向的文件不存在：${privateKeyPath}\n` +
      '     应为微信后台「开发设置 → 小程序代码上传 → 密钥管理」下载的 .key 文件绝对路径。'
  );
} else {
  let pem = '';
  try {
    pem = fs.readFileSync(privateKeyPath, 'utf8');
  } catch (err) {
    formatProblems.push(`上传密钥文件读不出来：${privateKeyPath}（${err && err.message}）`);
  }
  if (pem) {
    if (!/-----BEGIN (RSA )?PRIVATE KEY-----/.test(pem)) {
      formatProblems.push(
        '上传密钥文件不是 PEM 私钥（找不到 BEGIN PRIVATE KEY 头）。' +
          '可能下成了「代码上传密钥」以外的文件，或下载被截断。'
      );
    } else {
      try {
        const key = crypto.createPrivateKey(pem);
        if (key.asymmetricKeyType !== 'rsa') {
          formatProblems.push(`上传密钥不是 RSA 私钥（实际类型：${key.asymmetricKeyType}）。`);
        }
      } catch (err) {
        formatProblems.push(`上传密钥无法解析为私钥：${err && err.message}`);
      }
    }
  }
}

if (!/^[A-Za-z0-9][A-Za-z0-9_-]{3,}$/.test(cloudEnv)) {
  formatProblems.push(
    `WX_CLOUD_ENV 格式不对：「${cloudEnv}」—— 云开发环境 ID 只含字母、数字、- 和 _。` +
      '常见错误：填成了「环境名称」（可含中文/空格），应填控制台首页那个环境 ID。'
  );
}

if (formatProblems.length) {
  console.log('✋ 配置格式检查未通过，本次不执行上传（避免留下半残环境）：\n');
  for (const p of formatProblems) console.log('  · ' + p);
  console.log('\n修改 ' + ENV_FILE + ' 后重新运行：' + (CHECK_ONLY ? 'npm run deploy:cloud:check' : 'npm run deploy:cloud'));
  console.log('只想先确认格式不上传：npm run deploy:cloud:check');
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

/* ---------- 扫描每个函数读取的环境变量 ---------- *
 * 只读函数目录顶层的 .js 文件（不递归 node_modules）：llm.js / news-trust.js /
 * cross-source.js 也在同一层，process.env 往往就写在里面。
 * 这一步补的是既有待办清单里最阴的缺口：函数上传成功、env 没配 →
 * 不报错、只是某个区块永远是空的（典型是 INTERNAL_CALL_TOKEN 和 WEATHER_KEY）。
 */
function collectEnvVars(dirs) {
  const plan = [];
  for (const name of dirs) {
    const dir = path.join(FN_DIR, name);
    const jsFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
    const vars = new Set();
    for (const f of jsFiles) {
      let code = '';
      try {
        code = fs.readFileSync(path.join(dir, f), 'utf8');
      } catch {
        continue;
      }
      for (const m of code.matchAll(/process\.env\.([A-Z][A-Z0-9_]{2,})/g)) vars.add(m[1]);
    }
    if (vars.size) plan.push({ name, vars: [...vars].sort() });
  }
  return plan;
}

const envPlan = collectEnvVars(fns);

function printEnvPlan(title) {
  if (!envPlan.length) return;
  console.log(title);
  for (const { name, vars } of envPlan) {
    const tagged = vars.map((v) => (env[v] ? v + ' ✓' : v));
    console.log('  · ' + name.padEnd(13) + ' → ' + tagged.join(', '));
  }
  const uniq = [...new Set(envPlan.flatMap((x) => x.vars))].sort();
  const notLocal = uniq.filter((v) => !env[v]);
  console.log('');
  console.log('  共 ' + uniq.length + ' 个变量；本机 .env.local 里有 ' + (uniq.length - notLocal.length) + ' 个可作参考（✓）。');
  console.log('  ⚠ ✓ 只表示「本机这个文件里有值」，**不代表云上已配** —— 脚本无权探测云函数的环境变量。');
  console.log('    云上是否配齐需要你在云开发控制台逐个核对。');
  if (notLocal.length) {
    console.log('  ⚠ 连本机都没有的 ' + notLocal.length + ' 个：' + notLocal.join(', '));
    console.log('    没配不会报错，只会让对应功能静默降级/为空。');
    console.log('    注意 INTERNAL_CALL_TOKEN 要同时配在 getBriefing 与 webSearch，且值必须相同。');
  }
  console.log('');
}

if (CHECK_ONLY) {
  console.log('✅ 预检通过（未上传）');
  console.log('   AppID    ' + appid);
  console.log('   环境     ' + cloudEnv);
  console.log('   密钥     ' + privateKeyPath + '（PEM RSA 私钥，可解析）');
  console.log('   待部署   ' + fns.length + ' 个函数：' + fns.join('、'));
  console.log('');
  printEnvPlan('—— 部署后必须在控制台配置的环境变量 ——');
  console.log('确认无误后执行：npm run deploy:cloud');
  process.exit(0);
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
  printEnvPlan('—— 传完还需在控制台配置的环境变量（没配不会报错，只会功能为空）——');
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
