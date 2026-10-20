// 入口：被 esbuild 编译成 iife 后在 vm 里求值（verify-sync-conflict.mjs 的配套文件）。
// 本模块纯逻辑，不引 Taro/React。
// 变量名别叫 t；别用 export（vm 无 ESM 解析器）。
import {
  stableStringify,
  valueHash,
  classifyPull,
  mergeConflicts,
  withoutConflicts
} from '@/utils/syncConflict';

const out = {
  // 1. 规范化序列化：内容相同、键序不同 → 串相同（防 JSONB 回包键序差异误报冲突）
  stableOrderA: stableStringify({ a: 1, b: [1, 2], c: { x: 1, y: 2 } }),
  stableOrderB: stableStringify({ c: { y: 2, x: 1 }, b: [1, 2], a: 1 }),
  stableArray: stableStringify([{ b: 1, a: 2 }]),
  stableScalar: stableStringify('x'),
  // 2. 值哈希：同内容同哈希、异内容异哈希
  hashPlain: valueHash({ a: 1, b: 2 }),
  hashReordered: valueHash({ b: 2, a: 1 }),
  hashDiff: valueHash({ a: 1, b: 3 }),
  hashArrVsObj: valueHash([1, 2]) + '|' + valueHash({ 0: 1, 1: 2 }),
  // 3. classifyPull 矩阵
  pullSkipOlder: classifyPull({ remoteTs: 100, metaTs: 200, localValue: { v: 1 }, confirmedHash: 'zzz' }),
  pullSkipEqual: classifyPull({ remoteTs: 200, metaTs: 200, localValue: { v: 1 }, confirmedHash: 'zzz' }),
  pullRestoreEmpty: classifyPull({ remoteTs: 300, metaTs: 200, localValue: undefined, confirmedHash: undefined }),
  pullRestoreNoLocalButConfirmed: classifyPull({ remoteTs: 300, metaTs: 200, localValue: undefined, confirmedHash: 'abc' }),
  pullOverwriteClean: classifyPull({
    remoteTs: 300,
    metaTs: 200,
    localValue: { v: 1 },
    confirmedHash: valueHash({ v: 1 })
  }),
  pullOverwriteCleanReordered: classifyPull({
    remoteTs: 300,
    metaTs: 200,
    localValue: { b: 2, a: 1 },
    confirmedHash: valueHash({ a: 1, b: 2 })
  }),
  pullConflictDirty: classifyPull({
    remoteTs: 300,
    metaTs: 200,
    localValue: { v: 2 },
    confirmedHash: valueHash({ v: 1 })
  }),
  pullConflictNeverPushed: classifyPull({
    remoteTs: 300,
    metaTs: 200,
    localValue: { v: 1 },
    confirmedHash: undefined
  }),
  // 4. 冲突列表合并 / 移除
  mergeResult: mergeConflicts(
    [{ key: 'a', remoteTs: 1, remoteValue: 1, localTs: 10, at: 1 }],
    [
      { key: 'a', remoteTs: 2, remoteValue: 2, localTs: 5, at: 2 }, // 同键旧本地时间：不覆盖
      { key: 'b', remoteTs: 2, remoteValue: 2, localTs: 5, at: 2 }
    ]
  ).map((c) => c.key + ':' + c.remoteTs),
  mergeNewerWins: mergeConflicts(
    [{ key: 'a', remoteTs: 1, remoteValue: 1, localTs: 10, at: 1 }],
    [{ key: 'a', remoteTs: 2, remoteValue: 2, localTs: 20, at: 2 }]
  ).map((c) => c.key + ':' + c.remoteTs),
  withoutResult: withoutConflicts(
    [
      { key: 'a', remoteTs: 1, remoteValue: 1, localTs: 10, at: 1 },
      { key: 'b', remoteTs: 1, remoteValue: 1, localTs: 10, at: 1 }
    ],
    ['a']
  ).map((c) => c.key)
};
console.log(JSON.stringify(out));
