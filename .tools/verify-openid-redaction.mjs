import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = process.cwd();
const require = createRequire(import.meta.url);
const FILES = ['auth-douyin', 'getBriefing', 'queryOrder', 'pay-callback'];

const cases = [
  { input: '', want: '' },
  { input: null, want: '' },
  { input: 'abc', want: '***' },
  { input: 'o1234567', want: '********' },
  { input: '张三李四王五', want: '******' },
  { input: 'o123456789012345678901234567', want: 'o123' + '*'.repeat(20) + '4567' },
];

let failed = 0;
for (const dir of FILES) {
  const mod = require(path.join(ROOT, 'cloudfunctions', dir, 'maskId.js'));
  for (const c of cases) {
    const got = mod(c.input);
    if (got !== c.want) {
      failed++;
      console.log(`FAIL ${dir}/maskId.js input=${JSON.stringify(c.input)} got=${JSON.stringify(got)} want=${JSON.stringify(c.want)}`);
    }
  }
  // 静态断言：该云函数里所有含 openid 的日志行都必须经过 maskId
  const src = fs.readFileSync(path.join(ROOT, 'cloudfunctions', dir, 'index.js'), 'utf8').split('\n');
  src.forEach((line, i) => {
    // 去掉字符串字面量后再看：只剩「值」意义上的 openid 才算未脱敏
    const codeOnly = line.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""').replace(/`[^`]*`/g, '``');
    if (/console\.(log|info|warn|error)/.test(codeOnly) && /\bopenid\b/i.test(codeOnly) && !/maskId\(/.test(line)) {
      failed++;
      console.log(`FAIL ${dir}/index.js:${i + 1} 日志含 openid 但未脱敏: ${line.trim()}`);
    }
  });
}
console.log(failed === 0 ? 'OPENID REDACTION PASS' : `OPENID REDACTION FAIL ${failed} case(s)`);
process.exit(failed === 0 ? 0 : 1);
