'use strict';
/**
 * wx-server-sdk 的进程内忠实实现（仅覆盖本仓 24 个云函数实际用到的 API 面）
 *
 * 为什么需要它：
 *   小程序主体未注册 → 无 AppID → 开不了云开发 → 24 个云函数**线上从未跑过**。
 *   `.tools/verify-cloudfunctions.mjs` 只做结构/守卫检查（递归 Proxy 万能桩：任何属性都
 *   返回自身，"写库"永远是成功）。它证明不了「会不会写脏数据」「越权能不能改到别人的记录」
 *   「openid 为 undefined 时 where 会不会退化成全表匹配」。本文件补的就是这一层：
 *   真的内存集合、真的查询/更新语义、真的 serverDate 转 Date。
 *
 * 忠实性优先级（有意为之的取舍见文件末尾 NOTES）：
 *   1. `where({ openid: undefined })` **必须**退化成"匹配全部" —— 真实 SDK 序列化时丢掉
 *      值为 undefined 的键。这是本仓反复出现的「无归属查询」事故根因；把 undefined 当成
 *      "匹配不到"会让所有 openid 守卫的测试变成假绿。
 *   2. `add()` 不注入 `_openid`（云函数环境确实不注入，项目踩过这个坑）。
 *   3. 不宽容：未知操作符、类型不匹配、无 where 的 update/remove 一律抛错。
 *      桩太宽容 = 制造假绿。
 *
 * 用法：
 *   const { createMockCloud } = require('./lib/wx-server-sdk-mock.cjs');
 *   const cloud = createMockCloud({
 *     context: { OPENID: 'oA', APPID: 'wx', UNIONID: '', ENV: 'test' },
 *     seed: { users: [{ _id: 'u1', openid: 'oA' }] },
 *     resolveFunction: (name) => loadCloudFunction(name, cloud)   // 供 cloud.callFunction 分派
 *   });
 */

/** 真实的微信云数据库错误码：集合不存在 */
const ERR_COLLECTION_NOT_EXIST = -502005;
/** 真实的微信云数据库错误码：文档不存在（document.get 命中空文档） */
const ERR_DOC_NOT_EXIST = -1;

/** 可供 `where` / `update` 使用的字段级操作符 */
const FIELD_OPS = ['gte', 'gt', 'lte', 'lt', 'eq', 'neq', 'in', 'inc', 'remove', 'pull'];

/** get() 的服务端默认条数（真实 SDK 云函数侧默认 100） */
const DEFAULT_GET_LIMIT = 100;

function mockError(code, message, tag) {
  const err = new Error(message);
  err.errCode = code;
  err.code = code;
  if (tag) err.mockTag = tag;
  return err;
}

function missingCollectionError(name) {
  return mockError(
    ERR_COLLECTION_NOT_EXIST,
    `[mock] collection not exist: ${name}（真实 SDK 的 -502005）`,
    'collection-not-exist'
  );
}

function docNotExistError(name, id) {
  return mockError(
    ERR_DOC_NOT_EXIST,
    `[mock] document not exist: ${name}/${id}（真实 SDK 的 errCode:-1）`,
    'doc-not-exist'
  );
}

function unsupportedError(surface) {
  // 前缀固定，便于断言「这是 mock 不支持，不是业务逻辑失败」
  return new Error(`mock-unsupported:${surface}`);
}

/** 深拷贝：调用方改返回值不得影响库内文档。Date 保留为 Date 实例。 */
function deepClone(value) {
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(deepClone);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = deepClone(value[key]);
    return out;
  }
  return value;
}

/** 深比较（where 的隐式 eq 语义） */
function deepEqual(a, b) {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

function isCommand(value) {
  return !!(value && typeof value === 'object' && typeof value.__mockCmd === 'string');
}

function isServerDate(value) {
  return !!(value && typeof value === 'object' && value.__mockServerDate === true);
}

/**
 * 写入前物化：serverDate 占位标记 → 真实 Date；值为 undefined 的键按真实序列化行为丢弃。
 */
function materialize(value) {
  if (isServerDate(value)) return new Date();
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(materialize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      if (value[key] === undefined) continue;
      out[key] = materialize(value[key]);
    }
    return out;
  }
  return value;
}

