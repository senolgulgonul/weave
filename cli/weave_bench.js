#!/usr/bin/env node
// weave_bench: instrumented benchmark runner for the Integration revision.
// For every .net in a folder, converts with a chosen mode policy, verifies,
// times every rung, computes aesthetic metrics from the emitted .asc, counts
// generic-block fallbacks, and writes one CSV row per circuit. Also saves the
// final .asc of each circuit so LTspice batch compilation can run on them.
//
// Usage:
//   node weave_bench_20260818_1720.js <netdir> <outdir> <results.csv> [--modes all|0|N|N,M,...]
//
//   --modes all    full safe-mode ladder (default)      -> main results
//   --modes 0      rung 0 only, no ladder               -> ladder ablation
//   --modes 5      pure layout, no patterns             -> ELK-only baseline
//
// CSV columns:
//   file, policy, outcome, diff_nets, mode, rungs_tried, ms_total, ms_rung0,
//   elements, max_pins, max_net_degree, n_fallback_syms, crossings, bends,
//   wire_length, n_wires
//
// Aesthetic metric definitions follow the paper (Section 4.2):
//   crossing   = proper interior-interior intersection of two wire segments
//   bend       = point where exactly TWO wire endpoints meet with a change
//                of direction (T-junctions of 3+ ends are not bends)
//   wirelength = sum of segment lengths in grid units
// Cross-check these against the paper's aesthetic-metrics tool on a few
// circuits before regenerating Table 3, so definitions provably agree.

'use strict';
const fs = require('fs');
const path = require('path');
const { convert, parseNetlist, SAFE_MODES, blockAsyFiles } = require('./core.js');
const { compare } = require('./verify.js');

function readText(p) {
  const b = fs.readFileSync(p);
  if (b[0] === 0xFF && b[1] === 0xFE) return b.toString('utf16le');
  if (b.length > 1 && b[1] === 0x00) return b.toString('utf16le');
  return b.toString('latin1');
}

// ---------- aesthetic metrics from WIRE records ----------
function parseWires(asc) {
  const wires = [];
  for (const ln of asc.split(/\r?\n/)) {
    const t = ln.trim().split(/\s+/);
    if (t[0] === 'WIRE') {
      const w = t.slice(1, 5).map(Number);
      if (w[0] !== w[2] || w[1] !== w[3]) wires.push(w); // drop zero-length
    }
  }
  return wires;
}

function segLen([x1, y1, x2, y2]) { return Math.hypot(x2 - x1, y2 - y1); }

// proper interior-interior intersection of two segments (general position)
function properCross(a, b) {
  const [ax1, ay1, ax2, ay2] = a, [bx1, by1, bx2, by2] = b;
  const d = (ax2 - ax1) * (by2 - by1) - (ay2 - ay1) * (bx2 - bx1);
  if (d === 0) return false; // parallel or collinear: overlap is not a crossing
  const t = ((bx1 - ax1) * (by2 - by1) - (by1 - ay1) * (bx2 - bx1)) / d;
  const u = ((bx1 - ax1) * (ay2 - ay1) - (by1 - ay1) * (ax2 - ax1)) / d;
  const eps = 1e-9;
  return t > eps && t < 1 - eps && u > eps && u < 1 - eps;
}

function metrics(asc) {
  const wires = parseWires(asc);
  let crossings = 0, wlen = 0;
  for (let i = 0; i < wires.length; i++) {
    wlen += segLen(wires[i]);
    for (let j = i + 1; j < wires.length; j++)
      if (properCross(wires[i], wires[j])) crossings++;
  }
  // bends: endpoints grouped by coordinate
  const ends = new Map(); // "x,y" -> [wire indices]
  for (let i = 0; i < wires.length; i++) {
    for (const p of [[wires[i][0], wires[i][1]], [wires[i][2], wires[i][3]]]) {
      const k = p[0] + ',' + p[1];
      if (!ends.has(k)) ends.set(k, []);
      ends.get(k).push(i);
    }
  }
  let bends = 0;
  for (const [, idx] of ends) {
    if (idx.length !== 2) continue;
    const [a, b] = idx.map(i => wires[i]);
    const da = [Math.sign(a[2] - a[0]), Math.sign(a[3] - a[1])];
    const db = [Math.sign(b[2] - b[0]), Math.sign(b[3] - b[1])];
    // collinear continuation is not a bend; direction change is
    const collinear = (da[0] === db[0] && da[1] === db[1]) ||
                      (da[0] === -db[0] && da[1] === -db[1]);
    if (!collinear) bends++;
  }
  return { crossings, bends, wire_length: Math.round(wlen), n_wires: wires.length };
}

