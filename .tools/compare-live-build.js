// 对比线上与本地产物里，本轮修复的关键标记是否存在。
// 用途：判断「修复到底上线了没有」——静态检索产物，不等于运行时验证，
// 但足以判断某段代码**有没有被打进包**。
const fs = require('fs');

const MARKS = [
  ['内容信任过滤（hacked by 签名规则）', /hacked\s+by/i],
  ['信任过滤日志标记 trust filter', /trust filter dropped/],
  ['信任过滤护栏常量', /rpc-not-allowed|no-cloud-session|aiEnabled/],
  ['aiEnabled 三态字段', /aiEnabled/],
  ['免费档档位说明文案', /intelFreeNote|暂不含 AI 提炼|免费版/],
  ['RPC 白名单三件套', /webSearch/],
  ['H5 真会话档案', /no-cloud-session/],
  ['ui-scale 数值钳制', /ui-scale/]
];

function report(file, label) {
  if (!fs.existsSync(file)) {
    console.log(`--- ${label} --- 文件不存在: ${file}\n`);
    return null;
  }
  const s = fs.readFileSync(file, 'utf8');
  console.log(`--- ${label} (${(s.length / 1024).toFixed(0)} KB) ---`);
  for (const [name, re] of MARKS) {
    const hit = re.test(s);
    console.log(`  ${hit ? '有' : '无'}   ${name}${hit ? '  ←' + (s.match(re) || [''])[0].slice(0, 40) : ''}`);
  }
  console.log('');
  return s;
}

const live = report(process.argv[2], '线上 app.2fedd178.js');
const local = report(process.argv[3], '本地 app.a8cbdfbb.js');

if (live && local) {
  const same = live === local;
  console.log(same ? '两份产物字节完全一致' : '两份产物**不一致**（内容已不同）');
}