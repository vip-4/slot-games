#!/usr/bin/env node
/**
 * 把 llms-full.txt 接进索引层与页面 head（幂等，重复执行无副作用）。
 *   1. llms.txt 头部加入完整数据的链接
 *   2. 所有 HTML 的 canonical 之后加入两条 <link rel="alternate">
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const siteUrl = JSON.parse(readFileSync(join(ROOT, 'data/games.json'), 'utf8')).meta.site_url.replace(/\/+$/, '');

// ── 1. llms.txt ──────────────────────────────────────────────
const llmsPath = join(ROOT, 'llms.txt');
let llms = readFileSync(llmsPath, 'utf8');
const POINTER = `完整数值（每个符号逐档赔付、各特性的触发条件与参数）：${siteUrl}/llms-full.txt`;
if (!llms.includes('llms-full.txt')) {
  llms = llms.replace(
    /^本文件为生成式引擎（AI 摘要 \/ 引用）准备的事实清单，内容与页面正文一致。$/m,
    match => `${match}\n\n${POINTER}`
  );
  writeFileSync(llmsPath, llms, 'utf8');
  console.log('llms.txt: 已加入完整数据链接');
} else {
  console.log('llms.txt: 已存在，跳过');
}

// ── 2. HTML head ─────────────────────────────────────────────
const LINKS =
  `  <link rel="alternate" type="text/plain" href="${siteUrl}/llms.txt" title="AI 摘要索引（llms.txt）" />\n` +
  `  <link rel="alternate" type="text/plain" href="${siteUrl}/llms-full.txt" title="完整数值（llms-full.txt）" />`;

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'engine' || name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (name.endsWith('.html')) acc.push(p);
  }
  return acc;
}

let patched = 0;
for (const file of walk(ROOT)) {
  let html = readFileSync(file, 'utf8');
  if (html.includes('llms-full.txt')) continue;
  const m = html.match(/^[ \t]*<link rel="canonical"[^>]*>[ \t]*$/m);
  if (!m) {
    console.log(`  跳过（无 canonical）：${file.slice(ROOT.length + 1)}`);
    continue;
  }
  html = html.replace(m[0], `${m[0]}\n${LINKS}`);
  writeFileSync(file, html, 'utf8');
  patched++;
}
console.log(`HTML: ${patched} 个页面已关联 llms.txt / llms-full.txt`);
