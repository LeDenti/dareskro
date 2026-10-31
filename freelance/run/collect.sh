#!/bin/sh
# Copy the run's evidence (public data only: addresses, hashes, observations) from the live files into run/.
# Usage: sh run/collect.sh   (from freelance/)
set -e
HERE=$(cd "$(dirname "$0")/.." && pwd)
RUN="$HERE/run"
for id in d77718f16ab8 a9ff66058dab b4bfa78531e8; do
  [ -f "$HERE/evidence/$id.jsonl" ] && cp "$HERE/evidence/$id.jsonl" "$RUN/evidence-$id.jsonl"
done
python3 - "$HERE" "$RUN" <<'PY'
import json, sys
here, run = sys.argv[1], sys.argv[2]
reg = json.load(open(f"{here}/../oracle/registry.json"))["escrows"]
mine = [e for e in reg if e.get("sequence") in (21958544, 21958545, 21958546)]
json.dump({"oracle_registry_entries": mine}, open(f"{run}/registry-extract.json", "w"), indent=2)
st = json.load(open(f"{here}/.missions.json"))["missions"]
keep = [m for m in st if m["id"] in ("986bed59b83f", "1c291be1fe21", "b4aaef7fbaf9")]
for m in keep:
    m.pop("shareToken", None)
    for ms in m["milestones"]:
        ms.pop("unsignedTx", None); ms.pop("acceptUnsignedTx", None)
json.dump({"missions": keep}, open(f"{run}/missions-extract.json", "w"), indent=2)
print("registry entries:", len(mine), "missions:", len(keep))
PY
