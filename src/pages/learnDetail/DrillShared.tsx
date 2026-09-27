import type { ReactNode } from 'react';
import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import classnames from 'classnames';
import { useT } from '@/store/language';
import styles from './index.module.scss';

/**
 * 三练习（语法/听力/口语）共享结构（Q-01）：
 * 顶部进度条 / 四选项列表 / 答后揭示框 / 结算卡，全仓只维护这一份。
 * 样式复用同目录 index.module.scss，纯结构组件无自身状态。
 */

/** U-03 答对轻震动反馈：H5 端无震动能力，任何失败仅静默，绝不阻断练习流程 */
export function vibrateCorrect() {
  try {
    Taro.vibrateShort({ type: 'light' }).catch((err) => console.warn('[Drill] vibrate failed:', err));
  } catch (err) {
    console.warn('[Drill] vibrate failed:', err);
  }
}

/** 顶部进度条：current 从 1 计 */
export function DrillProgress({ current, total, accent }: { current: number; total: number; accent: string }) {
  return (
    <View className={styles.drillProgress}>
      <View className={styles.drillProgressFill} style={{ width: `${(current / total) * 100}%`, background: accent }} />
    </View>
  );
}

interface DrillOptionsProps {
  options: string[];
  answer: string;
  /** 已点选的选项（null = 未作答） */
  picked: string | null;
  accent: string;
  onPick: (opt: string) => void;
}

/** 四选项列表：答后锁定，正确项高亮主题色、错选项标红 */
export function DrillOptions({ options, answer, picked, accent, onPick }: DrillOptionsProps) {
  return (
    <View className={styles.optionList}>
      {options.map((opt) => {
        const isPicked = picked === opt;
        const isAnswer = opt === answer;
        return (
          <View
            key={opt}
            className={classnames(
              styles.option,
              picked !== null && isAnswer && styles.optionCorrect,
              isPicked && !isAnswer && styles.optionWrong
            )}
            style={picked !== null && isAnswer ? { borderColor: accent, color: accent } : undefined}
            onClick={() => onPick(opt)}
          >
            <Text>{opt}</Text>
          </View>
        );
      })}
    </View>
  );
}

/** 答后揭示框（裸容器）：口语自评/评分反馈的双按钮布局使用 */
export function DrillRevealBox({ children }: { children: ReactNode }) {
  return <View className={styles.revealBox}>{children}</View>;
}

interface DrillRevealProps {
  children: ReactNode;
  accent: string;
  primaryLabel: string;
  onPrimary: () => void;
}

/** 答后揭示框（含底部主按钮）：语法/听力「下一题/完成」标准布局 */
export function DrillReveal({ children, accent, primaryLabel, onPrimary }: DrillRevealProps) {
  return (
    <DrillRevealBox>
      {children}
      <Text className={styles.btnPrimary} style={{ background: accent }} onClick={onPrimary}>
        {primaryLabel}
      </Text>
    </DrillRevealBox>
  );
}

interface DrillFinishProps {
  emoji: string;
  title: string;
  /** 结算主行（得分/进度文案） */
  score: string;
  /** 历史最高分（>0 才显示；调用方负责取 max） */
  best: number;
  accent: string;
  onRestart: () => void;
}

/** 结算卡：emoji + 标题 + 得分 + 历史最高分 + 「再来一轮」 */
export function DrillFinish({ emoji, title, score, best, accent, onRestart }: DrillFinishProps) {
  const t = useT();
  return (
    <View className={styles.drillFinish}>
      <Text className={styles.finishEmoji}>{emoji}</Text>
      <Text className={styles.finishTitle}>{title}</Text>
      <Text className={styles.finishScore} style={{ color: accent }}>
        {score}
      </Text>
      {best > 0 ? <Text className={styles.finishBest}>{t('learn.bestScore', { score: best })}</Text> : null}
      <View className={styles.drillActions}>
        <Text className={styles.btnGhost} onClick={onRestart}>
          {t('learn.retry')}
        </Text>
      </View>
    </View>
  );
}
