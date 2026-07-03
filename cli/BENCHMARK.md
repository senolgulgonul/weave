# Benchmark: weave vs Schemato on Circuits-LTSpice

A head-to-head comparison against Schemato (Matsuo et al., *Schemato — An LLM for Netlist-to-Schematic Conversion*, MLCAD 2025) on the identical public test set.

## Setup

- **Test set:** [Circuits-LTSpice](https://github.com/mick001/Circuits-LTSpice), the same public repository Schemato used for testing.
- **Input:** real netlists produced by LTspice XVII (17.0.36) via `XVIIx64.exe -netlist`. weave's own extractor is not used, so there is no circularity: the input comes from LTspice itself, exactly as in Schemato's methodology (`.asc → LTspice -netlist → netlist → model → .asc`).
- **Denominator:** both methods are evaluated only on circuits LTspice can netlist. Circuits whose symbols are missing from the installed library cannot be netlisted and are skipped. LTspice XVII 17.0.36 produced **117** netlists out of 131, matching the count independently reported by Schemato. The denominator is identical.

## Result

| Metric | Schemato (best, .asc) | GPT-4o | weave |
|---|---|---|---|
| Compilation rate | 76% | 63% | **100%** (117/117) |
| Connectivity | GED 0.35 (similarity, not exact) | GED 0.23 | **100% exact equivalence** |
| Behavior beyond 5 components | loses connectivity (per Schemato's own conclusion) | — | all MATCH |
| Infrastructure | 8×GPU fine-tune, 45k samples | API | none; browser / single file |

weave produces a valid `.asc` for all 117 circuits, and every one is a round-trip-verified MATCH: the generated `.asc` re-parses to a netlist whose connectivity is identical to the input, net for net (equivalent to a graph-edit-distance score of 1.0, but as a binary certificate rather than a similarity score).

## Why 100% on this set

This repository consists mostly of generic components (resistors, capacitors, inductors, BJTs, MOSFETs, sources), as the Schemato paper itself notes. Component-count distribution across the 117 circuits:

- 2–5 components: 31 circuits
- 6–10 components: 38 circuits
- 11–20 components: 37 circuits
- 21+ components: 11 circuits (largest is 39: a three-phase supply and a common-emitter design)

Mean 11 components, median 9. Only 3 circuits contain a 12+ pin integrated part, which is weave's one known failure class (dense multi-pin power modules). That class is essentially absent from this set, which is why the rate is 100%.

The important point: **86 of the 117 circuits (73%) exceed five components**, which is exactly the region where Schemato's own conclusion states it "struggles to generate schematics with accurate connectivity." weave produces a MATCH for all of them, the largest at 37–39 components.

## Verifier is not vacuous

Sanity check: deleting a wire from a generated `.asc` makes the verifier report MISMATCH (nets break); changing a net name in the input netlist makes it report MISMATCH. The 100% therefore reflects genuine connectivity equivalence, not a verifier that labels everything MATCH.

## Honest scope note

- Schemato's exact LTspice version is not reported in the paper; weave used XVII 17.0.36. Because the denominator (117) came out identical on both sides, the comparison is sound.
- weave uses a deterministic symbol table and pattern-based layout; Schemato uses a probabilistic LLM. weave targets in-library parts (LTspice XVII symbols), which is precisely the nature of this test set. The result reflects the advantage of weave's design choice (deterministic construction with verification) over learning for this task.
- On a harder corpus of 3460 real LTspice circuits with many 12+ pin power modules, weave's in-scope MATCH rate is 91%. The 100% here is specific to this generic-component set and should be read as such.

## Reproduce it

See the reproduction steps in [README.md](README.md). In short: clone Circuits-LTSpice, netlist the `.asc` files with your own LTspice, then run `node weave.js batch ./netlist`.