/** 生成文档 _id（真实 SDK 是 32 位十六进制，这里保持同形即可） */
function makeIdFactory() {
  let counter = 0;
  return () => {
    counter += 1;
    const seq = counter.toString(16).padStart(4, '0');
    const rand = Math.random().toString(16).slice(2, 10).padEnd(8, '0');
    const rand2 = Math.random().toString(16).slice(2, 18).padEnd(16, '0');
    return `${rand}${rand2}${seq}`.slice(0, 32);
  };
}

function createCommand() {
  const command = {};
  for (const op of FIELD_OPS) {
    command[op] = (value) => ({ __mockCmd: op, value });
  }
  return command;
}

/** 单字段匹配。cond 可为字面量（隐式 eq）或 {__mockCmd, value}。 */
function matchField(fieldValue, cond, fieldName) {
  if (!isCommand(cond)) {
    // 隐式 eq 对**数组字段**的语义：数组**包含**该标量即命中（MongoDB/Tencent 云数据库
    // 的数组相等语义，真实 SDK 如此）—— redeemCodes.usedBy 按 openid 查询依赖这条。
    if (Array.isArray(fieldValue) && !Array.isArray(cond)) {
      return fieldValue.some((item) => deepEqual(item, cond));
    }
    return deepEqual(fieldValue, cond);
  }

  const op = cond.__mockCmd;
  const target = cond.value;

  if (op === 'inc' || op === 'remove' || op === 'pull') {
    // 这三个只允许出现在 update 的 data 里；出现在 where 里是调用方写错了
    throw mockError(-1, `[mock] 操作符 ${op} 不能用于 where(${fieldName})`, 'bad-operator');
  }
  if (op === 'eq') {
    if (Array.isArray(fieldValue) && !Array.isArray(target)) {
      return fieldValue.some((item) => deepEqual(item, target));
    }
    return deepEqual(fieldValue, target);
  }
  if (op === 'neq') return !deepEqual(fieldValue, target);
  // gte / gt / lte / lt：比较类，类型必须一致（数字对数字、字符串对字符串）
  if (fieldValue === undefined || fieldValue === null) return false;
  const tv = fieldValue instanceof Date ? fieldValue.getTime() : fieldValue;
  const cv = target instanceof Date ? target.getTime() : target;
  if (typeof tv !== typeof cv) {
    throw mockError(
      -1,
      `[mock] 类型不匹配：where(${fieldName}) 期望 ${typeof cv}，实际 ${typeof tv}`,
      'type-mismatch'
    );
  }
  if (typeof tv !== 'number' && typeof tv !== 'string') {
    throw mockError(-1, `[mock] ${op} 只支持数字/字符串/Date：where(${fieldName})`, 'type-mismatch');
  }
  if (op === 'gte') return tv >= cv;
  if (op === 'gt') return tv > cv;
  if (op === 'lte') return tv <= cv;
  return tv < cv;
}

/** 整文档匹配。值为 undefined 的键在真实 SDK 序列化时被丢弃 → 等价于「不限制该字段」。 */
function matchDoc(doc, where) {
  if (!where) return true;
  for (const key of Object.keys(where)) {
    const cond = where[key];
    if (cond === undefined) continue; // ★ 事故根因所在：undefined ≠ 匹配不到
    if (!matchField(doc[key], cond, key)) return false;
  }
  return true;
}

/** 排序比较：null/undefined 视为最大（升序排最后），与 Mongo 行为一致 */
function compareValues(a, b) {
  const an = a === undefined || a === null;
  const bn = b === undefined || b === null;
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  const av = a instanceof Date ? a.getTime() : a;
  const bv = b instanceof Date ? b.getTime() : b;
  if (av === bv) return 0;
  return av < bv ? -1 : 1;
}

function assertPlainWhere(where, method) {
  if (where === undefined || where === null) return null;
  if (typeof where !== 'object' || Array.isArray(where)) {
    throw mockError(-1, `[mock] ${method}(where) 需要对象`, 'bad-where');
  }
  return where;
}

