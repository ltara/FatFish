#!/usr/bin/env bash
# Force CRLF line endings on *.bat / *.cmd under given directories.
# Usage: ensure-crlf.sh [dir ...]   (default: vendor/napcat dist/FatFish)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ $# -eq 0 ]]; then
  set -- "$ROOT/vendor/napcat" "$ROOT/dist/FatFish"
fi
python3 - "$ROOT" "$@" <<'PY'
import sys
from pathlib import Path

roots = [Path(p) for p in sys.argv[2:]]
n = 0
for root in roots:
    if not root.is_dir():
        continue
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        if p.suffix.lower() not in {".bat", ".cmd"}:
            continue
        data = p.read_bytes()
        # normalize: strip CR, then LF -> CRLF
        norm = data.replace(b"\r\n", b"\n").replace(b"\r", b"\n").replace(b"\n", b"\r\n")
        if norm != data:
            p.write_bytes(norm)
            n += 1
            print(f"[crlf] fixed {p}")
print(f"[crlf] done, fixed={n}")
PY
