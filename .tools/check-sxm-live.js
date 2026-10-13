// 检查「新增的 sxm / 合作入口」是否已打进产物。
// 用途：判断这三天的新功能到底上线了没有。
const fs = require('fs');

const MARKS = [
  ['sxm 页面路由', /pages\/sxm\/index/],
  ['灵犀课堂域名', /bb6ae4d03fbd4b109cbbe6dbbc84502d/],
  ['省心买 GitHub Pages', /soloassistant\.github\.io\/shengxinmai/],
  ['PartnerEntry 组件', /PartnerEntry/],
  ['openExternalPage', /openExternalPage/],
  ['机票平台 / 无深链提示', /flightNoDeeplink/]
];

for (let i = 2; i < process.argv.length; i += 2) {
  const file = process.argv[i];
  const label = process.argv[i + 1];
  if (!fs.existsSync(file)) {
    console.log(`--- ${label} --- 文件不存在\n`);
    continue;
  }
  const s = fs.readFileSync(file, 'utf8');
  console.log(`--- ${label} (${(s.length / 1024).toFixed(0)} KB) ---`);
  for (const [n, re] of MARKS) {
    console.log(`  ${re.test(s) ? '有' : '无'}   ${n}`);
  }
  console.log('');
}
