// 变异用例：学习模块整合（harness: .tools/verify-learn-sources.mjs）
// 每个 case 的 from 都必须在目标文件里**正好出现一次**（工具会断言）。
export default [
  {
    label: '把 Plus 进度塞进外部来源卡 → 单一进度源断言必红',
    file: 'src/components/LearnSources/index.tsx',
    from: "<Text className={styles.desc}>{t('learn.plusDesc')}</Text>",
    to: "<Text className={styles.desc}>{t('learn.plusDesc')}{stats.percent}%</Text>",
    cmd: 'node .tools/verify-learn-sources.mjs'
  },
  {
    label: '删掉入口卡 min-height → 44px 热区断言必红',
    file: 'src/components/LearnSources/index.module.scss',
    from: '  min-height: 88rpx; margin: 0 $page-padding $spacing-md;',
    to: '  margin: 0 $page-padding $spacing-md;',
    cmd: 'node .tools/verify-learn-sources.mjs'
  },
  {
    label: '远程课程数据为空时不回落 → 兜底文案断言必红',
    file: 'src/utils/learnSources.ts',
    from: "    typeof value === 'string' && value.trim() ? value.trim() : fb;",
    to: "    typeof value === 'string' ? value : '';",
    cmd: 'node .tools/verify-learn-sources.mjs'
  }
];
