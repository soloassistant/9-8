#!/usr/bin/env node
/**
 * 变异验证工具（2026-10-20）—— 把「改坏源码 → 跑验证 → 恢复源码」变成有兜底的流水线。
 *
 * 防的是什么事故（2026-10-20 本会话实际踩过）：
 *   1. 用 sed 手改源码做变异，替换串没匹配上（比如尾逗号差异）→ "恢复"静默失败，
 *      仓库被留在变异态，后续 harness 结果是假的；
 *   2. 变异检查点写得太弱 → 变异没被抓到也显示"通过"（假绿）；
 *   3. 恢复后没人复跑 → 不知道仓库是否真的回到绿态。
 *
 * 用法：
 *   node .tools/mutation-verify.mjs <caseFile.mjs> [更多 caseFile...]
 *
 * case 文件（.mjs，默认导出数组）：
 *   export default [{
 *     label: '去 RFC4180 转义',            // 人读的变异名
 *     file:  'src/utils/ledgerExport.ts', // 相对仓库根
 *     from:  '<文件中唯一存在的精确字符串>',
 *     to:    '<变异后的字符串>',
 *     cmd:   'node .tools/verify-ledger-export.mjs' // 变异态下要跑的验证命令
 *   }]
 *
 * 每个 case 的执行顺序（任何一步失败都不静默）：
 *   ⓪ **基线先行**：每个不同的 cmd 先在干净状态跑一次，必须退出码 0
 *      （基线就红 / harness 不存在 → 直接判工具级 ERROR 退出，绝不变异 ——
 *       否则"跑不起来"会被误判成"变异被抓到"，是经典假绿）；
 *   ① 锚点必须正好出现 1 次（0 或多次 → 该 case 判 ERROR，不动文件）；
 *   ② 目标文件必须没有未提交改动（`git status --porcelain` 非空 → 拒绝变异，
 *      避免变异同仓其他在飞的工作）；
 *   ③ 替换并回读，确认 `to` 已写入、`from` 已消失；
 *   ④ 以 NODE_PATH=<repo>/node_modules 跑 cmd，记录退出码；
 *   ⑤ **无论结果如何都恢复原文件，并 sha256 逐字节校验**（失配 → 退出码 3，
 *      明示"仓库被留在变异态，需人工处理"，绝不允许带病继续）；
 *   ⑥ 退出码非零 = CAUGHT（变异被抓住，好）；零 = NOT-CAUGHT（断言没有判别力，坏）。
 * 全部跑完后，对每个不同的 cmd 在**恢复态**复跑一次，必须退出码 0
 * （证明"恢复态是绿的"，防止恢复后一直红没人发现）。
 *
 * 退出码：0 = 全部 CAUGHT 且恢复校验全过且恢复态全绿；
 *         1 = 有 NOT-CAUGHT 或恢复态不绿；
 *         2 = 有用例级 ERROR（锚点/脏文件/变异未生效/用法错误）；
 *         3 = 恢复失配（致命，仓库可能被留在变异态）。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_PATH = path.join(REPO, 'node_modules');
const RUN_TIMEOUT_MS = 120_000;

const EXIT = { OK: 0, NOT_CAUGHT: 1, CASE_ERROR: 2, RESTORE_MISMATCH: 3 };

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const tailOf = (s, n = 12) =>
  String(s || '')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .slice(-n)
    .join('\n');

/** 跑一条命令，返回 { status, signal, stdout, stderr }；status===null 表示被信号杀死/超时 */
function runCmd(cmd, cwd = REPO) {
  const r = spawnSync(cmd, {
    shell: true,
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: RUN_TIMEOUT_MS,
    env: { ...process.env, NODE_PATH }
  });
  return r;
}

