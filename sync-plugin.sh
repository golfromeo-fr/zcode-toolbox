#!/usr/bin/env bash
# Sync a plugin from the live inline install into this marketplace repo.
# Copies the WHOLE plugin dir (including .zcode-plugin — the manifest carries the
# version ZCode reads; a partial copy leaves the listing and manifest out of sync,
# which breaks the store's upgrade detection).
# Usage: ./sync-plugin.sh context-lens 1.6.1
set -e
NAME="$1"
VERSION="$2"
SRC="/home/gr/.zcode/plugins/$NAME"
DST="$(dirname "$0")/plugins/$NAME"
if [ -z "$NAME" ] || [ -z "$VERSION" ] || [ ! -f "$SRC/.zcode-plugin/plugin.json" ]; then
  echo "usage: $0 <plugin-name> <new-version>  (source must exist at $SRC)"
  exit 1
fi
rm -rf "$DST"
cp -r "$SRC" "$DST"
python3 - "$DST/.zcode-plugin/plugin.json" "$VERSION" <<'PY'
import json, sys
p = sys.argv[1]
m = json.load(open(p))
m["version"] = sys.argv[2]
json.dump(m, open(p, "w"), indent=2, ensure_ascii=False)
print("manifest ->", sys.argv[2])
PY
python3 - "$(dirname "$0")/marketplace.json" "$NAME" "$VERSION" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
for entry in d["plugins"]:
    if entry["name"] == sys.argv[2]:
        entry["version"] = sys.argv[3]
json.dump(d, open(p, "w"), indent=2, ensure_ascii=False)
print("marketplace.json ->", sys.argv[3])
PY
echo "synced $NAME@$VERSION — review, commit and push."
