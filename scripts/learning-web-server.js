#!/usr/bin/env node
/**
 * 学习平台 Web 展示版的静态服务。
 *
 * 为什么不用 `npx serve`：
 *   1. serve 不识别 Cloudflare 的 _headers 文件，安全响应头与 X-Robots-Tag 无法下发；
 *   2. serve 的 -s（SPA 回退）会把 /robots.txt 这类缺失路径也返回 index.html，
 *      导致 robots.txt 永远拿不到真实内容，索引控制静默失效。
 *
 * 本服务把「静态文件优先」放在「SPA 回退」之前，并支持 _headers 规则，
 * 因此 robots.txt / _headers 生效，同时 #/ 深链接刷新仍可用。
 *
 * 用法: node server.js <root> [port] [host]
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(process.argv[2] || '.');
const port = Number(process.argv[3] || 4173);
const host = process.argv[4] || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8'
};

/** 解析 _headers：支持 `/*` 与 `/assets/*` 这类前缀通配，按最长匹配优先 */
function parseHeadersFile(file) {
  const rules = [];
  let current = null;
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return rules;
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      current = { pattern: line.trim(), headers: [] };
      rules.push(current);
      continue;
    }
    const idx = line.indexOf(':');
    if (current && idx > 0) {
      current.headers.push([line.slice(0, idx).trim(), line.slice(idx + 1).trim()]);
    }
  }
  return rules;
}

function matchRule(pattern, urlPath) {
  if (pattern === '/*') return true;
  if (pattern.endsWith('/*')) return urlPath.startsWith(pattern.slice(0, -1));
  return pattern === urlPath;
}

function headersFor(rules, urlPath) {
  // 最长 pattern 优先，保证 /assets/* 覆盖 /*
  const matched = rules
    .filter((r) => matchRule(r.pattern, urlPath))
    .sort((a, b) => b.pattern.length - a.pattern.length);
  const out = new Map();
  for (const rule of matched) {
    for (const [k, v] of rule.headers) {
      if (!out.has(k.toLowerCase())) out.set(k.toLowerCase(), [k, v]);
    }
  }
  return [...out.values()];
}

const headerRules = parseHeadersFile(path.join(root, '_headers'));

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }

  const send = (status, filePath, body, extra) => {
    const headers = {};
    for (const [name, value] of headersFor(headerRules, urlPath)) headers[name] = value;
    if (extra) Object.assign(headers, extra);
    if (filePath) {
      const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      headers['Content-Type'] = type;
    }
    res.writeHead(status, headers);
    if (req.method === 'HEAD') res.end();
    else res.end(body);
  };

  // 解析到真实文件；目录不做列表，只认 index.html
  let target = path.join(root, urlPath);
  if (!target.startsWith(root)) {
    send(403, null, 'Forbidden');
    return;
  }

  let stat = null;
  try {
    stat = fs.statSync(target);
  } catch {
    stat = null;
  }
  if (stat && stat.isDirectory()) target = path.join(target, 'index.html');

  if (target === path.join(root, '_headers')) {
    // 指令文件不对外暴露
    send(404, null, 'Not Found');
    return;
  }

  try {
    const body = fs.readFileSync(target);
    send(200, target, body, { 'Content-Length': body.length });
    return;
  } catch {
    // 静态文件不存在
  }

  // SPA 回退：仅对「无扩展名的路径」回退到 index.html，避免把 robots.txt 等吞掉
  if (!path.extname(urlPath)) {
    const indexPath = path.join(root, 'index.html');
    try {
      const body = fs.readFileSync(indexPath);
      send(200, indexPath, body, { 'Content-Length': body.length });
      return;
    } catch {
      // fallthrough
    }
  }

  send(404, null, 'Not Found');
});

server.listen(port, host, () => {
  console.log('[learning-web] serving ' + root);
  console.log('[learning-web] listening on http://' + host + ':' + port);
  console.log('[learning-web] _headers 规则数: ' + headerRules.length);
});