async function loadCases(caseFile) {
  const abs = path.resolve(REPO, caseFile);
  if (!existsSync(abs)) throw new Error(`case 文件不存在: ${caseFile}`);
  const mod = await import(pathToFileURL(abs).href);
  const cases = mod.default;
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new Error(`case 文件必须默认导出非空数组: ${caseFile}`);
  }
  for (const [i, c] of cases.entries()) {
    // from 必须非空（空 from 会匹配出无数锚点）；to 允许空串——"删掉某行"是合法变异
    for (const k of ['label', 'file', 'from', 'cmd']) {
      if (typeof c[k] !== 'string' || c[k] === '') {
        throw new Error(`${caseFile}[${i}] 缺少非空字符串字段 ${k}`);
      }
    }
    if (typeof c.to !== 'string') {
      throw new Error(`${caseFile}[${i}] to 必须是字符串（可为空串表示删除）`);
    }
    if (c.from === c.to) throw new Error(`${caseFile}[${i}] from 与 to 相同（这不是变异）`);
  }
  return cases;
}

/**
 * 跑单个 case。返回 { status: 'CAUGHT'|'NOT-CAUGHT'|'ERROR'|'FATAL', detail }。
 * FATAL 只可能是恢复失配 —— 调用方必须立即中止整个流程。
 */
function runCase(c) {
  const out = { status: 'ERROR', detail: '' };
  const filePath = path.join(REPO, c.file);
  if (!existsSync(filePath)) {
    out.detail = `目标文件不存在: ${c.file}`;
    return out;
  }
  const orig = readFileSync(filePath, 'utf8');
  const occurrences = orig.split(c.from).length - 1;
  if (occurrences !== 1) {
    out.detail = `锚点出现 ${occurrences} 次（要求正好 1 次）—— 修 case 的 from，别猜`;
    return out;
  }
  const st = spawnSync('git', ['status', '--porcelain', '--', c.file], { cwd: REPO, encoding: 'utf8' });
  if (st.status !== 0) {
    out.detail = `git status 失败: ${st.stderr || st.stdout}`;
    return out;
  }
  if (st.stdout.trim() !== '') {
    out.detail = `目标文件有未提交改动，拒绝变异（避免动别人在飞的工作）: ${st.stdout.trim()}`;
    return out;
  }

  const before = sha256(orig);
  const mutated = orig.replace(c.from, c.to);
  if (mutated === orig) {
    out.detail = '变异没产生任何变化（from/to 等价？）';
    return out;
  }
  // 注意：不禁止「to 里含 from」—— 追加式变异（如给某行加注释）天然如此，
  // 该不该被抓住由验证命令的退出码说话（抓不住就报 NOT-CAUGHT），不是这里的错。

  let mutatedOnDisk = false;
  let run = null;
  try {
    writeFileSync(filePath, mutated);
    mutatedOnDisk = true;
    const written = readFileSync(filePath, 'utf8');
    if (!written.includes(c.to)) {
      out.detail = '写回后没找到 to（写入被截断？）';
      return out;
    }
    run = runCmd(c.cmd);
  } catch (err) {
    out.detail = `变异/运行期间抛异常: ${err && err.message ? err.message : err}`;
  }

  if (mutatedOnDisk) {
    try {
      writeFileSync(filePath, orig);
      if (sha256(readFileSync(filePath, 'utf8')) !== before) {
        out.status = 'FATAL';
        out.detail = `恢复后 sha256 不一致 —— 仓库可能被留在变异态（${c.file}），需人工处理`;
        return out;
      }
    } catch (err) {
      out.status = 'FATAL';
      out.detail = `恢复写盘失败: ${err && err.message ? err.message : err}`;
      return out;
    }
  }

  if (!run) return out; // 已在上面记了 detail
  if (run.status === null) {
    out.detail = `验证命令被信号杀死/超时（signal=${run.signal}）—— 结果不确定，判 ERROR`;
    return out;
  }
  if (run.status !== 0) {
    out.status = 'CAUGHT';
    out.detail = `验证退出码 ${run.status}（变异被抓住）`;
  } else {
    out.status = 'NOT-CAUGHT';
    out.detail = '验证退出码 0 —— 断言抓不住这个变异，没有判别力';
    out.tail = `${tailOf(run.stdout)}\n${tailOf(run.stderr)}`.trim();
  }
  return out;
}

