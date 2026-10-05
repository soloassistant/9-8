import { create } from 'zustand';
import Taro from '@tarojs/taro';

/** 界面大小档位（H5 端生效：通过 --ui-scale 变量乘入 rem 基准） */
export interface UiScalePreset {
  id: string;
  label: string;
  value: number;
}

export const UI_SCALE_PRESETS: UiScalePreset[] = [
  { id: 'small', label: '小', value: 0.85 },
  { id: 'standard', label: '标准', value: 1 },
  { id: 'large', label: '大', value: 1.15 },
  { id: 'xlarge', label: '特大', value: 1.3 }
];

export const STORAGE_KEY = 'ui-scale';
const isH5 = process.env.TARO_ENV === 'h5';

/** 把缩放系数应用到文档根（H5） */
export function applyUiScale(value: number) {
  if (!isH5) return;
  try {
    document.documentElement.style.setProperty('--ui-scale', String(value));
  } catch (err) {
    console.warn('[uiScale] apply failed:', err);
  }
}

function loadSavedId(): string {
  try {
    const saved = Taro.getStorageSync(STORAGE_KEY);
    return UI_SCALE_PRESETS.some((p) => p.id === saved) ? saved : 'standard';
  } catch (err) {
    return 'standard';
  }
}

interface UiScaleState {
  id: string;
  scale: number;
  setScale: (id: string) => void;
}

const initialId = loadSavedId();

// 模块加载即应用（H5 bundle 执行时 documentElement 已可用），保证刷新后立即生效
applyUiScale(UI_SCALE_PRESETS.find((p) => p.id === initialId)?.value ?? 1);

export const useUiScaleStore = create<UiScaleState>((set) => ({
  id: initialId,
  scale: UI_SCALE_PRESETS.find((p) => p.id === initialId)?.value ?? 1,
  setScale: (id) => {
    const preset = UI_SCALE_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    set({ id: preset.id, scale: preset.value });
    applyUiScale(preset.value);
    try {
      Taro.setStorageSync(STORAGE_KEY, preset.id);
    } catch (err) {
      console.error('[uiScale] persist failed:', err);
    }
  }
}));
