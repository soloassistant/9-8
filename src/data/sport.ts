/**
 * 运动数据层（H5）—— 跑步记录 + 周目标，读写本地 storage。
 *
 * 为什么是本地而不是云：与记账同一套判断（见 data/ledger.ts 的说明）——这是用户自己的
 * 真实记录，H5 的 RPC 白名单里没有对应的写接口，落到本地 + cloudSync 队列即可。
 * 两个 key 分开存：`sportRuns`（写入频繁）与 `sport-goal-km`（设置项，很少改），
 * 否则在别的设备加一条记录会把另一端的周目标一起覆盖掉。
 *
 * ★ 诚实边界（这个模块最容易被"编数据"）：
 *   1. 心率：H5 拿不到心率。记录里**没有 hr 字段**，界面显示"未连接心率设备"，
 *      绝不填一个像模像样的 148。
 *   2. 步频：需要加速度计，同样没有。趋势文案只能基于**配速**，不能提步频。
 *   3. 距离：只有 GPS 采样算出来的距离才叫距离；定位被拒/不可用时记 `source: 'timer'`，
 *      距离未知就是未知，不按配速猜。
 *   4. 恢复度/睡眠/HRV 一概没有 —— 首页那张"恢复良好 82"改成**本周完成度**，
 *      用真实跑量算，不改名字硬凑。
 */
import Taro from '@tarojs/taro';

export const SPORT_KEYS = {
  runs: 'sportRuns',
  goalKm: 'sport-goal-km'
} as const;

/** 地图/轨迹采样点。d = 累计距离（米），t = 相对开始的秒数。 */
export interface RunSample {
  t: number;
  d: number;
  lat?: number;
  lng?: number;
}

/**
 * 一次跑步记录。
 * `source` 决定这次记录能不能参与"配速"类统计：
 *   gps   —— 有定位，距离可信
 *   timer —— 只有计时（定位被拒/不可用），距离为 0 且 `distanceKnown=false`
 * 之所以用 source 而不是 distanceM > 0 判断：真实数据里确实存在"原地跑了 0 米"，
 * 拿距离当标志位会把两种情况混成一件事。
 */
export interface RunRecord {
  id: string;
  startedAt: number;
  durationSec: number;
  distanceM: number;
  distanceKnown: boolean;
  samples: RunSample[];
  source: 'gps' | 'timer';
}

export const DEFAULT_GOAL_KM = 30;
/** 采样入库的间隔：太密会让 storage 膨胀，太疏配速曲线会呈折线。5 秒够画曲线。 */
const SAMPLE_MIN_GAP_SEC = 5;

function readRaw<T>(key: string, fallback: T): T {
  try {
    const v = Taro.getStorageSync(key);
    if (v === '' || v === null || v === undefined) return fallback;
    return v as T;
  } catch (err) {
    console.warn('[sport] read failed:', key, err);
    return fallback;
  }
}

function writeRaw(key: string, value: unknown): boolean {
  try {
    Taro.setStorageSync(key, value);
    return true;
  } catch (err) {
    console.warn('[sport] write failed:', key, err);
    return false;
  }
}

/** 记录校验：storage 里可能存着旧版本/半截数据，读出来必须逐条过一遍再交给 UI。
 *  宁可少一条，也不要把 `distanceM: '5'` 这种脏值算进统计里。 */
function normalizeRecord(raw: unknown): RunRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<RunRecord>;
  if (typeof r.id !== 'string' || !r.id) return null;
  if (!Number.isFinite(r.startedAt)) return null;
  const durationSec = Number(r.durationSec);
  const distanceM = Number(r.distanceM);
  if (!Number.isFinite(durationSec) || durationSec < 0) return null;
  const source: RunRecord['source'] = r.source === 'timer' ? 'timer' : 'gps';
  const samples = Array.isArray(r.samples)
    ? r.samples.filter(
        (s): s is RunSample =>
          !!s && Number.isFinite((s as RunSample).t) && Number.isFinite((s as RunSample).d)
      )
    : [];
  return {
    id: r.id,
    startedAt: Number(r.startedAt),
    durationSec: Math.round(durationSec),
    distanceM: Number.isFinite(distanceM) && distanceM > 0 ? distanceM : 0,
    distanceKnown: source === 'gps',
    samples,
    source
  };
}

export function readRuns(): RunRecord[] {
  const raw = readRaw<unknown>(SPORT_KEYS.runs, []);
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeRecord)
    .filter((r): r is RunRecord => !!r)
    .sort((a, b) => b.startedAt - a.startedAt);
}

export function saveRun(rec: RunRecord): RunRecord[] {
  const all = readRuns().filter((r) => r.id !== rec.id);
  all.push(rec);
  all.sort((a, b) => b.startedAt - a.startedAt);
  writeRaw(SPORT_KEYS.runs, all);
  return all;
}

export function removeRun(id: string): RunRecord[] {
  const all = readRuns().filter((r) => r.id !== id);
  writeRaw(SPORT_KEYS.runs, all);
  return all;
}

