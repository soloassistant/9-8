#!/usr/bin/env node
/**
 * audit-exp.mjs —— 证伪/边界实验驱动（只读）。
 *  1) 变异对照：mutate=1 把 panel 宽度内联改回 auto!important，验证"几何断言会报警"
 *  2) ui-scale 档位扫描：0.85/1/1.15/1.3
 *  3) 断点边界：视口 499/500/501
 *  4) 独立第二测法：offsetWidth/clientWidth/computedStyle 与 getBoundingClientRect 交叉核对
 * 用法: node .tools/audit-exp.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PROBE = path.join(ROOT, '.tools', 'cdp-probe.mjs');
const SESSION = path.join(ROOT, '.tools', 'cdp-probe-session.js');
const EXPR_FILE = path.join(ROOT, '.tools', 'audit-exp-expr.js');
const CHROME =
  process.env.CHROME_BIN || 'C:\\Users\\geral\\.agent-browser\\browsers\\chrome-154.0.8037.92\\chrome.exe';
const BASE = 'http://127.0.0.1:8099';
const expr = fs.readFileSync(EXPR_FILE, 'utf8');

function run(args, env) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '', e = '';
    c.stdout.on('data', (d) => (o += d));
    c.stderr.on('data', (d) => (e += d));
    c.on('close', (code) => resolve({ code, o, e }));
  });
}

let PORT = 9600;
async function probe(page, w, h, query, tag) {
  const png = path.join(ROOT, '.tools', '.audit', `exp-${tag}.png`);
  const url = `${BASE}/${query ? '?' + query : ''}#/${page}`;
  const r = await run(
    [PROBE, url, String(w), String(h), '--init-script', SESSION, '--block-url', '*cdn.jsdelivr.net*', '--expr', expr, '--png', png, '--wait', '6000'],
    { CHROME_BIN: CHROME, CDP_PORT: String(PORT++) }
  );
  let v = null;
  try { v = JSON.parse(r.o).value; } catch {}
  if (!v) return { tag, page, vp: `${w}x${h}`, query, error: (r.o + r.e).slice(0, 200) };
  return { tag, page, vp: `${w}x${h}`, query, v, png };
}

function line(r, wantPanel) {
  if (r.error) return `${r.tag.padEnd(30)} ${r.vp.padEnd(10)} ERROR ${r.error.slice(0, 60)}`;
  const v = r.v;
  const expX = (v.vw - wantPanel) / 2;
  const okPanel = Math.abs((v.panel?.w || 0) - wantPanel) <= 1;
  const okCenter = Math.abs((v.panel?.x || 0) - expX) <= 1;
  const okPage = (v.page?.w || 0) > 0;
  const okOver = v.scrollW <= v.vw + 1;
  return (
    `${r.tag.padEnd(30)} ${r.vp.padEnd(10)} rem=${String(v.rem).padEnd(8)} scale=${String(v.uiScale || '1').padEnd(5)} ` +
    `panel=${String(v.panel?.w).padEnd(7)}@${String(v.panel?.x).padEnd(6)} page=${String(v.page?.w).padEnd(6)} ` +
    `scrollW=${String(v.scrollW).padEnd(6)} ${okPanel ? 'P' : 'F'}${okCenter ? 'P' : 'F'}${okPage ? 'P' : 'F'}${okOver ? 'P' : 'F'}`
  );
}

async function main() {
  fs.mkdirSync(path.join(ROOT, '.tools', '.audit'), { recursive: true });
  const R = [];

  console.log('\n=== A. 变异对照（briefing@1280，mutate=1 把 panel 宽度改回 auto）===');
  R.push(await probe('pages/briefing/index', 1280, 720, '', 'ctrl-none'));
  R.push(await probe('pages/briefing/index', 1280, 720, 'mutate=1', 'ctrl-mutate'));

  console.log('\n=== B. ui-scale 档位扫描（briefing@1280 与 inbox@1280）===');
  for (const s of ['0.85', '1', '1.15', '1.3']) {
    R.push(await probe('pages/briefing/index', 1280, 720, `scale=${s}`, `scale-${s}-briefing`));
  }
  for (const s of ['0.85', '1.3']) {
    R.push(await probe('pages/inbox/index', 1280, 720, `scale=${s}`, `scale-${s}-inbox`));
  }

  console.log('\n=== C. 断点边界（briefing 在 499/500/501）===');
  for (const w of [499, 500, 501]) {
    R.push(await probe('pages/briefing/index', w, 800, '', `bp-${w}`));
  }

  fs.writeFileSync(path.join(ROOT, '.tools', '.audit', 'exp.json'), JSON.stringify(R, null, 2));

  console.log('\n=== 结果（P=通过 F=失败；末四位=面板宽/居中/页宽>0/无溢出）===');
  for (const r of R) console.log(line(r, Math.min(Number(r.vp.split('x')[0]), 500)));

  console.log('\n=== 第二测法交叉核对（offsetWidth vs getBoundingClientRect）===');
  for (const r of R) {
    if (r.error) continue;
    const v = r.v;
    console.log(
      `${r.tag.padEnd(30)} panel: rect=${v.panel?.w} offsetW=${v.panelAlt?.offsetW} clientW=${v.panelAlt?.clientW} cssW=${v.panelAlt?.cssW} | ` +
      `page: rect=${v.page?.w} offsetW=${v.pageAlt?.offsetW} cssW=${v.pageAlt?.cssW}`
    );
  }
  console.log('');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
