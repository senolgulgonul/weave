# Weave

Weave turns a SPICE netlist into an LTspice schematic (`.asc`). It runs entirely in your browser, has no dependencies, and ships as a single HTML file. Paste a netlist, and Weave places the symbols, routes the wires, and hands you a `.asc` you can open directly in LTspice.

Live tool: [senolgulgonul.github.io/weave](https://senolgulgonul.github.io/weave)

## Why

LTspice reads and writes netlists, but going the other way, from a bare netlist back to a drawable schematic, is not something it does. If you have a netlist from a textbook, a generated circuit, a colleague, or an old project whose `.asc` was lost, you normally have to place every part and draw every wire by hand. Weave does that first pass for you. The result is a real schematic you can inspect, tidy, and simulate, not a picture.

## How it works

The pipeline is short and each stage has one job. The netlist is parsed into components and nets. Nets are classified as ground, supply rail, or signal. Signal components become nodes in a graph that [elkjs](https://github.com/kieler/elkjs) lays out with its layered (Sugiyama) algorithm, giving left-to-right signal flow and orthogonal wire routing. Feedback loops, divider legs, hanging shunts, and supply corners are handled as placement patterns rather than graph nodes, which keeps the main signal chain clean. Everything snaps to LTspice's 16-unit grid, and the `.asc` is emitted with the correct symbol names, rotations, and pin coordinates.

The part that makes Weave trustworthy is the **round-trip verifier**. After generating the `.asc`, Weave parses its own output back into a netlist and compares the connectivity, net by net, against the original. If every net matches, you get a green badge. If some nets differ, you get an honest count of how many need attention. The schematic is always downloadable either way, because a schematic that is 90% correct is a far better starting point than a blank sheet.

## Symbol library

Weave embeds a pin table for **5093 LTspice symbols** (op-amps, references, comparators, power products, switches, optocouplers, digital blocks, and the standard passives and sources), so most parts resolve by name with no setup. The table stores only what layout needs: pin offsets and SpiceOrder. When a netlist calls a part whose exact `.asy` pin count differs, or a part the table does not know, Weave falls back to a generic rectangular block so the connectivity is still preserved and the schematic still opens.

## Supported netlist elements

Resistors, capacitors, inductors, voltage and current sources, diodes; BJTs and MOSFETs (`Q`, `M`, including LTspice's substrate-appended 4-node export); JFETs (`J`); subcircuits (`X`, with parameter tails); dependent sources (`E`, `G`, `F`, `H`); behavioral sources (`B`); switches (`S`, `W`); transmission lines (`T`); coupling and special-function devices (`K`, `A`). SPICE `+` line continuations are joined automatically.

## Safe-mode ladder

Simple circuits lay out perfectly with all placement patterns active. Dense or unusual ones sometimes do not. Rather than fail, Weave climbs a ladder of progressively simpler layout modes, switching patterns off one by one down to pure elkjs, and keeps the first result the verifier accepts. Correctness is guaranteed at every rung by the verifier, so a safe-mode result is never wrong, only plainer.

## Usage

Open the HTML file in any modern browser. Pick one of the built-in examples (inverting amp, instrumentation amp, shunt reference, Sallen-Key, common-emitter amp, difference amp, and more) or paste your own netlist. The badge tells you the connectivity status; the button downloads a timestamped `.asc`. Open it in LTspice and simulate.

Nothing is uploaded anywhere. The entire tool, including the symbol library and the layout engine, runs locally in the page.

## Command line

For batch conversion and to reproduce the benchmarks, see [`cli/`](cli/), a Node.js
tool that runs the same conversion engine. It converts a whole folder of netlists at
once and verifies each result:

    node weave.js batch ./netlists results.tsv

See [`cli/README.md`](cli/README.md) for setup and [`cli/BENCHMARK.md`](cli/BENCHMARK.md)
for the head-to-head comparison against Schemato on the Circuits-LTSpice test set.

## Known limits

Very dense multi-pin power modules (large `LTM`/`LTC` regulators with many repeated nets) are the one class Weave does not yet lay out cleanly; these produce a partial result that needs manual fixup. Text labels can occasionally overlap a nearby wire in the drawing; this is cosmetic, does not affect connectivity, and is a one-drag fix in LTspice. Parts newer than your installed LTspice version will not be in the symbol table.

## License

elkjs is bundled under the Eclipse Public License. Weave's own code is released under the MIT License.
