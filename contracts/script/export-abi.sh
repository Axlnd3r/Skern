#!/usr/bin/env bash
# Builds the contracts and writes shared/abi/<Name>.json (ABI array only) for the deployed set.
# Works from any cwd and is idempotent: output is LF, 2-space JSON, one trailing newline.
set -euo pipefail

export PATH="$HOME/.foundry/bin:$PATH"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONTRACTS="$ROOT/contracts"
OUT="$ROOT/shared/abi"
NAMES=(Points Registry Arena GapMarket AllowlistGate)

(cd "$CONTRACTS" && forge build)
mkdir -p "$OUT"

node - "$CONTRACTS/out" "$OUT" "${NAMES[@]}" <<'JS'
const fs = require("fs");
const path = require("path");
const [, , outDir, abiDir, ...names] = process.argv;
for (const name of names) {
  const artifact = path.join(outDir, `${name}.sol`, `${name}.json`);
  const abi = JSON.parse(fs.readFileSync(artifact, "utf8")).abi;
  if (!Array.isArray(abi) || abi.length === 0) throw new Error(`no abi in ${artifact}`);
  const target = path.join(abiDir, `${name}.json`);
  fs.writeFileSync(target, JSON.stringify(abi, null, 2) + "\n", { encoding: "utf8" });
  console.log(`wrote ${target} (${abi.length} entries)`);
}
JS