function createMockCloud(options = {}) {
  const opts = options || {};
  const initialContext = Object.assign(
    { OPENID: '', APPID: '', UNIONID: '', ENV: 'mock-env' },
    opts.context || {}
  );
  const seed = opts.seed || {};
  const resolveFunction = typeof opts.resolveFunction === 'function' ? opts.resolveFunction : null;
  const functionOverrides = opts.functionOverrides || {};
  /** 是否允许 add() 自动创建集合（真实环境集合需预先在控制台建，这里为构造测试数据放宽） */
  const autoCreateOnAdd = opts.autoCreateOnAdd !== false;

  const state = {
    context: Object.assign({}, initialContext),
    collections: new Map(),
    calls: [],
    initOptions: null
  };

  const nextId = makeIdFactory();

  function record(entry) {
    state.calls.push(entry);
  }

  function loadSeed() {
    state.collections = new Map();
    for (const name of Object.keys(seed)) {
      const rows = Array.isArray(seed[name]) ? seed[name] : [];
      const map = new Map();
      for (const row of rows) {
        const copy = materialize(deepClone(row));
        if (!copy._id) copy._id = nextId();
        map.set(copy._id, copy);
      }
      state.collections.set(name, map);
    }
  }
  loadSeed();

  function requireStore(name, op) {
    if (state.collections.has(name)) return state.collections.get(name);
    if (op === 'add' && autoCreateOnAdd) {
      state.collections.set(name, new Map());
      return state.collections.get(name);
    }
    throw missingCollectionError(name);
  }

  /** 把 update 的 data 应用到既有文档，返回新文档（原地修改库内对象） */
  function applyUpdate(doc, data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw mockError(-1, '[mock] update({data}) 需要对象', 'bad-update');
    }
    for (const key of Object.keys(data)) {
      const value = data[key];
      if (isCommand(value)) {
        const op = value.__mockCmd;
        if (op === 'inc') {
          const delta = value.value;
          if (typeof delta !== 'number' || !Number.isFinite(delta)) {
            throw mockError(-1, `[mock] inc 的参数必须是有限数字：${key}`, 'type-mismatch');
          }
          const current = doc[key];
          if (current === undefined || current === null) {
            doc[key] = delta;
          } else if (typeof current !== 'number') {
            // 拿 inc 去加字符串：真实 SDK 会报错，绝不静默忽略
            throw mockError(-1, `[mock] inc 只能用于数字字段：${key} 实际 ${typeof current}`, 'type-mismatch');
          } else {
            doc[key] = current + delta;
          }
        } else if (op === 'remove') {
          delete doc[key];
        } else if (op === 'pull') {
          // MongoDB pull 语义：从数组字段移除**所有**等于 value 的元素；字段缺失 = no-op；
          // 字段存在但不是数组 = 真实 SDK 报错，绝不静默忽略（redeemCodes.usedBy 清偿依赖它）
          const current = doc[key];
          if (current === undefined || current === null) {
            // no-op：保持缺失
          } else if (!Array.isArray(current)) {
            throw mockError(-1, `[mock] pull 只能用于数组字段：${key} 实际 ${typeof current}`, 'type-mismatch');
          } else {
            doc[key] = current.filter((item) => !deepEqual(item, value.value));
          }
        } else {
          throw mockError(-1, `[mock] 操作符 ${op} 不能用于 update 的 data：${key}`, 'bad-operator');
        }
        continue;
      }
      if (value === undefined) continue; // 真实序列化丢弃 undefined
      doc[key] = materialize(deepClone(value));
    }
    return doc;
  }

  class Query {
    constructor(name) {
      this._name = name;
      this._where = null;
      this._limit = null;
      this._skip = 0;
      this._orders = [];
      this._fields = null;
      this._docId = null;
    }

    where(where) {
      this._where = assertPlainWhere(where, 'where');
      return this;
    }

    doc(id) {
      if (typeof id !== 'string' || !id) {
        throw mockError(-1, '[mock] doc(id) 需要非空字符串 _id', 'bad-id');
      }
      this._docId = id;
      return this;
    }

    limit(n) {
      const num = Number(n);
      if (!Number.isFinite(num) || num < 0) {
        throw mockError(-1, `[mock] limit 需要非负数字，实际 ${n}`, 'bad-limit');
      }
      this._limit = Math.floor(num);
      return this;
    }

    skip(n) {
      const num = Number(n);
      if (!Number.isFinite(num) || num < 0) {
        throw mockError(-1, `[mock] skip 需要非负数字，实际 ${n}`, 'bad-skip');
      }
      this._skip = Math.floor(num);
      return this;
    }

    orderBy(field, direction) {
      if (typeof field !== 'string' || !field) {
        throw mockError(-1, '[mock] orderBy 需要字段名', 'bad-order');
      }
      const dir = direction === undefined ? 'asc' : direction;
      if (dir !== 'asc' && dir !== 'desc') {
        throw mockError(-1, `[mock] orderBy 方向只能是 asc/desc，实际 ${direction}`, 'bad-order');
      }
      this._orders.push({ field, dir });
      return this;
    }

    field(fields) {
      if (!fields || typeof fields !== 'object') {
        throw mockError(-1, '[mock] field() 需要对象', 'bad-field');
      }
      this._fields = fields;
      return this;
    }

    /** 取匹配文档（库内对象引用） */
    _matched() {
      const store = requireStore(this._name, 'read');
      let rows;
      if (this._docId !== null) {
        const found = store.get(this._docId);
        rows = found ? [found] : [];
      } else {
        rows = Array.from(store.values()).filter((doc) => matchDoc(doc, this._where));
        for (let i = this._orders.length - 1; i >= 0; i -= 1) {
          const { field, dir } = this._orders[i];
          const sign = dir === 'desc' ? -1 : 1;
          rows.sort((a, b) => sign * compareValues(a[field], b[field]));
        }
      }
      return rows;
    }

    _project(doc) {
      const copy = deepClone(doc);
      if (!this._fields) return copy;
      const out = {};
      for (const key of Object.keys(this._fields)) {
        const wanted = this._fields[key];
        if (wanted === 0 || wanted === false) continue;
        if (copy[key] !== undefined) out[key] = copy[key];
      }
      // _id 默认返回（除非显式置 0）
      if (copy._id !== undefined && this._fields._id !== 0 && this._fields._id !== false) {
        out._id = copy._id;
      }
      return out;
    }

    async get() {
      record({ kind: 'db.get', collection: this._name, where: deepClone(this._where), docId: this._docId });
      const rows = this._matched();
      if (this._docId !== null) {
        if (rows.length === 0) throw docNotExistError(this._name, this._docId);
        return { data: this._project(rows[0]) };
      }
      const limit = this._limit === null ? DEFAULT_GET_LIMIT : this._limit;
      const sliced = rows.slice(this._skip, this._skip + limit);
      return { data: sliced.map((doc) => this._project(doc)) };
    }

    async count() {
      record({ kind: 'db.count', collection: this._name, where: deepClone(this._where) });
      return { total: this._matched().length };
    }

    async update(payload) {
      const data = payload && payload.data;
      assertPlainWhere(this._where, 'update');
      if (this._docId === null && !this._where) {
        // 真实 SDK 也不支持「无条件的 collection.update」；这里明确拒绝，避免"忘了 where 就全表改"
        throw mockError(-1, `[mock] collection(${this._name}).update 必须带 where/doc`, 'unsafe-update');
      }
      const rows = this._matched();
      record({
        kind: 'db.update',
        collection: this._name,
        where: deepClone(this._where),
        docId: this._docId,
        data: deepClone(data)
      });
      for (const doc of rows) applyUpdate(doc, data);
      return { stats: { updated: rows.length } };
    }

    async set(payload) {
      const data = payload && payload.data;
      if (this._docId === null) {
        throw mockError(-1, `[mock] collection(${this._name}).set 只支持 doc(id).set`, 'unsafe-set');
      }
      const store = requireStore(this._name, 'add');
      record({ kind: 'db.set', collection: this._name, docId: this._docId, data: deepClone(data) });
      const next = materialize(deepClone(data || {}));
      next._id = this._docId;
      const existed = store.has(this._docId);
      store.set(this._docId, next);
      return { stats: { updated: existed ? 1 : 0, created: existed ? 0 : 1 }, _id: this._docId };
    }

    async remove() {
      const store = requireStore(this._name, 'write');
      if (this._docId === null && !this._where) {
        throw mockError(-1, `[mock] collection(${this._name}).remove 必须带 where/doc`, 'unsafe-remove');
      }
      const rows = this._matched();
      record({ kind: 'db.remove', collection: this._name, where: deepClone(this._where), docId: this._docId });
      for (const doc of rows) store.delete(doc._id);
      return { stats: { removed: rows.length } };
    }

    async add(payload) {
      if (!payload || payload.data === undefined) {
        throw mockError(-1, '[mock] add({data}) 缺少 data', 'bad-add');
      }
      const store = requireStore(this._name, 'add');
      const rows = Array.isArray(payload.data) ? payload.data : [payload.data];
      record({ kind: 'db.add', collection: this._name, rows: deepClone(rows) });
      const ids = [];
      for (const row of rows) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
          throw mockError(-1, `[mock] add(${this._name}) 的 data 必须是对象或对象数组`, 'bad-add');
        }
        const doc = materialize(deepClone(row));
        if (!doc._id) doc._id = nextId();
        // ★ 不注入 _openid：云函数环境确实不注入（_openid 只在客户端 SDK 写记录时存在）
        if (store.has(doc._id)) {
          throw mockError(-1, `[mock] add(${this._name}) 主键冲突: ${doc._id}`, 'duplicate-id');
        }
        store.set(doc._id, doc);
        ids.push(doc._id);
      }
      return Array.isArray(payload.data) ? { _id: ids, ids } : { _id: ids[0] };
    }
  }

  const db = {
    collection(name) {
      if (typeof name !== 'string' || !name) {
        throw mockError(-1, '[mock] collection(name) 需要非空字符串', 'bad-collection');
      }
      return new Query(name);
    },
    command: createCommand(),
    serverDate() {
      return { __mockServerDate: true };
    },
    RegExp(options) {
      // 极少数用法；本仓云函数未使用，保留最小实现
      return { __mockRegexp: true, options };
    }
  };

  /** 未实现的外部能力：存在但调用即抛可识别错误，绝不伪装成功 */
  function unsupported(surface) {
    const fn = function unsupportedFn() {
      record({ kind: 'unsupported', surface });
      throw unsupportedError(surface);
    };
    return new Proxy(fn, {
      get(_target, prop) {
        if (prop === 'then' || prop === 'toJSON') return undefined;
        return unsupported(`${surface}.${String(prop)}`);
      },
      apply() {
        record({ kind: 'unsupported', surface });
        throw unsupportedError(surface);
      }
    });
  }

  const cloud = {
    DYNAMIC_CURRENT_ENV: 'DYNAMIC_CURRENT_ENV',
    init(initOptions) {
      state.initOptions = initOptions;
      return initOptions;
    },
    database() {
      return db;
    },
    getWXContext() {
      return Object.assign({}, state.context);
    },
    async callFunction(payload) {
      const name = payload && payload.name;
      const data = payload && payload.data;
      if (typeof name !== 'string' || !name) {
        throw mockError(-1, '[mock] callFunction 需要 name', 'bad-call');
      }
      record({ kind: 'callFunction', name, data: deepClone(data) });
      if (Object.prototype.hasOwnProperty.call(functionOverrides, name)) {
        // 测试显式声明的替身（仅用于"支付通道不可用"之外的定向验证，使用处必须注明）
        return { result: await functionOverrides[name](data) };
      }
      if (!resolveFunction) {
        throw unsupportedError(`callFunction:${name}（未提供 resolveFunction）`);
      }
      const mod = resolveFunction(name);
      if (!mod || typeof mod.main !== 'function') {
        throw mockError(-1, `[mock] 云函数 ${name} 没有 exports.main`, 'bad-call');
      }
      return { result: await mod.main(data) };
    },
    cloudPay: unsupported('cloudPay'),
    openapi: unsupported('openapi'),
    getTempFileURL: unsupported('getTempFileURL'),
    uploadFile: unsupported('uploadFile'),
    downloadFile: unsupported('downloadFile'),
    ts: unsupported('ts')
  };

  cloud.__calls = state.calls;

  cloud.__dump = function __dump() {
    const out = {};
    for (const [name, map] of state.collections.entries()) {
      out[name] = Array.from(map.values()).map((doc) => deepClone(doc));
    }
    return out;
  };

  cloud.__reset = function __reset() {
    state.calls.length = 0;
    state.context = Object.assign({}, initialContext);
    loadSeed();
  };

  cloud.__setContext = function __setContext(ctx) {
    state.context = Object.assign({}, state.context, ctx || {});
    return cloud.getWXContext();
  };

  /** 测试中途补数据（深拷贝写入，等价于"库里已有"） */
  cloud.__seed = function __seed(name, rows) {
    if (!state.collections.has(name)) state.collections.set(name, new Map());
    const map = state.collections.get(name);
    for (const row of Array.isArray(rows) ? rows : [rows]) {
      const doc = materialize(deepClone(row));
      if (!doc._id) doc._id = nextId();
      map.set(doc._id, doc);
    }
    return map.size;
  };

  /** 取某个集合的全部文档（不经排序/limit，供断言用） */
  cloud.__docs = function __docs(name) {
    const map = state.collections.get(name);
    return map ? Array.from(map.values()).map((doc) => deepClone(doc)) : [];
  };

  /** 调用流水中筛选（例如 __called('callFunction', 'webSearch')） */
  cloud.__called = function __called(kind, needle) {
    return state.calls.filter((c) => {
      if (c.kind !== kind) return false;
      if (needle === undefined) return true;
      return c.name === needle || c.surface === needle || c.collection === needle;
    });
  };

  return cloud;
}

