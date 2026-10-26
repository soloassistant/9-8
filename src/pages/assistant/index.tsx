import { View } from '@tarojs/components';
import AiAssistant from '@/components/AiAssistant';
import styles from './index.module.scss';

/**
 * AI 助手（2026-10-27 新增）。
 *
 * 全站唯一的 AI 对话入口。之前有两个入口，而且各写了一套实现：
 *   · 晨报页底部常驻输入条（4 个快捷 chip + 输入行）—— 直接改日程，能力最强；
 *   · 悬浮球 + 浮层面板（AiAssistant 组件）—— 任何页面都能唤起。
 * 用户反馈「底部那条取消，AI 生成放设置里，剩下的全删掉」。
 *
 * 取舍说明（这是有意的功能收敛，不是遗漏）：
 *   整页模式复用 AiAssistant 组件，所以消息列表、语音输入、排班方案卡片、
 *   记忆溯源、合规常驻提示全部保留；丢掉的是晨报页那一套「4 个快捷指令 chip」，
 *   它们本质是「用自然语言下命令」的快捷方式，在对话框里直接打字同样能做到。
 */
export default function AssistantPage() {
  return (
    <View className={styles.page}>
      <AiAssistant embedded />
    </View>
  );
}
