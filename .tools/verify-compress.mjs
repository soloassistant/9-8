/**
 * verify-compress.mjs —— 头像压缩（src/utils/imageCompress.ts）的**真浏览器**回归
 *
 * 用法：node .tools/verify-compress.mjs（等价 npm run verify:compress）
 *      CI 不跑它（需要真 Chrome），与 verify:layout / verify:visual 同待遇；
 *      但它必须存在：压缩逻辑是纯位图操作，Node 里的 jsdom 没有 canvas，
 *      唯一可信的验证场地就是真 Chrome 的 canvas 实现。
 *
 * 为什么必须用真浏览器验，而不是静态断言：
 *   ① 「不放大」只有把 200px 图喂进去看**输出尺寸**才算证明（读源码 `Math.min(1,…)` 只是看到意图）；
 *   ② 「PNG 的透明没被弄丢」要读回像素的 alpha 通道 —— JPEG 化会让透明角变黑，肉眼都不一定发现；
 *   ③ 「GIF 不被压成静图」要确认返回的是**同一个对象**，不是体积相等的另一个 blob。
 *
 * 做法：把 entry.ts 作为字符串交给 esbuild（resolveDir 指向 src/utils，写成普通相对导入，
 * 不用 `@/` 别名 —— 别名只在 taro 的构建里成立），产物落到系统临时目录起个静态服务，
 * 再用 .tools/cdp-probe.mjs 驱动真 Chrome 执行用例、取回 JSON 断言。
 * 刻意不在 .tools/ 下新建子目录：那里是「`.tools/*` 全忽略 + 白名单」的口径，加目录要同步改
 * .gitignore，否则文件在磁盘、本地能跑、从未进库（踩过）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROBE = path.join(ROOT, '.tools', 'cdp-probe.mjs');

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond === true) {
    pass += 1;
    console.log('  PASS ' + name);
  } else {
    fail += 1;
    const d = detail == null ? '' : String(detail);
    failures.push(name + (d ? ' :: ' + d : ''));
    console.log('  FAIL ' + name + (d ? '  :: ' + d : ''));
  }
}

/* ------------------------------------------------------------------ 用例页 */

const ENTRY = `
import { compressImage, AVATAR_MAX_EDGE } from './imageCompress';

async function makeImage(w, h, type) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#ff0055');
  g.addColorStop(0.5, '#00aaff');
  g.addColorStop(1, '#00ff88');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  if (type === 'image/png') ctx.clearRect(0, 0, Math.floor(w / 4), Math.floor(h / 4));
  const blob = await new Promise(function (r) { c.toBlob(r, type, 0.98); });
  return new File([blob], 'test.' + type.split('/')[1], { type: type });
}

async function alphaAt(src, x, y) {
  const bmp = await createImageBitmap(src);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(x, y, 1, 1).data[3];
}

async function dimsOf(src) {
  const bmp = await createImageBitmap(src);
  return [bmp.width, bmp.height];
}

window.__runTest = async function () {
  const out = { maxEdge: AVATAR_MAX_EDGE };

  // A. 大 PNG 带透明角：缩到 512、体积变小、alpha 保留、格式仍是 png
  const fa = await makeImage(1600, 1200, 'image/png');
  const ra = await compressImage(fa);
  const da = await dimsOf(ra);
  out.A = {
    srcSize: fa.size, outSize: ra.size, dims: da, type: ra.type,
    alphaTopLeft: await alphaAt(ra, 4, 4),
    alphaCenter: await alphaAt(ra, Math.floor(da[0] / 2), Math.floor(da[1] / 2))
  };

  // B. 小图不放大：原样返回（同一个对象）
  const fb = await makeImage(200, 180, 'image/png');
  const rb = await compressImage(fb);
  out.B = { sameObject: rb === fb, dims: await dimsOf(rb), srcSize: fb.size, outSize: rb.size };

  // C. GIF 不参与重编码：必须是**真 GIF**（假的解码会失败，走兜底分支，测不出短路是否还在），
  //    并且要能证明「压根没碰 canvas」——只看返回对象是否相同是不够的：
  //    就算短路被删了，重编码出来的体积通常比原 GIF 大，函数仍会返回原对象（假绿）。
  //    base64 为 1x1 透明 GIF（GIF89a，合法可解码）。
  const gifBytes = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), function (ch) {
    return ch.charCodeAt(0);
  });
  const fc = new File([gifBytes], 'a.gif', { type: 'image/gif' });
  const origCreateForC = document.createElement.bind(document);
  let canvasTouched = false;
  document.createElement = function (tag) {
    if (tag === 'canvas') canvasTouched = true;
    return origCreateForC(tag);
  };
  const rc = await compressImage(fc);
  document.createElement = origCreateForC;
  out.C = { sameObject: rc === fc, type: rc.type, canvasTouched: canvasTouched, srcSize: fc.size };

  // D. 没有 createImageBitmap 时走 Image 回退，仍应压缩成功（先恢复再测量）
  const saved = window.createImageBitmap;
  window.createImageBitmap = undefined;
  const fd = await makeImage(1600, 1200, 'image/jpeg');
  const rd = await compressImage(fd);
  window.createImageBitmap = saved;
  out.D = { compressed: rd !== fd, srcSize: fd.size, outSize: rd.size, dims: await dimsOf(rd) };

  // E. 画布不可用必须原样返回（压缩是优化，不许让上传失败）
  const fe = await makeImage(1600, 1200, 'image/jpeg');
  const origCreate = document.createElement.bind(document);
  document.createElement = function (tag) {
    if (tag === 'canvas') return { width: 0, height: 0, getContext: function () { return null; } };
    return origCreate(tag);
  };
  const re = await compressImage(fe);
  document.createElement = origCreate;
  out.E = { sameObject: re === fe };

  return JSON.stringify(out);
};
`;