// ---------- circuit structure stats from the input netlist ----------
function netlistStats(nl) {
  let comps;
  try { comps = parseNetlist(nl).comps; } catch { return { elements: '', max_pins: '', max_net_degree: '' }; }
  const deg = new Map();
  let maxPins = 0;
  for (const c of comps) {
    maxPins = Math.max(maxPins, c.nets.length);
    for (const n of c.nets) deg.set(n, (deg.get(n) || 0) + 1);
  }
  const maxDeg = Math.max(0, ...deg.values());
  return { elements: comps.length, max_pins: maxPins, max_net_degree: maxDeg };
}

function countFallbacks(asc) {
  let n = 0;
  for (const ln of asc.split(/\r?\n/))
    if (/^SYMBOL\s+__block\d+\s/.test(ln.trim())) n++;
  return n;
}

// ---------- instrumented conversion ----------
async function convertWithPolicy(nl, modeIdx) {
  const t0 = process.hrtime.bigint();
  let best = null, bestErrs = null, bestMode = -1, msRung0 = null, tried = 0;
  for (const m of modeIdx) {
    tried++;
    const asc = await convert(nl, SAFE_MODES[m]);
    const errs = compare(nl, asc);
    if (msRung0 === null)
      msRung0 = Number(process.hrtime.bigint() - t0) / 1e6;
    if (best === null || errs.length < bestErrs.length) { best = asc; bestErrs = errs; bestMode = m; }
    if (!errs.length) break;
  }
  const msTotal = Number(process.hrtime.bigint() - t0) / 1e6;
  return { asc: best, errs: bestErrs, mode: bestMode, tried, msTotal, msRung0 };
}

async function main() {
  const args = process.argv.slice(2);
  const flagIdx = args.indexOf('--modes');
  let policy = 'all';
  if (flagIdx >= 0) { policy = args[flagIdx + 1]; args.splice(flagIdx, 2); }
  const [netdir, outdir, csvPath] = args;
  if (!netdir || !outdir || !csvPath) {
    console.error('usage: node weave_bench_20260818_1720.js <netdir> <outdir> <results.csv> [--modes all|0|5|N,M,...]');
    process.exit(1);
  }
  const modeIdx = policy === 'all'
    ? SAFE_MODES.map((_, i) => i)
    : policy.split(',').map(Number);
  fs.mkdirSync(outdir, { recursive: true });

  const files = fs.readdirSync(netdir).filter(f => f.endsWith('.net')).sort();
  const header = ['file', 'policy', 'outcome', 'diff_nets', 'mode', 'rungs_tried',
    'ms_total', 'ms_rung0', 'elements', 'max_pins', 'max_net_degree',
    'n_fallback_syms', 'crossings', 'bends', 'wire_length', 'n_wires'];
  const rows = [header.join(',')];
  let matched = 0, partial = 0, errored = 0;
  let peakRss = 0; // v1.3.1: peak resident set, sampled after every circuit

  for (const f of files) {
    const nl = readText(path.join(netdir, f));
    const stats = netlistStats(nl);
    const base = f.replace(/\.net$/, '');
    let row;
    try {
      const r = await convertWithPolicy(nl, modeIdx);
      const outcome = r.errs.length ? 'PARTIAL' : 'MATCH';
      if (outcome === 'MATCH') matched++; else partial++;
      fs.writeFileSync(path.join(outdir, base + '.asc'), Buffer.from(r.asc, 'latin1'));
      // companion .asy for any synthetic blocks, so the .asc opens in LTspice
      const asys = blockAsyFiles(r.asc);
      for (const [fn, body] of Object.entries(asys))
        fs.writeFileSync(path.join(outdir, fn), Buffer.from(body, 'latin1'));
      const m = metrics(r.asc);
      row = [f, policy, outcome, r.errs.length, r.mode, r.tried,
        r.msTotal.toFixed(1), r.msRung0.toFixed(1),
        stats.elements, stats.max_pins, stats.max_net_degree,
        countFallbacks(r.asc), m.crossings, m.bends, m.wire_length, m.n_wires];
    } catch (e) {
      errored++;
      row = [f, policy, 'ERROR', '', '', '', '', '',
        stats.elements, stats.max_pins, stats.max_net_degree,
        '', '', '', '', ''];
      row.push(); // keep column count
      console.error(`  ERROR ${f}: ${String(e.message || e).slice(0, 80)}`);
    }
    rows.push(row.join(','));
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }
  fs.writeFileSync(csvPath, rows.join('\n') + '\n');
  const N = files.length;
  console.error(`\n=== policy=${policy}  ${N} netlists ===`);
  console.error(`MATCH   : ${matched} (${(100 * matched / N).toFixed(1)}%)`);
  console.error(`PARTIAL : ${partial} (${(100 * partial / N).toFixed(1)}%)`);
  console.error(`ERROR   : ${errored} (${(100 * errored / N).toFixed(1)}%)`);
  console.error(`csv     : ${csvPath}`);
  console.error(`asc dir : ${outdir}`);
  console.error(`peakRSS : ${(peakRss / 1048576).toFixed(0)} MB (process RSS sampled after each circuit)`);
}

main();
