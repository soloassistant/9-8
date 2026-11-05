import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useT } from '@/store/language';
import { LINGXI_URL } from '@/config/partners';
import { openExternalPage } from '@/utils/externalLink';
import { resolveCourseMeta } from '@/utils/learnSources';
import styles from './index.module.scss';

const isH5 = process.env.TARO_ENV === 'h5';

/**
 * 学习页的「外部来源」区块：Plus 升级层（语桥）+ 课程源（灵犀课堂）。
 *
 * 这里**只做入口，不读任何学习进度**：LX 的打卡/掌握数只有 pages/learn 上方那一份，
 * 把语桥或灵犀的进度塞进同一个列表就会变成「两套进度」，verify-learn-sources 会判红。
 * 灵犀课堂实测有全屏登录墙、无学生端进度页，所以本轮不做整页内嵌，只做内容卡 + 跳转。
 */
function LearnSources() {
  const t = useT();
  // 目前没有灵犀的课程元数据接口，传 null 走兜底文案；接上接口后失败也必须回落，不能留空卡
  const course = resolveCourseMeta(null, {
    title: t('partner.lingxiTitle'),
    intro: t('learn.courseIntro'),
    duration: t('learn.courseDuration'),
    source: t('learn.courseSourceNote')
  });

  const openMembership = () => {
    Taro.navigateTo({ url: '/pages/membership/index' }).catch(() => {
      Taro.showToast({ title: t('learn.plusFail'), icon: 'none' });
    });
  };

  const openCourse = async () => {
    const result = await openExternalPage(LINGXI_URL);
    if (result === 'opened') return;
    Taro.showToast({
      title: result === 'copied' ? t('partner.copyHint') : t('partner.copyFail'),
      icon: 'none',
      duration: 3000
    });
  };

  return (
    <View className='learn-sources'>
      <View className={styles.head}>
        <Text className={styles.headTitle}>{t('learn.sourcesTitle')}</Text>
        <Text className={styles.headDesc}>{t('learn.sourcesDesc')}</Text>
      </View>

      {/* Plus 升级层：语桥代码尚未合并，只有入口与说明，不展示任何课程进度 */}
      <View className={`${styles.card} learn-plus-card`} onClick={openMembership}>
        <Text className={styles.icon}>✨</Text>
        <View className={styles.main}>
          <Text className={styles.title}>{t('learn.plusTitle')}</Text>
          <Text className={styles.desc}>{t('learn.plusDesc')}</Text>
        </View>
        <Text className={styles.badge}>{t('learn.plusBadge')}</Text>
      </View>

      {/* 课程源：内容卡 + 跳转。不承诺「在晨报里学」或「进度同步」——灵犀没有这些能力 */}
      <View className={`${styles.courseCard} learn-course-card`} onClick={openCourse}>
        <View className={styles.courseTop}>
          <Text className={styles.icon}>🎓</Text>
          <View className={styles.main}>
            <Text className={styles.title}>{course.title}</Text>
            <Text className={styles.desc}>{course.intro}</Text>
          </View>
          <Text className={styles.badge}>{isH5 ? t('partner.open') : t('partner.copy')}</Text>
        </View>
        <View className={styles.metaRow}>
          <Text className={`${styles.metaChip} learn-course-duration`}>{course.duration}</Text>
          <Text className={`${styles.metaChip} learn-course-source`}>{course.source}</Text>
        </View>
      </View>
    </View>
  );
}

export default LearnSources;