/* ------------------------------------------------------------------ 环境 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-compress-'));

function serve(dir) {
  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    const rel = url === '/' ? 'index.html' : url.replace(/^\//, '');
    const file = path.join(dir, rel);
    if (!file.startsWith(dir) || !fs.existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    const ext = path.extname(file);
    res.writeHead(200, { 'content-type': ext === '.js' ? 'text/javascript' : 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function cleanup(code) {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 临时目录删不掉不影响结果 */
  }
  process.exit(code);
}

/** 起探针并取回 stdout+stderr。
 *  ⚠️ 必须异步 spawn：服务与被测页在**同一个进程**里（http server + Chrome），
 *  用 spawnSync 会把主线程堵住 → 静态服务永不应答 → CDP 报 `Page.navigate` 超时
 *  （第一版就是这么挂的，看起来像浏览器起不来）。 */
function runProbe(args, timeoutMs = 180_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ROOT });
    let out = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已经退出 */
      }
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

/* ------------------------------------------------------------------ 主流程 */

try {
  const esbuild = await import('esbuild');
  const built = await esbuild.build({
    stdin: {
      contents: ENTRY,
      resolveDir: path.join(ROOT, 'src', 'utils'),
      loader: 'ts',
      sourcefile: 'compress-entry.ts'
    },
    bundle: true,
    format: 'iife',
    target: 'es2020',
    write: false
  });
  const js = built.outputFiles[0].text;
  fs.writeFileSync(path.join(tmp, 'bundle.js'), js);
  fs.writeFileSync(path.join(tmp, 'index.html'), '<!doctype html><meta charset="utf-8"><script src="./bundle.js"></script>');

  const server = await serve(tmp);
  const port = server.address().port;
  console.log('\n真 Chrome 用例（canvas 位图，jsdom 测不了）');

  const raw = await runProbe([
    PROBE,
    `http://127.0.0.1:${port}/`,
    '800',
    '600',
    '--wait',
    '1500',
    '--expr',
    'window.__runTest()'
  ]);
  server.close();

  const jsonStart = raw.indexOf('{');
  let parsed = null;
  try {
    parsed = JSON.parse(raw.slice(jsonStart));
  } catch {
    parsed = null;
  }
  if (!parsed || !parsed.value) {
    ok('探针跑出结果（非 chrome-error / 非 JS 异常）', false, (parsed && parsed.error) || raw.slice(0, 300));
    throw new Error('probe failed');
  }

  const r = parsed.value;
  ok('测试跑在真 Chrome 上且 maxEdge 为 512', typeof r.maxEdge === 'number' && r.maxEdge === 512, JSON.stringify(r.maxEdge));

  /* A：1600x1200 → 512x384，体积分母至少 3 倍，透明角 alpha=0、中心不透明、格式仍是 png */
  const A = r.A || {};
  ok('A 大图缩到最长边 512（1600x1200 → 512x384）',
    Array.isArray(A.dims) && A.dims[0] === 512 && A.dims[1] === 384, JSON.stringify(A.dims));
  ok('A 体积显著变小（至少 1/3）', A.outSize > 0 && A.outSize * 3 < A.srcSize, A.srcSize + ' → ' + A.outSize);
  ok('A PNG 的透明角没被弄丢（alpha=0）', A.alphaTopLeft === 0, 'alpha=' + A.alphaTopLeft);
  ok('A 不透明区域仍然不透明（alpha=255）', A.alphaCenter === 255, 'alpha=' + A.alphaCenter);
  ok('A 格式仍为 image/png（没被偷偷转成 jpeg）', A.type === 'image/png', A.type);

  /* B：小图不许放大 */
  const B = r.B || {};
  ok('B 小图不放大（200x180 原样返回）',
    B.sameObject === true && Array.isArray(B.dims) && B.dims[0] === 200 && B.dims[1] === 180,
    JSON.stringify(B.dims) + ' sameObject=' + B.sameObject);

  /* C：GIF 不许被压成静图 —— 不只返回原对象，还必须「根本没碰 canvas」 */
  const C = r.C || {};
  ok('C GIF 原样返回且完全不碰 canvas（不重编码 = 不丢帧）',
    C.sameObject === true && C.type === 'image/gif' && C.canvasTouched === false,
    JSON.stringify(C));

  /* D：createImageBitmap 缺失时的 Image 回退 */
  const D = r.D || {};
  ok('D 无 createImageBitmap 时仍能压缩（Image 回退可用）',
    D.compressed === true && Array.isArray(D.dims) && D.dims[0] === 512 && D.outSize < D.srcSize,
    JSON.stringify(D));

  /* E：画布不可用时必须原样返回 —— 压缩是优化，不是上传的前置条件 */
  const E = r.E || {};
  ok('E 画布不可用时原样返回（不拖垮上传）', E.sameObject === true, JSON.stringify(E));

  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED') + `  pass=${pass} fail=${fail}`);
  if (fail) {
    console.log('\n失败明细：');
    for (const f of failures) console.log('  · ' + f);
  }
  cleanup(fail === 0 ? 0 : 1);
} catch (err) {
  if (fail === 0) {
    console.log('  FAIL 执行异常：' + String(err && err.message ? err.message : err));
    fail += 1;
  }
  console.log('\nFAILED  pass=' + pass + ' fail=' + fail);
  cleanup(1);
}
