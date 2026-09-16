const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const failures = [];

function read(relativePath) {
  const file = path.join(root, relativePath);
  if (!fs.existsSync(file)) {
    failures.push(relativePath + ' 不存在');
    return '';
  }
  return fs.readFileSync(file, 'utf8');
}

const hostFiles = [
  'src/app.config.ts',
  'src/pages/mine/index.tsx',
  'src/services/cloudSync.ts'
];
const forbiddenHostImport = /@\/features\/learning\/(?:data|storage|achievements|pages)(?:['"/]|$)/;

for (const file of hostFiles) {
  const source = read(file);
  if (forbiddenHostImport.test(source)) {
    failures.push(file + ' 仍然深度导入学习平台内部实现');
  }
}

const wrappers = [
  ['src/pages/learn/index.tsx', 'learn'],
  ['src/pages/learnCommunity/index.tsx', 'learnCommunity'],
  ['src/pages/learnDetail/index.tsx', 'learnDetail']
];
for (const [file, page] of wrappers) {
  const source = read(file);
  const expected = new RegExp(
    "export\\s*\\{\\s*default\\s*\\}\\s*from\\s*['\"]@/features/learning/pages/" + page + "['\"]\\s*;?"
  );
  if (!expected.test(source)) {
    failures.push(file + ' 不是允许的 Taro 薄适配器');
  }
}

const publicEntry = read('src/features/learning/index.ts');
if (/\bexport\s+\*/.test(publicEntry)) {
  failures.push('src/features/learning/index.ts 不能使用 export *');
}

const rootPackage = JSON.parse(read('package.json') || '{}');
if (JSON.stringify(rootPackage.workspaces) !== JSON.stringify(['apps/*', 'packages/*'])) {
  failures.push('根 package.json 未声明约定的 workspace');
}

const projectConfig = read('tsconfig.projects.json');
if (!projectConfig.includes('./packages/learning-core') || !projectConfig.includes('./apps/learning-web')) {
  failures.push('tsconfig.projects.json 未覆盖 learning-core 和 learning-web');
}

const appConfig = read('src/app.config.ts');
const hostAdapter = read('src/pages/learn/routes.host.ts');
if (!appConfig.includes('...LEARNING_PAGE_PATHS') || !hostAdapter.includes('LEARNING_PAGE_PATHS')) {
  failures.push('Taro 宿主没有通过 routes.host 注册学习页面清单');
}

if (!read('.gitignore').includes('dist-learning') || !read('.vercelignore').includes('dist-learning')) {
  failures.push('主产品忽略规则未隔离 dist-learning');
}

if (failures.length) {
  console.error('学习平台边界检查失败：');
  failures.forEach((failure) => console.error('- ' + failure));
  process.exit(1);
}

console.log('学习平台边界检查通过：宿主仅通过适配层接入，workspace 工程边界已登记。');
