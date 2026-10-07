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

/** 缩放系数的合法区间。**必须钳制**：这个值会被写进 CSS 变量并参与根字号的 calc，
 *  一旦上游给出非法值（非有限数 / 0 / 负数 / 超大），整条 calc 失配、根字号失效，
 *  页面布局会连带崩掉 —— 一个 UI 档位设置不该有能力摧毁整个页面。
 *  实测依据：`var(--ui-scale, 1)` 的 fallback **只在变量未定义时生效**，
 *  变量被设成非法值时不会回退，declaration 直接失效。故此处兜底为 1。 */
const MIN_UI_SCALE = 0.5;
const MAX_UI_SCALE = 2;

/** 把缩放系数应用到文档根（H5）。非法值一律回退 1 */
export function applyUiScale(value: number) {
  if (!isH5) return;
  const safe = Number.isFinite(value) && value >= MIN_UI_SCALE && value <= MAX_UI_SCALE ? value : 1;
  try {
    document.documentElement.style.setProperty('--ui-scale', String(safe));
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
