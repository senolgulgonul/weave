#!/usr/bin/env node
// nlcompare: compare TWO NETLISTS for connectivity equivalence and parameter
// fidelity. Built for the Integration revision: after LTspice batch-extracts a
// netlist from every Weave-generated .asc (XVIIx64.exe -netlist), this tool
// checks that LTspice's own parser derives the same net partition and the same
// element values from the schematic as the original input netlist.
//
// Names of signal nets are ignored (LTspice renames them N001, N002, ...);
// partitions are compared by their (component, pin) membership signatures.
// Ground and named rail flags must agree by name, same rule as verify.js.
//
// Usage:
//   node nlcompare_20260819_1200.js <original.net> <ltspice.net>
//   node nlcompare_20260819_1200.js --batch <origdir> <ltdir> <results.csv>
//     (pairs files by basename: <origdir>/x.net vs <ltdir>/x.net)
//
// CSV columns: file, connectivity, diff_nets, params, param_mismatches, detail

'use strict';
const fs = require('fs');
const path = require('path');
const { parseNetlist, classifyNets, railLabel } = require('./core.js');

// LTspice netlister artifact normalization on the extracted side:
// A1x: X cards can carry the model name twice (symbol slot + instance slot);
// drop the duplicate so it is not mis-split into a phantom pin.
function normLTText(text){
  return text.split(/\r?\n/).map(ln=>{
    const t = ln.trim().split(/\s+/);
    if (/^X/i.test(t[0]||'') && t.length>=4){
      // trailing duplicate: "... NAME NAME"
      const a=t[t.length-1], b=t[t.length-2];
      if (a && b && !a.includes('=') && a.toLowerCase()===b.toLowerCase())
        return t.slice(0,-1).join(' ');
      // head duplicate before the first param: "... NAME NAME p=1 ..."
      const pi = t.findIndex(x=>x.includes('='));
      if (pi>3 && !t[pi-1].includes('=') && !t[pi-2].includes('=') &&
          t[pi-1].toLowerCase()===t[pi-2].toLowerCase()){
        const u=t.slice(); u.splice(pi-1,1); return u.join(' ');
      }
    }
    return ln;
  }).join('\n');
}

function readText(p) {
  const b = fs.readFileSync(p);
  if (b[0] === 0xFF && b[1] === 0xFE) return b.toString('utf16le');
  if (b.length > 1 && b[1] === 0x00) return b.toString('utf16le');
  return b.toString('latin1');
}

// canonical component name: LTspice's netlister prepends the X prefix to the
// InstName when re-extracting, so Weave's XU1 comes back as XXU1. Fold leading
// X runs to a single X and uppercase, on BOTH sides, so pins pair correctly.
function canonName(name) {
  let n = String(name).toUpperCase();
  if (n[0] === 'X') n = 'X' + n.replace(/^X+/, '');
  return n;
}

// same partition semantics as verify.js netlistPartition, with canonical
// component names and case-insensitive flag labels
function partition(text) {
  const { comps } = parseNetlist(text);
  const cls = classifyNets(comps);
  const nets = new Map();
  for (const c of comps) c.nets.forEach((n, i) => {
    const t = cls.get(n);
    const nk = t === 'gnd' ? 'FLAG:0'
             : t === 'rail' ? 'FLAG:' + String(railLabel(n, comps)).toUpperCase()
             : 'NET:' + n;
    if (!nets.has(nk)) nets.set(nk, new Set());
    nets.get(nk).add(canonName(c.name) + ':' + i);
  });
  return { nets, comps };
}

