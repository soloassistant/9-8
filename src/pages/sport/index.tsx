/**
 * pages/sport —— 运动（跑步记录）。设计稿 p43 / p44 / p45 / p46 四屏，
 * 这里用**一个页面 + 四个视图**实现：首页、记录中、单次详情、记录列表。
 *
 * 为什么不拆四个路由：跑步记录是"一个东西的四个视角"，拆开就要在四个页面间传
 * 一个 RunRecord；用视图切换既能保住设计稿的层次，又不会让返回栈变深。
 *
 * ★ 诚实边界（本页的硬约束，改代码前先读）：
 *   1. 心率：H5 没有数据源。界面写「心率未连接设备」，**不填数字**。
 *   2. 步频：需要加速度计，同样没有。趋势卡只谈配速，不提步频。
 *   3. 距离：只有拿到 GPS 采样才算；定位被拒时记 source='timer'，界面只说时长。
 *   4. 恢复度/睡眠/HRV：一概没有。首页那张卡叫「本周完成度」，用真实跑量算。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Image } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import { useT } from '@/store/language';
import { brandVars, useThemeStore } from '@/store/theme';
import {
  DEFAULT_GOAL_KM,
  dayPeriod,
  formatDuration,
  formatKm,
  formatPace,
  haversineM,
  paceDeltaSec,
  paceSecPerKm,
  readGoalKm,
  readRuns,
  removeRun,
  saveRun,
  shouldSample,
  weekAdvice,
  weekBuckets,
  weeklyStat,
  writeGoalKm
} from '@/data/sport';
import type { RunRecord, RunSample } from '@/data/sport';
import styles from './index.module.scss';

type ViewName = 'home' | 'recording' | 'detail' | 'records';
type GeoState = 'idle' | 'waiting' | 'ok' | 'denied' | 'unsupported';

/** 坐标采样点 → 地图轨迹 SVG（用 data-url 贴进 Image：小程序端也认，不用 canvas）。
 *  归一化时留 12% 内边距，避免线贴边被裁。 */
