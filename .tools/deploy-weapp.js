/**
 * 小程序真实部署一键脚本（miniprogram-ci）
 * 用法（先在微信后台 mp.weixin.qq.com 拿到两样东西）：
 *   1. 真实 AppID（开发管理→开发设置）
 *   2. 代码上传密钥文件 private.key（开发设置→小程序代码上传→下载）；同时把本机 IP 加入 IP 白名单
 * 然后运行：
 *   node .tools/deploy-weapp.js --appid wx1234567890abcdef --key D:\path\private.key [--env default] [--upload]
 *   --upload 同时上传体验版（缺省只部署云函数）
 * 凭据也可用环境变量 WX_APPID / WX_PRIVATE_KEY 传入，避免留在命令历史。
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const args = {};
process.argv.slice(2).forEach((a, i, arr) => {
  if (a.startsWith('--')) args[a.slice(2)] = arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true;
});

const appid = args.appid || process.env.WX_APPID || '';
let keyPath = args.key || process.env.WX_PRIVATE_KEY || path.join(ROOT, 'private.key');
const cloudEnv = args.env || process.env.WX_CLOUD_ENV || 'default';
const doUpload = !!args.upload;

if (!appid) {
  console.error('[MISSING] --appid 或环境变量 WX_APPID（在 mp.weixin.qq.com 开发设置里查看）');
  process.exit(1);
}
if (!fs.existsSync(keyPath)) {
  console.error(`[MISSING] 上传密钥文件不存在: ${keyPath}`);
  console.error('去 mp.weixin.qq.com 开发管理→开发设置→小程序代码上传密钥 下载，并关闭"上传密钥误传保护"提示后保存为 private.key');
  process.exit(1);
}

const ci = require('miniprogram-ci');

async function main() {
  const project = new ci.Project({
    appid,
    type: 'miniProgram',
    projectPath: ROOT,
    privateKeyPath: keyPath,
    ignores: ['node_modules/**/*', '.git/**/*', 'dist/**/*', 'src/**/*']
  });

  // 1) 批量部署云函数（远端装依赖）
  const fns = fs
    .readdirSync(path.join(ROOT, 'cloudfunctions'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(ROOT, 'cloudfunctions', d.name, 'index.js')))
    .map((d) => d.name);

  let ok = 0;
  const failed = [];
  for (const name of fns) {
    try {
      await ci.cloud.uploadFunction({
        project,
        env: cloudEnv,
        name,
        path: path.join(ROOT, 'cloudfunctions', name),
        remoteNpmInstall: true
      });
      console.log(`[OK] 云函数 ${name}`);
      ok += 1;
    } catch (err) {
      console.error(`[FAIL] 云函数 ${name}: ${err.message}`);
      failed.push(name);
    }
  }
  console.log(`云函数部署完成: ${ok}/${fns.length}${failed.length ? '，失败: ' + failed.join(',') : ''}`);

  // 2) 上传体验版
  if (doUpload) {
    try {
      const result = await ci.upload({
        project,
        version: args.version || `1.1.${new Date().toISOString().slice(5, 10).replace('-', '')}`,
        desc: args.desc || 'v1.1: F20/F21/F22/F24 + 多语种学习平台 + 真实数据',
        setting: { es6: false, minified: false, autoPrefixWXSS: true },
        onProgressUpdate: () => {}
      });
      console.log(`[OK] 体验版已上传 (packageSize: ${Math.round((result.subPackageInfo?.[0]?.size || 0) / 1024)}KB)`);
      console.log('去 mp.weixin.qq.com 版本管理→开发版本 设为体验版并加入体验成员');
    } catch (err) {
      console.error(`[FAIL] 体验版上传: ${err.message}`);
      process.exit(2);
    }
  }

  // 3) 云函数环境变量提醒（部署不覆盖已配置的变量，但新环境必须配）
  console.log('\n[提醒] 云开发控制台确认以下环境变量已配置（chat/extract/webSearch/getBriefing 需要）：');
  console.log('  LLM_API_KEY      DeepSeek 密钥（必填，主链路）');
  console.log('  LLM_WEB_API_KEY  通义 DashScope 密钥（可选，购物联网比价）');
  console.log('  WEATHER_KEY      和风天气密钥（可选，缺省走 Open-Meteo 兜底）');
  if (failed.length) process.exit(3);
}

main().catch((err) => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
