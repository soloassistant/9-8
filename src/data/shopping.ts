// mock: shopping —— H5 预览端购物清单，读写本地 storage（与 mock:chat 共用同一 key），模拟真机云端 CRUD。
import Taro from '@tarojs/taro';

const STORAGE_KEY = 'shoppingList';

interface MockPrice {
  platform: string;
  price: number;
}
interface MockShoppingItem {
  id: string;
  name: string;
  targetPrice?: number;
  link?: string;
  bought: boolean;
  createdAt: string;
  prices: MockPrice[];
  /** 上次已提醒的价格（P-01 降价提醒去重；清除心理价位时同步清掉） */
  lastNotifiedPrice?: number;
}

function load(): MockShoppingItem[] {
  try {
    return Taro.getStorageSync(STORAGE_KEY) || [];
  } catch (err) {
    console.warn('[mock:shopping] load failed:', err);
    return [];
  }
}
function save(list: MockShoppingItem[]) {
  try {
    Taro.setStorageSync(STORAGE_KEY, list);
  } catch (err) {
    console.warn('[mock:shopping] save failed:', err);
  }
}

export default function shopping(data?: { action?: string; id?: string; name?: string; targetPrice?: string | number; platform?: string; price?: number }) {
  const action = data?.action || 'list';
  const list = load();

  if (action === 'list') return list;

  if (action === 'add') {
    const name = String(data?.name || '').trim();
    if (!name) return null;
    const p = Number(data?.targetPrice);
    const item: MockShoppingItem = {
      id: `shop-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name,
      targetPrice: Number.isFinite(p) && p > 0 ? p : undefined,
      bought: false,
      createdAt: new Date().toISOString(),
      prices: []
    };
    save([item, ...list]);
    return item;
  }

  if (action === 'toggleBought') {
    const item = list.find((it) => it.id === data?.id);
    if (!item) return null;
    const bought = !item.bought;
    save(list.map((it) => (it.id === data?.id ? { ...it, bought } : it)));
    return { id: data?.id, bought };
  }

  if (action === 'remove') {
    if (!list.some((it) => it.id === data?.id)) return null;
    save(list.filter((it) => it.id !== data?.id));
    return { id: data?.id };
  }

  if (action === 'addPrice') {
    const item = list.find((it) => it.id === data?.id);
    if (!item) return null;
    const platform = String(data?.platform || '').trim();
    const price = Number(data?.price);
    if (!platform || !Number.isFinite(price)) return null;
    const prices = [...item.prices, { platform, price }];
    save(list.map((it) => (it.id === data?.id ? { ...it, prices } : it)));
    return { id: data?.id, prices };
  }

  // P-01：设置 / 修改心理价位（与真机云函数同签名：{ action, id, price }）
  if (action === 'setTargetPrice') {
    const item = list.find((it) => it.id === data?.id);
    if (!item) return null;
    const price = Number(data?.price);
    if (!Number.isFinite(price) || price <= 0) return null;
    save(list.map((it) => (it.id === data?.id ? { ...it, targetPrice: price } : it)));
    return { id: data?.id, targetPrice: price };
  }

  // P-01：清除心理价位（同时清掉已提醒价，避免残留去重记录）
  if (action === 'clearTargetPrice') {
    const item = list.find((it) => it.id === data?.id);
    if (!item) return null;
    save(
      list.map((it) =>
        it.id === data?.id ? { ...it, targetPrice: undefined, lastNotifiedPrice: undefined } : it
      )
    );
    return { id: data?.id };
  }

  return null;
}