#!/usr/bin/env node
/**
 * 由 data/games.json 生成 llms-full.txt（GEO 完整层）。
 *
 * llms.txt 只给结论与索引，llms-full.txt 给出**全部可引用数值**：
 * 每个符号的逐档赔付、各特性的触发条件与参数、投注档位。
 * AI 需要引用具体数字时应以此文件为准，避免凭印象编造。
 *
 * 用法：node tools/gen-llms-full.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(readFileSync(resolve(ROOT, 'data/games.json'), 'utf8'));

const siteUrl = (data.meta?.site_url ?? '').replace(/\/+$/, '');
const pct = v => `${(Number(v) * 100).toFixed(2)}%`;
const num = v => (Number.isInteger(Number(v)) ? String(Number(v)) : String(Number(v)));

/** 转义表格单元格里的竖线 */
const cell = v => String(v).replace(/\|/g, '\\|');

const KIND_ZH = {
  standard: '标准',
  wild: 'Wild',
  scatter: 'Scatter',
  bonus: 'Bonus',
  jackpot: 'Jackpot',
};

/** 各特性的可读化渲染；未覆盖的特性回落到紧凑 JSON */
const FEATURES = {
  free_spins: f =>
    `免费旋转：${f.trigger_symbol} 触发（${Object.entries(f.trigger_counts ?? {})
      .map(([n, s]) => `${n} 个 ${s} 次`)
      .join(' / ')}）` +
    (f.multiplier_progression?.length
      ? `，倍率递进 ${f.multiplier_progression.join('→')}×`
      : '') +
    (f.retrigger_counts ? `，可再触发（${Object.entries(f.retrigger_counts).map(([n, s]) => `${n} 个 +${s} 次`).join(' / ')}）` : '') +
    (f.sticky_wild_reels?.length ? `，粘 Wild 轴 ${f.sticky_wild_reels.join('、')}` : '') +
    (f.reel_set ? `，使用转轮组 ${f.reel_set}` : ''),
  hold_win: f =>
    `Hold & Win：${f.trigger_count} 个 ${f.trigger_symbol} 触发，${f.respins} 次重转` +
    (f.jackpots ? `；奖池 ${Object.entries(f.jackpots).map(([k, v]) => `${k} ${num(v)}×`).join('、')}` : '') +
    (f.full_grid_bonus ? `；满盘额外 ${num(f.full_grid_bonus)}×` : '') +
    (f.hit_probability ? `，触发概率 ${pct(f.hit_probability)}` : ''),
  cascade: f =>
    `级联连击：倍率步进 ${num(f.multiplier_step)}，上限 ${num(f.multiplier_cap)}×` +
    (f.reset_each_free_spin ? '，每次免费旋转重置' : ''),
  expanding_wild: f =>
    `扩展 Wild：${f.symbol} 在第 ${(f.reels ?? []).map(i => Number(i) + 1).join('、')} 轴展开` +
    (f.respins ? `，触发 ${f.respins} 次 respin` : ''),
  gamble: f =>
    `红黑翻倍：最多连猜 ${f.max_steps} 次，单次上限 ${num(f.max_win_multiplier)}×，胜率 ${pct(f.win_probability)}`,
  random_wild: f =>
    `随机 Wild：${f.symbol} 每局投放数量分布 ${Object.entries(f.counts ?? {})
      .map(([n, w]) => `${n} 个 ${w}%`)
      .join(' / ')}`,
  collect: f =>
    `Cash Collect：${f.collector} 出现时收集 ${(f.coin_symbols ?? []).join('、')}` +
    (f.free_award_multiplier ? `；免费旋转内倍率 ${num(f.free_award_multiplier)}×` : '') +
    (f.jackpot_symbol && f.jackpot_value ? `；${f.jackpot_symbol} 对应 ${num(f.jackpot_value)}×` : ''),
  multiplier_wild: f =>
    `倍率 Wild：${Object.entries(f.symbols ?? {}).map(([k, v]) => `${k} ×${num(v)}`).join('、')}，合并方式 ${f.combine}`,
  pick_bonus: f =>
    `Pick'em 选宝：${f.trigger_symbol} 触发（${Object.entries(f.trigger_counts ?? {})
      .map(([n, p]) => `${n} 个选 ${p} 次`)
      .join(' / ')}）` +
    (f.prize_pool ? `；奖项 ${Object.entries(f.prize_pool).map(([k, v]) => `${k} ${num(v)}×`).join('、')}` : ''),
  colossal: f =>
    `巨符号：覆盖轴 ${(f.reels ?? []).map(i => `第 ${Number(i) + 1} 轴`).join('、')}` +
    (f.size_weights ? `，尺寸分布 ${Object.entries(f.size_weights).map(([k, w]) => `${k} 格 ${w}%`).join(' / ')}` : ''),
  mystery: f =>
    `神秘符号：${f.symbol} 揭示为 ${Object.entries(f.reveal_symbols ?? {})
      .map(([k, w]) => `${k} ${w}%`)
      .join(' / ')}${f.reveal_all_same ? '，整屏揭示为同一符号' : ''}`,
  walking_wild: f =>
    `行走 Wild：${f.symbol} 每局向${f.direction === 'left' ? '左' : '右'}移动 ${f.steps_per_spin} 格` +
    (f.max_walkers ? `，最多 ${f.max_walkers} 个` : ''),
  sync_reels: f =>
    `同步轴：宽度分布 ${Object.entries(f.widths ?? {})
      .map(([w, p]) => `${w} 轴 ${p}%`)
      .join(' / ')}，复制自 ${f.copy_from}`,
  symbol_upgrade: f =>
    `符号升级：${Object.entries(f.ladder ?? {})
      .map(([a, b]) => `${a} → ${b}`)
      .join(' → ')}${f.require_cascade ? '，需级联触发' : ''}`,
  jackpot: f =>
    `累积奖池（${f.mode}）：${(f.levels ?? [])
      .map(l => `${l.name} ${num(l.amount)}`)
      .join('、')}；命中率 ${pct(f.hit_chance ?? 0)}，贡献率 ${pct(f.contribution_rate ?? 0)}`,
};

