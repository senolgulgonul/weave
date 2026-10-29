# Reproduce every number of the paper on Windows with LTspice XVII installed.
# Edit the three paths below. Requires Node.js 18+ and `npm install` in ..\cli.
$exe   = "D:\LTspice\XVIIx64.exe"
$net117  = "D:\weave\netlist117"        # 117 Circuits-LTSpice netlists (check manifest_circuits_ltspice_117.sha256)
$net3460 = "D:\weave\corpus_nets"       # 3460 ADI demo netlists (check manifest_adi_demo_3460.sha256)
$cli = Join-Path $PSScriptRoot "..\cli"
Set-Location $cli
node weave_bench.js $net117  out117_full  results\r117_full.csv  --modes all
node weave_bench.js $net117  out117_m5    results\r117_elkonly.csv --modes 5
node weave_bench.js $net117  out117_m0    results\r117_rung0.csv   --modes 0
node weave_bench.js $net3460 out3460_full results\r3460_full.csv --modes all
node weave_bench.js $net3460 out3460_m5   results\r3460_elkonly.csv --modes 5
node weave_bench.js $net3460 out3460_m0   results\r3460_rung0.csv   --modes 0
# second verification: let LTspice itself re-extract a netlist from every generated schematic
foreach ($d in @("out117_full","out3460_full")) {
  Get-ChildItem $d -Filter *.asc | ForEach-Object { Start-Process $exe -ArgumentList "-netlist `"$($_.FullName)`"" -Wait -NoNewWindow }
}
node nlcompare.js --batch $net117  out117_full  results\nl117.csv
node nlcompare.js --batch $net3460 out3460_full results\nl3460.csv
