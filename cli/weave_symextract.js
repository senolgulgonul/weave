#!/usr/bin/env node
// weave_symextract: build the Weave symbol table v2 from an installed LTspice
// symbol library. This is the maintenance artifact promised for the revision
// (users regenerate the table against their own library) and the data source
// for slot-aware attribute emission.
//
// Records per .asy symbol:
//   pins  : [x,y] offsets, ordered by SpiceOrder
//   ord   : SpiceOrder indices (post-sort, ascending; kept for compatibility)
//   bbox  : [x0,y0,x1,y1] over all drawing primitives and pins
//   attrs : declared SYMATTR slots (Prefix, SpiceModel, Value, Value2,
//           SpiceLine, SpiceLine2, ModelFile, Description) verbatim
//
// Usage:
//   node weave_symextract_20260819_1030.js D:\LTspice\lib\sym symbols2.json
//   node weave_symextract_20260819_1030.js D:\LTspice\lib\sym symbols2.json --diff symbols.json
//
// The optional --diff against the old table prints added/removed symbols and
// pin-order changes, i.e. the exact library-version skew for the paper.

'use strict';
const fs = require('fs');
const path = require('path');

function readText(p) {
  const b = fs.readFileSync(p);
  if (b[0] === 0xFF && b[1] === 0xFE) return b.toString('utf16le');
  if (b.length > 1 && b[1] === 0x00) return b.toString('utf16le');
  return b.toString('latin1');
}

function parseAsy(text) {
  const pinsRaw = [];   // {x,y,order}
  const attrs = {};
  let cur = null;
  let bb = null;
  const grow = (x, y) => {
    if (!isFinite(x) || !isFinite(y)) return;
    if (!bb) bb = [x, y, x, y];
    else { bb[0]=Math.min(bb[0],x); bb[1]=Math.min(bb[1],y); bb[2]=Math.max(bb[2],x); bb[3]=Math.max(bb[3],y); }
  };
  for (const raw of text.split(/\r?\n/)) {
    const ln = raw.trim();
    if (!ln) continue;
    const t = ln.split(/\s+/);
    const kw = t[0].toUpperCase();
    if (kw === 'PIN') {
      cur = { x: +t[1], y: +t[2], order: pinsRaw.length + 1 };
      pinsRaw.push(cur);
      grow(cur.x, cur.y);
    } else if (kw === 'PINATTR' && cur) {
      if (t[1] === 'SpiceOrder') cur.order = +t[2];
    } else if (kw === 'SYMATTR') {
      const slot = t[1];
      const val = ln.slice(ln.indexOf(slot) + slot.length).trim();
      if (['Prefix','SpiceModel','Value','Value2','SpiceLine','SpiceLine2','ModelFile','Description'].includes(slot))
        attrs[slot] = val;
    } else if (['LINE','RECTANGLE','CIRCLE'].includes(kw)) {
      // LINE Normal x1 y1 x2 y2 [style] / RECTANGLE Normal x1 y1 x2 y2 / CIRCLE Normal x1 y1 x2 y2
      grow(+t[2], +t[3]); grow(+t[4], +t[5]);
    } else if (kw === 'ARC') {
      // ARC Normal x1 y1 x2 y2 x3 y3 x4 y4 : bounding box of defining rect
      grow(+t[2], +t[3]); grow(+t[4], +t[5]);
    }
  }
  if (!pinsRaw.length) return null;
  pinsRaw.sort((a, b) => a.order - b.order);
  const pins = pinsRaw.map(p => [p.x, p.y]);
  const ord = pinsRaw.map((p, i) => i + 1);
  if (!bb) bb = [0, 0, 0, 0];
  return { pins, ord, bbox: bb, attrs };
}

function walk(dir, base, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else if (e.isFile() && /\.asy$/i.test(e.name)) {
      const rel = path.relative(base, p).replace(/\.asy$/i, '').split(path.sep).join('\\');
      try {
        const s = parseAsy(readText(p));
        if (s) out[rel] = s;
      } catch (err) {
        console.error('  parse error:', rel, String(err.message).slice(0, 60));
      }
    }
  }
}

function main() {
  const [libdir, outfile, flag, oldfile] = process.argv.slice(2);
  if (!libdir || !outfile) {
    console.error('usage: node weave_symextract_20260819_1030.js <lib\\sym dir> <out.json> [--diff old.json]');
    process.exit(1);
  }
  const out = {};
  walk(libdir, libdir, out);
  const n = Object.keys(out).length;
  let slotStats = {};
  for (const k in out)
    for (const s in out[k].attrs)
      slotStats[s] = (slotStats[s] || 0) + 1;
  fs.writeFileSync(outfile, JSON.stringify(out));
  console.error(`extracted ${n} symbols -> ${outfile}`);
  console.error('slot usage:', JSON.stringify(slotStats));

  if (flag === '--diff' && oldfile) {
    const old = JSON.parse(fs.readFileSync(oldfile, 'latin1'));
    const ok = new Set(Object.keys(old)), nk = new Set(Object.keys(out));
    const added = [...nk].filter(k => !ok.has(k));
    const removed = [...ok].filter(k => !nk.has(k));
    const pinChanged = [];
    for (const k of nk) {
      if (!ok.has(k)) continue;
      const a = JSON.stringify(old[k].pins), b = JSON.stringify(out[k].pins);
      if (a !== b) pinChanged.push(k);
    }
    console.error(`\n=== library skew vs ${oldfile} ===`);
    console.error(`added   : ${added.length}`);
    console.error(`removed : ${removed.length}`);
    console.error(`pins/order changed: ${pinChanged.length}`);
    for (const k of removed.slice(0, 20)) console.error('  removed:', k);
    for (const k of pinChanged.slice(0, 20)) console.error('  changed:', k);
    fs.writeFileSync(outfile.replace(/\.json$/, '_skew.txt'),
      ['ADDED', ...added, '', 'REMOVED', ...removed, '', 'PIN_CHANGED', ...pinChanged].join('\n'));
    console.error(`full lists -> ${outfile.replace(/\.json$/, '_skew.txt')}`);
  }
}

main();
