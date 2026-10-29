# Benchmark data for "Weave: Verified netlist-to-schematic conversion via layered graph layout"

Everything here is produced by `cli/` at release v1.3.1 and is what the paper's tables are built from.

- `manifest_*.sha256`: SHA-256 of every input netlist (117 Circuits-LTSpice, 3460 ADI demo). Netlists are produced from the public `.asc` sources with `XVIIx64.exe -netlist` (LTspice XVII 17.0.36.0, library snapshot 2026-08-02) as described in the paper; the manifests fix the exact evaluated files.
- `results/r*_full.csv`: per-circuit results of the full pipeline (outcome, terminating rung, rungs tried, timings, element and pin statistics, fallback count, crossings, bends, wire length), measured on the laptop named in the paper (Intel i7-1165G7, 16 GB RAM, Node.js 24).
- `results/r*_elkonly.csv`, `results/r*_rung0.csv`: the two ablation configurations (Table 5).
- `results/peak_rss.txt`: peak resident memory of each run.
- `results/ladder_profile.csv`: circuits entering / first matching / continuing at each rung (Table 6).
- `results/failure_taxonomy_3460.csv`: circuits and partials per largest-symbol-pin-count bin (Table 7).
- `results/nl*.csv`, `results/contingency_3460*.csv`: the independent second verification (LTspice's own extraction of every generated schematic compared with the input by `cli/nlcompare.js`) and its agreement with the verifier (Table 8).
- `ltspice_extracted/`: the netlists LTspice extracted from every generated schematic (inputs of the second verification).
- `reproduce.ps1`: runs all of the above.