module.exports = {
  createMockCloud,
  // 导出内部工具：harness 自己也用它断言 mock 的语义（元测试）
  __internal: {
    deepClone,
    deepEqual,
    matchDoc,
    materialize,
    isCommand,
    ERR_COLLECTION_NOT_EXIST,
    ERR_DOC_NOT_EXIST,
    DEFAULT_GET_LIMIT
  }
};

/**
 * NOTES —— 与真实 wx-server-sdk 的已知差异（诚实清单，勿当等价物用）
 *
 * 1. 集合存在性：真实环境集合要在控制台先创建，读不存在的集合报 -502005。本 mock 默认
 *    「add 时自动创建」，其余操作对未 seed 的集合抛 -502005。因此 deleteAccount 的
 *    「集合不存在 → 跳过」分支能被真实触发，但「add 到未建集合是否报错」这一点被放宽了。
 * 2. get() 默认 limit 100 已对齐；但真实 SDK 单次上限 100/1000（客户端/服务端）未模拟。
 * 3. 索引/唯一约束/权限规则（数据库权限、安全规则）完全不模拟 —— 越权保护只能靠代码里的
 *    openid 条件，这也正是本 harness 要验证的东西。
 * 4. 事务（runTransaction）、聚合（aggregate）、地理位置、正则查询未实现。
 * 5. serverDate() 返回的是「写入时刻」而非服务端时钟（无偏移量语义）。
 * 6. update 的嵌套字段路径（'a.b'）、数组下标、push/pull 等数组操作符未实现；
 *    本仓云函数未使用（shopping 用整体覆盖 prices 数组）。
 * 7. cloud.callFunction 不做真实的网络/冷启动/超时/序列化（Date 原样传递，
 *    真实跨函数调用会 JSON 序列化，Date 会变字符串）。因此跨函数的 Date 传递行为不可信。
 * 8. 错误对象形状：只给了 errCode/code/message，真实 SDK 还有 errMsg/requestID 等。
 */