async function main() {
  const caseFiles = process.argv.slice(2);
  if (caseFiles.length === 0) {
    console.error('用法: node .tools/mutation-verify.mjs <caseFile.mjs> [更多 caseFile...]');
    process.exit(EXIT.CASE_ERROR);
  }

  let allCases = [];
  for (const f of caseFiles) {
    try {
      allCases = allCases.concat(await loadCases(f));
    } catch (err) {
      console.error(`ERROR  加载 ${f} 失败: ${err.message}`);
      process.exit(EXIT.CASE_ERROR);
    }
  }

  // ⓪ 基线先行：每个 cmd 在干净状态必须绿。基线红/harness 缺失 → 直接退出，
  // 绝不变异（否则非零退出会被当成"变异被抓到"，假绿）。
  const cmdsForBaseline = [...new Set(allCases.map((c) => c.cmd))];
  for (const cmd of cmdsForBaseline) {
    const r = runCmd(cmd);
    if (r.status !== 0) {
      console.error(
        `ERROR  基线就是红的（signal=${r.signal}, exit=${r.status}），拒绝变异 —— ` +
          `先修好验证命令本身：${cmd}`
      );
      const t = `${tailOf(r.stdout)}\n${tailOf(r.stderr)}`.trim();
      if (t) console.error(`  --- 基线输出尾部 ---\n${t}\n  ---`);
      process.exit(EXIT.CASE_ERROR);
    }
    console.log(`BASELINE    ${cmd}  —— 干净态退出码 0`);
  }

  const results = [];
  for (const c of allCases) {
    const r = runCase(c);
    results.push({ c, r });
    const mark = { CAUGHT: 'CAUGHT', 'NOT-CAUGHT': 'NOT-CAUGHT', ERROR: 'ERROR', FATAL: 'FATAL' }[r.status];
    console.log(`${mark.padEnd(12)} ${c.label}  —— ${r.detail}`);
    if (r.tail) console.log(`  --- 验证输出尾部 ---\n${r.tail}\n  ---`);
    if (r.status === 'FATAL') {
      console.error(`\nFATAL: ${r.detail}\n立即中止，不再跑后续 case。`);
      process.exit(EXIT.RESTORE_MISMATCH);
    }
  }

  // 恢复态复跑：每个不同的 cmd 跑一次，必须绿
  const cmds = [...new Set(allCases.map((c) => c.cmd))];
  let restoredGreen = true;
  for (const cmd of cmds) {
    const r = runCmd(cmd);
    if (r.status === 0) {
      console.log(`GREEN        ${cmd}  —— 恢复态复跑退出码 0`);
    } else {
      restoredGreen = false;
      console.log(`RED          ${cmd}  —— 恢复态复跑退出码 ${r.status}（signal=${r.signal}）`);
      const t = `${tailOf(r.stdout)}\n${tailOf(r.stderr)}`.trim();
      if (t) console.log(`  --- 验证输出尾部 ---\n${t}\n  ---`);
    }
  }

  const nCaught = results.filter((x) => x.r.status === 'CAUGHT').length;
  const nMissed = results.filter((x) => x.r.status === 'NOT-CAUGHT').length;
  const nError = results.filter((x) => x.r.status === 'ERROR').length;
  console.log(
    `\n_RESULT caught=${nCaught} not_caught=${nMissed} error=${nError} total=${results.length} restored_green=${restoredGreen}`
  );

  if (nMissed > 0 || !restoredGreen) process.exit(EXIT.NOT_CAUGHT);
  if (nError > 0) process.exit(EXIT.CASE_ERROR);
  process.exit(EXIT.OK);
}

main().catch((err) => {
  console.error(`工具自身错误: ${err && err.stack ? err.stack : err}`);
  process.exit(EXIT.CASE_ERROR);
});
