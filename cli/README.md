# weave-cli

Command-line companion to [weave](https://senolgulgonul.github.io/weave), a browser tool that converts a SPICE netlist into an LTspice schematic (`.asc`). The CLI runs the exact same conversion engine as the web app, plus a round-trip verifier, so you can convert circuits in bulk and check connectivity without clicking through the UI one at a time.

## What it does

Given a SPICE netlist, weave places the symbols, routes the wires with a layered (Sugiyama) graph layout, and writes an `.asc` you can open directly in LTspice. Every conversion is then verified: the generated `.asc` is parsed back into a netlist and its connectivity is compared, net for net, against the input. A reported `MATCH` means the schematic is provably connectivity-equivalent to the netlist it came from.

## Install

Node.js 18+ is required. Only one dependency, elkjs.

```
npm install
```

## Use

```
node weave.js convert <in.net> [out.asc]     convert one netlist
node weave.js verify  <in.net> <schem.asc>   check an .asc against a netlist
node weave.js batch   <dir> [results.tsv]    convert + verify every .net in a folder
```

Examples:

```
node weave.js convert op27.net op27.asc
node weave.js verify  op27.net op27.asc
node weave.js batch   ./netlists results.tsv
```

The safe-mode ladder runs automatically. If the default layout leaves a connectivity gap, weave retries with progressively simpler layout modes and keeps the first result the verifier accepts. Correctness is guaranteed at every rung, so a `MATCH` is always a true connectivity match, never a heuristic guess.

## Reproducing the Circuits-LTSpice benchmark

This reproduces the head-to-head comparison against Schemato (MLCAD 2025) on the identical public test set.

1. Clone the test circuits:

   ```
   git clone https://github.com/mick001/Circuits-LTSpice.git
   ```

2. Generate netlists from the `.asc` files using LTspice's own netlister (this is the same step Schemato used; it removes any dependence on weave's own extractor). On Windows PowerShell:

   ```powershell
   $exe = "C:\path\to\XVIIx64.exe"
   $src = "C:\path\to\Circuits-LTSpice"
   New-Item -ItemType Directory -Force -Path "$src\netlist" | Out-Null
   Get-ChildItem -Path $src -Recurse -Filter *.asc | ForEach-Object {
     $net = [System.IO.Path]::ChangeExtension($_.FullName, ".net")
     $p = Start-Process -FilePath $exe -ArgumentList "-netlist","`"$($_.FullName)`"" -PassThru
     if (-not $p.WaitForExit(15000)) { $p.Kill() }
     if (Test-Path $net) { Move-Item $net "$src\netlist" -Force }
   }
   ```

   Circuits whose symbols are missing from your LTspice install cannot be netlisted and are skipped, exactly as in the Schemato methodology. With LTspice XVII 17.0.36 this yields 117 netlists out of 131, matching the count reported by Schemato.

3. Run the benchmark:

   ```
   node weave.js batch "C:\path\to\Circuits-LTSpice\netlist" results.tsv
   ```

The summary line reports the compilation rate and the round-trip-verified MATCH rate. On the 117 real-LTspice netlists, weave reports 100% compilation and 100% connectivity, versus Schemato's 76% compilation and 0.35 GED similarity on the same set.

## How MATCH is defined

The verifier parses the generated `.asc` back into a connectivity graph (wires, flags, and symbol pins are unioned into nets by coordinate), then partitions both the generated and the original netlist into nets and compares the partitions. If they are identical, connectivity is preserved and the result is a MATCH. This is a binary, exact check, equivalent to a graph-edit-distance score of 1.0, not a similarity measure.

## Files

- `weave.js` — the CLI
- `core.js` — the conversion engine (parser, layout, `.asc` emitter, safe-mode ladder)
- `verify.js` — the round-trip connectivity verifier
- `symbols.json` — pin table for 5093 LTspice symbols (pin offsets + SpiceOrder)

## License

MIT. elkjs is bundled at install time under the Eclipse Public License.