function routeSvgUrl(samples: RunSample[]): string | null {
  const pts = samples.filter((s) => typeof s.lat === 'number' && typeof s.lng === 'number');
  if (pts.length < 2) return null;
  const lats = pts.map((s) => s.lat as number);
  const lngs = pts.map((s) => s.lng as number);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const spanLat = maxLat - minLat || 1e-6;
  const spanLng = maxLng - minLng || 1e-6;
  // 保持长宽比例，避免把一条直线拉成方块
  const W = 320, H = 160, PAD = 20;
  const scale = Math.min((W - PAD * 2) / spanLng, (H - PAD * 2) / spanLat);
  const cx = (W - spanLng * scale) / 2;
  const cy = (H - spanLat * scale) / 2;
  const xy = pts.map((s) => {
    const x = cx + ((s.lng as number) - minLng) * scale;
    const y = H - (cy + ((s.lat as number) - minLat) * scale);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const first = xy[0].split(',');
  const last = xy[xy.length - 1].split(',');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="none"/>
<polyline points="${xy.join(' ')}" fill="none" stroke="#ff7a45" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
<circle cx="${first[0]}" cy="${first[1]}" r="4" fill="#ff7a45"/>
<circle cx="${last[0]}" cy="${last[1]}" r="5" fill="#fff" stroke="#ff7a45" stroke-width="3"/>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** 配速曲线：按样本点算分段配速（不画没数据的部分）。样本不足 3 个返回 null。 */
function paceCurveSvgUrl(samples: RunSample[]): string | null {
  if (samples.length < 3) return null;
  const paces: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const dd = samples[i].d - samples[i - 1].d;
    const dt = samples[i].t - samples[i - 1].t;
    if (dd <= 0 || dt <= 0) continue;
    const p = paceSecPerKm(dd, dt);
    if (p !== null) paces.push(p);
  }
  if (paces.length < 3) return null;
  // 配速是"越小越快"，画图时把快的放上面 → y 与配速反比
  const min = Math.min(...paces), max = Math.max(...paces);
  const span = max - min || 1;
  const W = 320, H = 120, PAD = 12;
  const step = (W - PAD * 2) / (paces.length - 1);
  const pts = paces.map((p, i) => {
    const x = PAD + i * step;
    const y = PAD + ((p - min) / span) * (H - PAD * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">
<polyline points="${pts.join(' ')}" fill="none" stroke="#ff7a45" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export default function SportPage() {
  const t = useT();
  const { theme } = useThemeStore();
  const [view, setView] = useState<ViewName>('home');
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [goalKm, setGoalKm] = useState<number>(DEFAULT_GOAL_KM);
  const [now, setNow] = useState<number>(() => Date.now());
  const [detailId, setDetailId] = useState<string>('');

  // 记录中的状态（不写进 state 的部分放 ref：watchPosition 回调里要读到最新值，
  // 而 setState 是异步的 —— 用 state 会把同一秒内的两个点都算成"起点"）
  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [distanceM, setDistanceM] = useState(0);
  const [geo, setGeo] = useState<GeoState>('idle');
  const [samples, setSamples] = useState<RunSample[]>([]);

  const startedAtRef = useRef(0);
  const pausedAtRef = useRef(0);
  const pausedTotalRef = useRef(0);
  const lastPosRef = useRef<{ lat: number; lng: number } | null>(null);
  const distRef = useRef(0);
  const samplesRef = useRef<RunSample[]>([]);
  const watchIdRef = useRef<number | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const reload = useCallback(() => {
    setRuns(readRuns());
    setGoalKm(readGoalKm());
    setNow(Date.now());
  }, []);

  useDidShow(() => reload());
  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(
    () => () => {
      if (tickRef.current) clearInterval(tickRef.current);
      if (watchIdRef.current !== null && typeof navigator !== 'undefined' && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
    },
    []
  );

  const week = useMemo(() => weeklyStat(runs, now), [runs, now]);
  const advice = useMemo(() => weekAdvice(week.km, goalKm), [week.km, goalKm]);
  const buckets = useMemo(() => weekBuckets(runs, now, 8), [runs, now]);
  const delta = useMemo(() => paceDeltaSec(runs), [runs]);
  const lastRun = runs[0];
  const detail = runs.find((r) => r.id === detailId) || null;

  /* ---------------- 记录控制 ---------------- */

  const stopWatch = useCallback(() => {
    if (watchIdRef.current !== null && typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
  }, []);

  const stopTick = useCallback(() => {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, []);

  const start = useCallback(() => {
    startedAtRef.current = Date.now();
    pausedTotalRef.current = 0;
    pausedAtRef.current = 0;
    lastPosRef.current = null;
    distRef.current = 0;
    samplesRef.current = [];
    setSamples([]);
    setElapsed(0);
    setDistanceM(0);
    setPaused(false);
    setRecording(true);
    setView('recording');

    tickRef.current = setInterval(() => {
      const base = pausedTotalRef.current;
      setElapsed(Math.floor((Date.now() - startedAtRef.current - base) / 1000));
    }, 500);

    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGeo('unsupported');
      return;
    }
    setGeo('waiting');
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        if (pausedAtRef.current !== 0) return; // 暂停期间的点不计入
        const cur = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        // 精度差于 50 米直接丢弃：城市里这种点会让里程凭空多出几百米
        if (typeof pos.coords.accuracy === 'number' && pos.coords.accuracy > 50) return;
        const prev = lastPosRef.current;
        if (prev) {
          const step = haversineM(prev, cur);
          // 单步 >100 米（5 秒内）判定为跳点，不累加
          if (step > 100) {
            lastPosRef.current = cur;
            return;
          }
          distRef.current += step;
          setDistanceM(distRef.current);
        }
        lastPosRef.current = cur;
        setGeo('ok');
        const t0 = Math.floor((Date.now() - startedAtRef.current - pausedTotalRef.current) / 1000);
        const lastT = samplesRef.current.length
          ? samplesRef.current[samplesRef.current.length - 1].t
          : null;
        if (shouldSample(lastT, t0)) {
          const next = [...samplesRef.current, { t: t0, d: distRef.current, ...cur }];
          samplesRef.current = next;
          setSamples(next);
        }
      },
      () => setGeo('denied'),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
    );
  }, []);

  const togglePause = useCallback(() => {
    if (!recording) return;
    if (paused) {
      pausedTotalRef.current += Date.now() - pausedAtRef.current;
      pausedAtRef.current = 0;
      setPaused(false);
    } else {
      pausedAtRef.current = Date.now();
      setPaused(true);
    }
  }, [paused, recording]);

  const finish = useCallback(() => {
    const startedAt = startedAtRef.current;
    const total = Date.now() - startedAt - pausedTotalRef.current;
    stopTick();
    stopWatch();
    const rec: RunRecord = {
      id: `run_${startedAt}_${Math.random().toString(36).slice(2, 8)}`,
      startedAt,
      durationSec: Math.max(0, Math.round(total / 1000)),
      distanceM: distRef.current,
      distanceKnown: geo === 'ok' || distRef.current > 0,
      samples: samplesRef.current,
      source: distRef.current > 0 ? 'gps' : 'timer'
    };
    const next = saveRun(rec);
    setRuns(next);
    setRecording(false);
    setPaused(false);
    pausedAtRef.current = 0;
    setDetailId(rec.id);
    setView('detail');
  }, [geo, stopTick, stopWatch]);

  const discard = useCallback(() => {
    Taro.showModal({
      title: t('sport.discard'),
      content: t('sport.discardConfirm'),
      confirmText: t('sport.discard'),
      cancelText: t('common.cancel'),
      success: (res) => {
        if (!res.confirm) return;
        stopTick();
        stopWatch();
        setRecording(false);
        setPaused(false);
        pausedAtRef.current = 0;
        setView('home');
      }
    }).catch(() => undefined);
  }, [stopTick, stopWatch, t]);

  const handleBack = useCallback(() => {
    if (view !== 'home') {
      if (view === 'recording') {
        discard();
        return;
      }
      setView('home');
      return;
    }
    const pages = Taro.getCurrentPages();
    if (pages.length > 1) {
      Taro.navigateBack().catch(() => Taro.reLaunch({ url: '/pages/briefing/index' }));
      return;
    }
    Taro.reLaunch({ url: '/pages/briefing/index' });
  }, [discard, view]);

  const pickGoal = useCallback(() => {
    const options = [15, 20, 30, 40, 50];
    Taro.showActionSheet({ itemList: options.map((n) => `${n} km`) })
      .then((res) => {
        const km = options[res.tapIndex];
        if (!km) return;
        writeGoalKm(km);
        setGoalKm(km);
      })
      .catch(() => undefined);
  }, []);

  const deleteDetail = useCallback(() => {
    if (!detail) return;
    Taro.showModal({
      title: t('sport.delete'),
      content: t('sport.deleteConfirm'),
      confirmText: t('common.delete'),
      cancelText: t('common.cancel'),
      success: (res) => {
        if (!res.confirm) return;
        setRuns(removeRun(detail.id));
        setDetailId('');
        setView('home');
      }
    }).catch(() => undefined);
  }, [detail, t]);

  /* ---------------- 渲染 ---------------- */

  const headerTitle =
    view === 'records' ? t('sport.records') : view === 'detail' ? t('sport.detail') : t('sport.title');

  const subtitle =
    view === 'records'
      ? t('sport.recordsSummary', { n: runs.length, km: formatKm(runs.reduce((s, r) => s + r.distanceM, 0)) })
      : view === 'detail'
        ? ''
        : lastRun
          ? t('sport.subLatest', { km: formatKm(lastRun.distanceM), when: t(`sport.period.${dayPeriod(lastRun.startedAt)}`) })
          : t('sport.subEmpty');

  const maxBarKm = Math.max(1, ...buckets.map((b) => b.km));

  return (
    <View className={styles.page} style={brandVars(theme)}>
      {view !== 'recording' ? (
        <View className={styles.backRow} onClick={handleBack}>
          <Text className={styles.backIcon}>‹</Text>
          <Text className={styles.backText}>
            {view === 'home' ? t('sport.backBriefing') : t('sport.backSport')}
          </Text>
        </View>
      ) : null}

      {/* ================= 首页（p43） ================= */}
      {view === 'home' ? (
        <View>
          <Text className={styles.title}>{headerTitle}</Text>
          <Text className={styles.subtitle}>{subtitle}</Text>

          {/* 今日建议：设计稿这里是「恢复良好 82」的生理评分 —— H5 没有睡眠/心率/HRV，
              拿不到就不编。同一个位置改成**本周完成度**，数字同样可一眼读到。 */}
          <View className={styles.card}>
            <View className={styles.cardRow}>
              <View className={styles.cardMain}>
                <Text className={styles.cardLabel}>{t('sport.adviceLabel')}</Text>
                <Text className={styles.bigValue}>
                  {advice.remainKm > 0
                    ? t('sport.adviceRemain', { km: advice.remainKm.toFixed(1) })
                    : t('sport.adviceOver')}
                </Text>
              </View>
              <View className={styles.scoreCircle}>
                <Text className={styles.scoreText}>{Math.round(advice.done * 100)}</Text>
                <Text className={styles.scoreUnit}>%</Text>
              </View>
            </View>
          </View>

          <View className={styles.primaryBtn} onClick={start}>
            <Text className={styles.primaryBtnText}>{t('sport.start')}</Text>
          </View>

          {/* 本周跑量 */}
          <View className={styles.card}>
            <View className={styles.cardRow}>
              <Text className={styles.cardLabel}>{t('sport.weekKm')}</Text>
              <Text className={styles.cardHint}>
                {week.count > 0 ? t('sport.weekTimes', { km: week.km.toFixed(1), n: week.count }) : t('sport.weekEmpty')}
              </Text>
            </View>
            <View className={styles.weekBars}>
              {buckets.slice(-7).map((b, i) => (
                <View
                  key={b.start}
                  className={styles.weekBarWrap}
                  style={{ height: `${Math.max(8, (b.km / maxBarKm) * 100)}%` }}
                >
                  <View
                    className={i === buckets.slice(-7).length - 1 ? styles.weekBarActive : styles.weekBar}
                  />
                </View>
              ))}
            </View>
          </View>

          {/* 周目标 */}
          <View className={styles.card} onClick={pickGoal}>
            <View className={styles.cardRow}>
              <Text className={styles.cardLabel}>{t('sport.goal', { km: goalKm })}</Text>
              <Text className={styles.cardAccent}>
                {advice.remainKm > 0
                  ? t('sport.goalRemain', { km: advice.remainKm.toFixed(1) })
                  : t('sport.goalDone')}
              </Text>
            </View>
            <View className={styles.progressTrack}>
              <View className={styles.progressFill} style={{ width: `${Math.round(advice.done * 100)}%` }} />
            </View>
            <Text className={styles.cardFoot}>{t('sport.goalTap')}</Text>
          </View>

          {/* 最近一次 */}
          <View
            className={styles.card}
            onClick={() => {
              if (!lastRun) return;
              setDetailId(lastRun.id);
              setView('detail');
            }}
          >
            <View className={styles.cardRow}>
              <Text className={styles.cardLabel}>
                {lastRun
                  ? t('sport.latest', { when: `${new Date(lastRun.startedAt).getMonth() + 1}/${new Date(lastRun.startedAt).getDate()} · ${t(`sport.period.${dayPeriod(lastRun.startedAt)}`)}` })
                  : t('sport.latestEmpty')}
              </Text>
              {lastRun ? <Text className={styles.cardAccent}>{t('sport.viewDetail')}</Text> : null}
            </View>
            {lastRun ? (
              <Text className={styles.bigValue}>
                {lastRun.distanceKnown
                  ? `${formatKm(lastRun.distanceM)} km · ${t('sport.paceShort', { pace: formatPace(paceSecPerKm(lastRun.distanceM, lastRun.durationSec)) })}`
                  : `${formatDuration(lastRun.durationSec)} · ${t('sport.distanceUnknown')}`}
              </Text>
            ) : null}
          </View>

          {runs.length > 0 ? (
            <View className={styles.textBtn} onClick={() => setView('records')}>
              <Text className={styles.textBtnLabel}>{t('sport.viewAll')}</Text>
            </View>
          ) : null}
        </View>
      ) : null}

      {/* ================= 记录中（p44） ================= */}
      {view === 'recording' ? (
        <View>
          <View className={styles.recTopBar}>
            <View className={styles.backRowInline} onClick={discard}>
              <Text className={styles.backIcon}>‹</Text>
              <Text className={styles.backText}>{t('sport.discard')}</Text>
            </View>
            <Text className={geo === 'ok' ? styles.geoOk : styles.geoWarn}>
              {geo === 'ok'
                ? t('sport.geoOk')
                : geo === 'waiting'
                  ? t('sport.geoWaiting')
                  : geo === 'denied'
                    ? t('sport.geoDenied')
                    : geo === 'unsupported'
                      ? t('sport.geoUnsupported')
                      : ''}
            </Text>
          </View>

          <View className={styles.darkCard}>
            <View className={styles.distRow}>
              <Text className={styles.distBig}>{formatKm(distanceM)}</Text>
              <Text className={styles.distUnit}>{t('sport.km')}</Text>
            </View>
            <View className={styles.darkDivider} />
            <View className={styles.darkStats}>
              <View className={styles.darkStat}>
                <Text className={styles.darkStatValue}>{formatPace(paceSecPerKm(distanceM, elapsed))}</Text>
                <Text className={styles.darkStatLabel}>{t('sport.curPace')}</Text>
              </View>
              <View className={styles.darkStat}>
                <Text className={styles.darkStatValue}>{formatDuration(elapsed)}</Text>
                <Text className={styles.darkStatLabel}>{t('sport.time')}</Text>
              </View>
              <View className={styles.darkStat}>
                <Text className={styles.darkStatValueDim}>—</Text>
                <Text className={styles.darkStatLabel}>{t('sport.noHr')}</Text>
              </View>
            </View>
          </View>

          <View className={styles.card}>
            <View className={styles.cardRow}>
              <Text className={styles.cardLabel}>{t('sport.route')}</Text>
              <Text className={styles.cardAccent}>{distanceM > 0 ? `${formatKm(distanceM)} km` : '—'}</Text>
            </View>
            {routeSvgUrl(samples) ? (
              <View className={styles.mapBox}>
                <Image className={styles.mapImg} src={routeSvgUrl(samples) as string} mode='aspectFit' />
              </View>
            ) : (
              <Text className={styles.emptyHint}>{t('sport.routeEmpty')}</Text>
            )}
          </View>

          <View className={styles.recActions}>
            <View className={styles.pauseBtn} onClick={togglePause}>
              <Text className={styles.pauseBtnText}>{paused ? t('sport.resume') : t('sport.pause')}</Text>
            </View>
            <View className={styles.finishBtn} onClick={finish}>
              <Text className={styles.finishBtnText}>{t('sport.finish')}</Text>
            </View>
          </View>
        </View>
      ) : null}

      {/* ================= 单次详情（p45） ================= */}
      {view === 'detail' && detail ? (
        <View>
          <Text className={styles.title}>{t('sport.detail')}</Text>
          <Text className={styles.subtitle}>
            {`${new Date(detail.startedAt).getMonth() + 1}/${new Date(detail.startedAt).getDate()} · ${t(`sport.period.${dayPeriod(detail.startedAt)}`)}`}
          </Text>

          <View className={styles.darkCard}>
            <View className={styles.distRow}>
              <Text className={styles.distBig}>{formatKm(detail.distanceM)}</Text>
              <Text className={styles.distUnit}>{t('sport.km')}</Text>
            </View>
            <View className={styles.darkDivider} />
            <View className={styles.darkStats}>
              <View className={styles.darkStat}>
                <Text className={styles.darkStatValue}>
                  {formatPace(paceSecPerKm(detail.distanceM, detail.durationSec))}
                </Text>
                <Text className={styles.darkStatLabel}>{t('sport.avgPace')}</Text>
              </View>
              <View className={styles.darkStat}>
                <Text className={styles.darkStatValue}>{formatDuration(detail.durationSec)}</Text>
                <Text className={styles.darkStatLabel}>{t('sport.time')}</Text>
              </View>
              <View className={styles.darkStat}>
                <Text className={styles.darkStatValueDim}>—</Text>
                <Text className={styles.darkStatLabel}>{t('sport.noHr')}</Text>
              </View>
            </View>
          </View>

          <View className={styles.card}>
            <View className={styles.cardRow}>
              <Text className={styles.cardLabel}>{t('sport.route')}</Text>
              <Text className={styles.cardAccent}>{detail.distanceKnown ? `${formatKm(detail.distanceM)} km` : '—'}</Text>
            </View>
            {routeSvgUrl(detail.samples) ? (
              <View className={styles.mapBox}>
                <Image className={styles.mapImg} src={routeSvgUrl(detail.samples) as string} mode='aspectFit' />
              </View>
            ) : (
              <Text className={styles.emptyHint}>{t('sport.routeEmpty')}</Text>
            )}
          </View>

          <View className={styles.card}>
            <Text className={styles.cardLabel}>{t('sport.paceCurve')}</Text>
            {paceCurveSvgUrl(detail.samples) ? (
              <View className={styles.curveBox}>
                <Image className={styles.curveImg} src={paceCurveSvgUrl(detail.samples) as string} mode='aspectFit' />
              </View>
            ) : (
              <Text className={styles.emptyHint}>{t('sport.curveEmpty')}</Text>
            )}
          </View>

          <View className={styles.textBtn} onClick={deleteDetail}>
            <Text className={styles.textBtnDanger}>{t('sport.delete')}</Text>
          </View>
        </View>
      ) : null}

      {/* ================= 记录列表（p46） ================= */}
      {view === 'records' ? (
        <View>
          <Text className={styles.title}>{headerTitle}</Text>
          <Text className={styles.subtitle}>{subtitle}</Text>

          <View className={styles.card}>
            <View className={styles.cardRow}>
              <Text className={styles.cardLabel}>{t('sport.weekKm')}</Text>
              <Text className={styles.cardAccent}>
                {/* 分母固定为「近 8 周」：卡片标题就是近 8 周，按有效周数做分母
                    （只有 2 周有记录时会被算成 8 km/周）等于把空白周从统计里抹掉，
                    数字看着漂亮但不真。 */}
                {t('sport.avgPerWeek', {
                  km: (buckets.reduce((s, b) => s + b.km, 0) / Math.max(1, buckets.length)).toFixed(1)
                })}
              </Text>
            </View>
            <View className={styles.weekBars}>
              {buckets.map((b, i) => (
                <View
                  key={b.start}
                  className={styles.weekBarWrap}
                  style={{ height: `${Math.max(8, (b.km / maxBarKm) * 100)}%` }}
                >
                  <View className={i === buckets.length - 1 ? styles.weekBarActive : styles.weekBar} />
                </View>
              ))}
            </View>
            <View className={styles.cardRow}>
              <Text className={styles.cardFoot}>{t('sport.weeksAgo')}</Text>
              <Text className={styles.cardFoot}>{t('sport.thisWeek', { km: week.km.toFixed(1) })}</Text>
            </View>
          </View>

          {/* 趋势：只有 ≥2 次带配速的记录才下结论 */}
          <View className={styles.darkTip}>
            <Text className={styles.darkTipLabel}>{t('sport.trend')}</Text>
            <Text className={styles.darkTipText}>
              {delta === null
                ? t('sport.trendNotEnough')
                : delta > 0
                  ? t('sport.trendFaster', { sec: Math.abs(delta) })
                  : delta < 0
                    ? t('sport.trendSlower', { sec: Math.abs(delta) })
                    : t('sport.trendSame')}
            </Text>
          </View>

          <View className={styles.card}>
            {runs.length === 0 ? (
              <Text className={styles.emptyHint}>{t('sport.noRecords')}</Text>
            ) : (
              runs.map((r) => (
                <View
                  key={r.id}
                  className={styles.listRow}
                  onClick={() => {
                    setDetailId(r.id);
                    setView('detail');
                  }}
                >
                  <View className={styles.listMain}>
                    <Text className={styles.listMeta}>
                      {`${new Date(r.startedAt).getMonth() + 1}月${new Date(r.startedAt).getDate()}日 · ${t(`sport.period.${dayPeriod(r.startedAt)}`)}`}
                    </Text>
                    <Text className={styles.listTitle}>
                      {r.distanceKnown
                        ? `${formatKm(r.distanceM)} 公里 · ${formatDuration(r.durationSec)}`
                        : `${formatDuration(r.durationSec)} · ${t('sport.distanceUnknown')}`}
                    </Text>
                  </View>
                  <Text className={styles.listPace}>
                    {r.distanceKnown ? formatPace(paceSecPerKm(r.distanceM, r.durationSec)) : '—'}
                  </Text>
                </View>
              ))
            )}
          </View>
        </View>
      ) : null}
    </View>
  );
}
