import { create } from 'zustand';
import Taro from '@tarojs/taro';

export interface ThemePreset {
  id: string;
  name: string;
  /** 主色 */
  color: string;
  /** 浅底（页面头部/浅色容器） */
  soft: string;
  /** 深色（渐变终点/强调） */
  deep: string;
}

/** 界面主题预设：切换后通过 CSS 变量 --brand* 应用到各页面 */
export const THEME_PRESETS: ThemePreset[] = [
  { id: 'sunrise', name: '晨光橙', color: '#FF7A45', soft: '#FFF3EC', deep: '#E85D2A' },
  { id: 'ocean', name: '天空蓝', color: '#5B8DEF', soft: '#EEF3FE', deep: '#3A6FD8' },
  { id: 'forest', name: '森林绿', color: '#00B42A', soft: '#E8FFEA', deep: '#008A20' },
  { id: 'sakura', name: '樱花粉', color: '#F5669C', soft: '#FEEEF5', deep: '#D14B80' }
];

export const STORAGE_KEY = 'brand-theme';

interface ThemeState {
  theme: ThemePreset;
  setTheme: (id: string) => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  theme: THEME_PRESETS[0],
  setTheme: (id) => {
    const next = THEME_PRESETS.find((t) => t.id === id);
    if (!next) return;
    set({ theme: next });
    try {
      Taro.setStorageSync(STORAGE_KEY, id);
    } catch (err) {
      console.warn('[ThemeStore] persist failed:', err);
    }
  }
}));

// 模块加载时恢复本地选择
try {
  const saved = Taro.getStorageSync(STORAGE_KEY) as string;
  const local = THEME_PRESETS.find((t) => t.id === saved);
  if (local) useThemeStore.setState({ theme: local });
} catch (err) {
  console.warn('[ThemeStore] restore failed:', err);
}

/** 生成页面根节点的 CSS 变量样式（各页面根 View 使用） */
export function brandVars(theme: ThemePreset): React.CSSProperties {
  return {
    '--brand': theme.color,
    '--brand-soft': theme.soft,
    '--brand-deep': theme.deep
  } as React.CSSProperties;
}