const out = [];
out.push(`# ${data.meta?.site_name ?? 'SLOT 游戏合集'} — 完整数据（llms-full.txt）`);
out.push('');
out.push(`> 索引版见 ${siteUrl}/llms.txt。本文件包含每款机台的完整赔付表与特性参数，供精确引用。`);
out.push('');
out.push('数值口径：赔付为「线注倍数」，实得金额 = 赔付 × 单线注额。Scatter 按全盘个数赔付，单位与总注挂钩。');
out.push(`数据来源：data/games.json（与页面正文同源，引擎 ${data.meta?.engine ?? 'SlotEngine.js'}）`);
out.push('');

for (const g of data.games) {
  const url = `${siteUrl}/games/${g.id}.html`;
  const symbols = Object.values(g.symbols ?? {});
  const counts = Array.from({ length: Math.max(0, g.reels - 2) }, (_, i) => i + 3);
  const ways = g.pay_mode === 'ways' ? Math.pow(g.rows, g.reels) : null;

  out.push(`## ${g.name}（${g.id}）`);
  out.push('');
  out.push(`- 页面：${url}`);
  out.push(
    `- 规格：${g.reels} 轴 × ${g.rows} 行，` +
      (ways ? `${ways} Ways（相邻轴通路）` : `${g.paylines?.lines?.length ?? 0} 条固定赔付线`) +
      `，符号 ${symbols.length} 种`
  );
  out.push(
    `- 数学：目标 RTP ${pct(g.math?.target_rtp ?? 0)}（容差 ±${pct(g.math?.rtp_tolerance ?? 0)}）` +
      `，波动 ${g.math?.volatility ?? '—'}` +
      (g.math?.max_win_multiplier ? `，最高单局 ${num(g.math.max_win_multiplier)}×` : '') +
      (g.math?.hit_frequency_target ? `，命中率目标 ${pct(g.math.hit_frequency_target)}` : '')
  );
  out.push(
    `- 投注档位：${(g.bet?.steps ?? []).join(' / ')}` +
      (g.bet?.max_total_bet ? `（总注上限 ${num(g.bet.max_total_bet)}）` : '')
  );
  const sets = Object.keys(g.reel_sets ?? {});
  out.push(
    sets.length > 1
      ? `- 转轮组：${sets.join(' / ')}（基础组 ${g.base_reel_set}）`
      : `- 转轮组：仅 ${sets.join('') || g.base_reel_set} 一组`
  );
  if (g.description) out.push(`- 简介：${g.description}`);
  out.push('');

  out.push('### 赔付表（线注倍数）');
  out.push('');
  out.push(`| 符号 | 类型 | ${counts.map(n => `${n} 连`).join(' | ')} |`);
  out.push(`| --- | --- | ${counts.map(() => '---').join(' | ')} |`);
  for (const s of symbols) {
    const cells = counts.map(n => {
      const v = s.pays?.[String(n)];
      return v === undefined ? '—' : num(v);
    });
    out.push(`| ${cell(s.name)}（${s.id}） | ${KIND_ZH[s.kind] ?? s.kind} | ${cells.join(' | ')} |`);
  }
  out.push('');

  const scatterPay = symbols.find(
    s => s.kind === 'scatter' && s.scatter_pays && Object.keys(s.scatter_pays).length > 0
  );
  if (scatterPay) {
    out.push(
      `Scatter 全盘赔付（${scatterPay.name}）：` +
        Object.entries(scatterPay.scatter_pays)
          .map(([n, v]) => `${n} 个 ${num(v)}× 总注`)
          .join('；')
    );
    out.push('');
  }

  out.push('### 特性参数');
  out.push('');
  let any = false;
  for (const [key, value] of Object.entries(g.features ?? {})) {
    if (!value) continue;
    if (value && typeof value === 'object' && 'enabled' in value && !value.enabled) continue;
    const fmt = FEATURES[key];
    out.push(`- ${fmt ? fmt(value) : `${key}：${JSON.stringify(value)}`}`);
    any = true;
  }
  if (!any) out.push('- 无附加特性（基础线注玩法）');
  out.push('');
  out.push(`配置源：data/games.json → games[${g.id}]`);
  out.push('');
}

out.push('## 免责声明');
out.push('');
out.push('娱乐演示用途，使用虚拟积分，不涉及真钱、无法币兑换、不提供充值或提现。RTP 为长期理论值，短期结果随机。未满 18 岁请勿使用。');
out.push('');

const text = out.join('\n');
writeFileSync(resolve(ROOT, 'llms-full.txt'), text, 'utf8');
console.log(`llms-full.txt: ${data.games.length} 款机台，${text.length} 字符，约 ${Math.round(text.length / 1024)}KB`);
