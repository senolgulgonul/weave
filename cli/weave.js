#!/usr/bin/env node
// weave-cli: SPICE netlist -> LTspice .asc, with round-trip connectivity verification.
// Same engine as the browser tool at senolgulgonul.github.io/weave.
//
// Usage:
//   node weave.js convert <in.net> [out.asc]     convert one netlist, print/write .asc
//   node weave.js verify  <in.net> <schem.asc>   check connectivity of an .asc vs a netlist
//   node weave.js batch   <dir> [results.tsv]    convert+verify every .net in a folder
//
// The safe-mode ladder is applied automatically: if the default layout leaves a
// connectivity gap, weave retries with progressively simpler modes and keeps the
// first result the round-trip verifier accepts. Correctness is guaranteed at every
// rung by the verifier, so a reported MATCH means the generated .asc re-parses to a
// netlist whose connectivity is identical to the input, net for net.

'use strict';
const fs = require('fs');
const path = require('path');
const { convert, SAFE_MODES } = require('./core.js');
const { compare } = require('./verify.js');

// encoding-robust read: LTspice -netlist output is often latin-1 / has CRLF
function readText(p) {
  const b = fs.readFileSync(p);
  if (b[0] === 0xFF && b[1] === 0xFE) return b.toString('utf16le');
  if (b.length > 1 && b[1] === 0x00) return b.toString('utf16le');
  return b.toString('latin1');
}

// convert one netlist, climbing the ladder; returns {asc, errs, mode}
async function convertBest(nl) {
  let best = null, bestErrs = null, bestMode = -1;
  for (let m = 0; m < SAFE_MODES.length; m++) {
    const asc = await convert(nl, SAFE_MODES[m]);
    const errs = compare(nl, asc);
    if (best === null) { best = asc; bestErrs = errs; bestMode = m; }
    if (!errs.length) return { asc, errs, mode: m };
    if (errs.length < bestErrs.length) { best = asc; bestErrs = errs; bestMode = m; }
  }
  return { asc: best, errs: bestErrs, mode: bestMode };
}

async function main() {
  const [cmd, a1, a2] = process.argv.slice(2);

  if (cmd === 'convert') {
    if (!a1) return usage();
    const nl = readText(a1);
    const { asc, errs, mode } = await convertBest(nl);
    if (a2) {
      fs.writeFileSync(a2, asc);
      const tag = errs.length ? `partial: ${errs.length} net(s) need manual fixup` : 'MATCH (round-trip verified)';
      console.error(`wrote ${a2} — ${tag} [mode ${mode}]`);
    } else {
      process.stdout.write(asc);
    }

  } else if (cmd === 'verify') {
    if (!a1 || !a2) return usage();
    const errs = compare(readText(a1), readText(a2));
    if (!errs.length) { console.log('MATCH — connectivity identical'); }
    else {
      console.log(`MISMATCH — ${errs.length} net(s) differ:`);
      errs.slice(0, 12).forEach(e => console.log('  ' + e));
      if (errs.length > 12) console.log(`  ...and ${errs.length - 12} more`);
      process.exitCode = 1;
    }

  } else if (cmd === 'batch') {
    if (!a1) return usage();
    const files = fs.readdirSync(a1).filter(f => f.endsWith('.net')).sort();
    const rows = [];
    let produced = 0, matched = 0;
    for (const f of files) {
      const nl = readText(path.join(a1, f));
      let verdict;
      try {
        const { errs, mode } = await convertBest(nl);
        produced++;
        if (!errs.length) { matched++; verdict = `MATCH\tmode${mode}`; }
        else verdict = `PARTIAL\t${errs.length} nets\t${errs[0].slice(0, 60)}`;
      } catch (e) {
        verdict = `ERROR\t${String(e.message || e).slice(0, 70).replace(/\s+/g, ' ')}`;
      }
      rows.push(f.replace(/\.net$/, '') + '\t' + verdict);
    }
    const tsv = rows.join('\n') + '\n';
    if (a2) fs.writeFileSync(a2, tsv); else process.stdout.write(tsv);
    const N = files.length;
    console.error(`\n=== ${N} netlists ===`);
    console.error(`produced .asc : ${produced} (${(100 * produced / N).toFixed(1)}%)`);
    console.error(`MATCH         : ${matched} (${(100 * matched / N).toFixed(1)}%)  [round-trip verified full connectivity]`);

  } else {
    usage();
  }
}

function usage() {
  console.error(`weave-cli — SPICE netlist to LTspice .asc, with round-trip verification

  node weave.js convert <in.net> [out.asc]     convert one netlist
  node weave.js verify  <in.net> <schem.asc>   check an .asc against a netlist
  node weave.js batch   <dir> [results.tsv]    convert+verify every .net in a folder

Reproduce the Circuits-LTSpice benchmark:
  1) generate netlists from the .asc files with LTspice:  XVIIx64.exe -netlist file.asc
  2) put the .net files in a folder, then:                node weave.js batch ./netlists out.tsv`);
  process.exitCode = 1;
}

main();