export function readGoalKm(): number {
  const v = readRaw<unknown>(SPORT_KEYS.goalKm, DEFAULT_GOAL_KM);
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= 300 ? n : DEFAULT_GOAL_KM;
}

export function writeGoalKm(km: number): void {
  if (!Number.isFinite(km) || km <= 0 || km > 300) return;
  writeRaw(SPORT_KEYS.goalKm, Math.round(km));
}

/* ---------------- 纯函数（导出供门禁单测） ---------------- */

/** 两点球面距离（米）。GPS 采样算里程的标准做法，误差在跑步尺度上可接受。 */
export function haversineM(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const R = 6371000;
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

/** 是否该把这一点写进 samples（按时间间隔抽稀，保留首点） */
export function shouldSample(lastT: number | null, t: number): boolean {
  if (lastT === null) return true;
  return t - lastT >= SAMPLE_MIN_GAP_SEC;
}

/** 配速（秒/公里）。距离为 0 或未知返回 null —— 交给调用方显示"—"，不编 0'00"。 */
export function paceSecPerKm(distanceM: number, durationSec: number): number | null {
  if (!(distanceM > 0) || !(durationSec > 0)) return null;
  const km = distanceM / 1000;
  const pace = durationSec / km;
  // 离谱值（>30 分/公里 或 <2 分/公里）说明定位跳点，不参与展示
  if (!Number.isFinite(pace) || pace > 1800 || pace < 120) return null;
  return Math.round(pace);
}

/** 配速格式：5'32"。入参是秒/公里；null → '—' */
export function formatPace(secPerKm: number | null): string {
  if (secPerKm === null || !Number.isFinite(secPerKm)) return '—';
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  // 60" 要进位成 1'，否则会出现 5'60"
  return s === 60 ? `${m + 1}'00"` : `${m}'${String(s).padStart(2, '0')}"`;
}

/** 距离格式：5.02（公里，两位小数）。不足 1 公里也按公里显示，避免「502 米」与「5.02 公里」两套单位混用。 */
export function formatKm(distanceM: number): string {
  return (Math.max(0, distanceM) / 1000).toFixed(2);
}

/** 时长格式：27:48（超过 1 小时 → 1:02:33） */
export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return `${m}:${String(ss).padStart(2, '0')}`;
}

/** 本周起点（周一 00:00）。中国习惯周一为一周开始，dayjs 的 day() 周日是 0，要换算。 */
export function startOfWeek(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay();
  const back = dow === 0 ? 6 : dow - 1;
  d.setDate(d.getDate() - back);
  return d.getTime();
}

export interface WeekStat {
  start: number;
  km: number;
  count: number;
}

/** 本周统计（只统计距离已知的记录） */
export function weeklyStat(runs: RunRecord[], now: number): WeekStat {
  const start = startOfWeek(now);
  const inWeek = runs.filter((r) => r.startedAt >= start && r.distanceKnown);
  const meters = inWeek.reduce((sum, r) => sum + r.distanceM, 0);
  return { start, km: meters / 1000, count: inWeek.length };
}

/** 近 N 周的圆柱（旧 → 新）。最后一根是本周。 */
export function weekBuckets(runs: RunRecord[], now: number, weeks = 8): WeekStat[] {
  const thisStart = startOfWeek(now);
  const out: WeekStat[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const start = thisStart - i * 7 * 24 * 3600 * 1000;
    const end = start + 7 * 24 * 3600 * 1000;
    const inWeek = runs.filter((r) => r.startedAt >= start && r.startedAt < end && r.distanceKnown);
    const meters = inWeek.reduce((sum, r) => sum + r.distanceM, 0);
    out.push({ start, km: meters / 1000, count: inWeek.length });
  }
  return out;
}

/**
 * 配速趋势：最近一次 vs 上一次（两次都要有可信配速）。
 * 返回 null 表示"数据不够，别下结论" —— 只有 1 次记录时任何"快了/慢了"都是编的。
 */
export function paceDeltaSec(runs: RunRecord[]): number | null {
  const withPace = runs
    .filter((r) => r.distanceKnown)
    .map((r) => paceSecPerKm(r.distanceM, r.durationSec))
    .filter((p): p is number => p !== null);
  if (withPace.length < 2) return null;
  // runs 已按时间倒序，[0] 是最新
  return withPace[1] - withPace[0];
}

/** 今日建议用的"本周节奏"：拿本周跑量对照周目标，给出可执行的下一步。
 *  ⚠️ 不提恢复度/睡眠/心率 —— 这三样 H5 都没有数据源。 */
export function weekAdvice(km: number, goalKm: number): { done: number; remainKm: number } {
  const done = goalKm > 0 ? Math.min(1, km / goalKm) : 0;
  return { done, remainKm: Math.max(0, goalKm - km) };
}

/** 记录里的"傍晚/早晨"时段标签（按开始时间） */
export function dayPeriod(ts: number): 'morning' | 'noon' | 'evening' | 'night' {
  const h = new Date(ts).getHours();
  if (h < 11) return 'morning';
  if (h < 14) return 'noon';
  if (h < 19) return 'evening';
  return 'night';
}