function compareNetlists(origText, ltText) {
  const A = partition(origText), B = partition(ltText);
  const sig = s => [...s].sort().join('|');
  const errs = [];
  const mapB = new Map([...B.nets.entries()].map(([k, v]) => [sig(v), k]));
  for (const [nk, pins] of A.nets) {
    if (pins.size < 1) continue;
    const hit = mapB.get(sig(pins));
    if (hit === undefined) { errs.push('missing net ' + nk + ' [' + [...pins].join(' ') + ']'); continue; }
    if (nk.startsWith('FLAG:') && hit !== nk &&
        !/^FLAG:NC_/i.test(nk) && !/^FLAG:NC_/i.test(hit))   // no-connect numbering order is netlister-arbitrary
      errs.push('flag name mismatch ' + nk + ' vs ' + hit);
  }
  const mapA = new Map([...A.nets.values()].map(v => [sig(v), 1]));
  for (const [nk, pins] of B.nets)
    if (!mapA.get(sig(pins))) errs.push('extra net ' + nk + ' [' + [...pins].join(' ') + ']');

  // parameter fidelity: value string per component name, whitespace-normalized,
  // case-insensitive (LTspice may re-case units). Mismatches are LOGGED, not
  // failed: inspect them, some may be benign canonicalization.
  const norm = v => String(v || '').trim().replace(/\s+/g, ' ').toLowerCase();
  // benign LTspice re-emission artifacts: symbols that carry the model name in
  // both the Value and a model attribute re-emit it twice ("SRFLOP SRFLOP")
  const sameVal = (a, b) => {
    a = norm(a); b = norm(b);
    if (a === b) return true;
    // A1: whole value re-emitted twice (model name in Value and model attr)
    if (b === a + ' ' + a || a === b + ' ' + b) return true;
    // A2: parameter tail re-emitted twice (params held in a second attribute):
    // "opamp Aol=.. GBW=.." -> "opamp Aol=.. GBW=.. Aol=.. GBW=.."
    const tail = s => s.split(' ').slice(1).join(' ');
    if (tail(a) && b === a + ' ' + tail(a)) return true;
    if (tail(b) && a === b + ' ' + tail(b)) return true;
    // A2-fixpoint: the extracted card may repeat the parameter tail more than
    // once (one repetition per overridden slot); strip repeated identical
    // trailing tails until fixpoint before the remaining rules
    {
      const t = a.split(' ').slice(1).join(' ');
      if (t){ let bb = b; const suf = ' ' + t;
        while (bb.endsWith(suf) && bb.length > a.length) bb = bb.slice(0, -suf.length);
        if (bb === a) return true; }
      const t2 = b.split(' ').slice(1).join(' ');
      if (t2){ let aa = a; const suf2 = ' ' + t2;
        while (aa.endsWith(suf2) && aa.length > b.length) aa = aa.slice(0, -suf2.length);
        if (aa === b) return true; }
    }
    // A4: leading token re-emitted twice ("BUF td=..." -> "BUF BUF td=...")
    const first = s => s.split(' ')[0] || '';
    if (b === first(a) + ' ' + a || a === first(b) + ' ' + b) return true;
    // A3: empty source value re-emitted as the default device letter (V/I)
    if ((a === '' && (b === 'v' || b === 'i')) || (b === '' && (a === 'v' || a === 'i'))) return true;
    return false;
  };
  const byName = new Map(B.comps.map(c => [canonName(c.name), c]));
  const pmis = [];
  for (const c of A.comps) {
    const d = byName.get(canonName(c.name));
    if (!d) { pmis.push(c.name + ': absent in LTspice netlist'); continue; }
    if (!sameVal(c.value, d.value))
      pmis.push(`${c.name}: "${c.value}" vs "${d.value}"`);
  }
  return { errs, pmis };
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--batch') {
    const [, origdir, ltdir, csvPath] = args;
    if (!origdir || !ltdir || !csvPath) return usage();
    const files = fs.readdirSync(origdir).filter(f => f.endsWith('.net')).sort();
    const rows = ['file,connectivity,diff_nets,params,param_mismatches,detail'];
    let conn = 0, par = 0, missing = 0;
    for (const f of files) {
      const ltPath = path.join(ltdir, f);
      if (!fs.existsSync(ltPath)) {
        rows.push(`${f},NO_LT_NETLIST,,,,"LTspice netlist absent (compile failed?)"`);
        missing++; continue;
      }
      try {
        const { errs, pmis } = compareNetlists(readText(path.join(origdir, f)), normLTText(readText(ltPath)));
        if (!errs.length) conn++;
        if (!pmis.length) par++;
        const detail = (errs[0] || pmis[0] || '').replace(/"/g, "'").slice(0, 100);
        rows.push(`${f},${errs.length ? 'DIFF' : 'MATCH'},${errs.length},${pmis.length ? 'DIFF' : 'MATCH'},${pmis.length},"${detail}"`);
      } catch (e) {
        rows.push(`${f},ERROR,,,,"${String(e.message || e).replace(/"/g, "'").slice(0, 100)}"`);
      }
    }
    fs.writeFileSync(csvPath, rows.join('\n') + '\n');
    const N = files.length;
    console.error(`=== ${N} pairs ===`);
    console.error(`connectivity MATCH : ${conn} (${(100 * conn / N).toFixed(1)}%)`);
    console.error(`parameter MATCH    : ${par} (${(100 * par / N).toFixed(1)}%)`);
    console.error(`LTspice netlist absent: ${missing}`);
    console.error(`csv: ${csvPath}`);
  } else {
    const [a, b] = args;
    if (!a || !b) return usage();
    const { errs, pmis } = compareNetlists(readText(a), normLTText(readText(b)));
    if (!errs.length) console.log('CONNECTIVITY MATCH');
    else { console.log(`CONNECTIVITY DIFF: ${errs.length} net(s)`); errs.slice(0, 12).forEach(e => console.log('  ' + e)); }
    if (!pmis.length) console.log('PARAMETERS MATCH');
    else { console.log(`PARAMETER DIFF: ${pmis.length} component(s)`); pmis.slice(0, 12).forEach(e => console.log('  ' + e)); }
    if (errs.length) process.exitCode = 1;
  }
}

function usage() {
  console.error('usage:\n  node nlcompare_20260819_1200.js <original.net> <ltspice.net>\n  node nlcompare_20260819_1200.js --batch <origdir> <ltdir> <results.csv>');
  process.exitCode = 1;
}

main();
