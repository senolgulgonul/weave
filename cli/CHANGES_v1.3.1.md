# Weave v1.3.1 (CLI) / v4.1 (web): file-typed SpiceModel for .lib symbols

One-line emitter fix, ported from web v4.1. A symbol whose SpiceModel slot
names a model file (.sub or .lib) carries its card in Value2; v1.3.0 tested
only for .sub, so .lib-typed symbols (ADP17xx, ADP71xx, LT1965, LT3009
families, ADI.lib op-amps) received an instance-level SpiceModel override that
LTspice interprets as a library file reference, which (a) raises "Could not
open library file" when the schematic is opened interactively and (b) drops
the subcircuit name from the card LTspice composes in batch mode. Found by the
independent second verification on 13 corpus circuits (12 connectivity
disagreements, 13 parameter disagreements, all now resolved).

Verification gates: 117/117 and 3101/3460 verified MATCH unchanged; outcome,
terminating rung, rungs tried, crossings, bends, wire length, fallback count
identical to v1.3.0 for every circuit of both sets; no generated schematic
carries an instance-level SpiceModel attribute; LTspice second verification
117/117 and 3099/3460 connectivity, 117/117 and 3460/3460 parameters.
weave_bench now reports the process peak RSS at the end of a run.
