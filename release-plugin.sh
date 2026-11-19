#!/usr/bin/env bash
# Release (or verify) a plugin from this marketplace repo, end to end.
#
# Usage:
#   ./release-plugin.sh <plugin> <new-version>            full release
#   ./release-plugin.sh <plugin> <version> --check-only   verify only, change nothing
#
# Checks (all must pass):
#   1. whole-plugin sync from the inline install (incl. .zcode-plugin — the 1.2.1 lesson)
#   2. manifest version == marketplace.json version == requested version
#   3. syntax check (node --check) on every plugin .js
#   4. runtime import test: loader.js + impl/impl.js?v=<fresh> (catches broken relative
#      imports — the class of bug that broke activation when code moved into impl/)
#   5. commit + push (with rebase-first: another instance may have pushed)
#   6. END-TO-END: poll the GitHub raw URL until the remote manifest reports the new
#      version — the same bytes a consumer's marketplace refresh will download.
set -e
NAME="$1"; VERSION="$2"; MODE="${3:-}"
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
RAW_BASE="https://raw.githubusercontent.com/golfromeo-fr/zcode-toolbox/main"
fail() { echo "FAIL: $1"; exit 1; }
[ -n "$NAME" ] && [ -n "$VERSION" ] || fail "usage: release-plugin.sh <plugin> <version> [--check-only]"
MANIFEST="$REPO_DIR/plugins/$NAME/.zcode-plugin/plugin.json"
LISTING="$REPO_DIR/marketplace.json"
[ -f "$MANIFEST" ] || fail "no manifest at $MANIFEST"

if [ "$MODE" != "--check-only" ]; then
  "$REPO_DIR/sync-plugin.sh" "$NAME" "$VERSION"
  cd "$REPO_DIR"
  git pull --rebase origin main >/dev/null 2>&1 || true
fi

echo "[1/6] manifest versions"
MVER=$(python3 -c "import json;print(json.load(open('$MANIFEST'))['version'])")
LVER=$(python3 -c "import json;print(json.load(open('$LISTING'))['plugins'][0]['version'] if False else [p['version'] for p in json.load(open('$LISTING'))['plugins'] if p['name']=='$NAME'][0])")
[ "$MVER" = "$VERSION" ] || fail "manifest is $MVER, want $VERSION"
[ "$LVER" = "$VERSION" ] || fail "marketplace.json is $LVER, want $VERSION"
echo "  ok: manifest=$MVER listing=$LVER"

echo "[2/6] syntax check"
FAILED=0
while IFS= read -r f; do
  node --check "$f" 2>/tmp/rc.err || { echo "  syntax error in $f"; cat /tmp/rc.err; FAILED=1; }
done < <(find "$REPO_DIR/plugins/$NAME" -name "*.js")
[ "$FAILED" = "0" ] || fail "syntax"

echo "[3/6] runtime import test"
ROOT="$REPO_DIR/plugins/$NAME"
node --input-type=module -e "
const l = await import(new URL('file://$ROOT/loader.js'));
const i = await import(new URL('file://$ROOT/impl/impl.js?v=release-check'));
if (typeof l.activate !== 'function' || typeof i.activate !== 'function') process.exit(1);
" || fail "import test (broken imports? relative paths after a move?)"
echo "  ok: loader + impl import, activate() exported"

echo "[4/6] git state"
cd "$REPO_DIR"
if [ "$MODE" != "--check-only" ]; then
  git add -A
  if git diff --cached --quiet; then echo "  nothing to commit (already at $VERSION)"; else
    git commit -m "release: $NAME@$VERSION" >/dev/null
  fi
  git pull --rebase origin main >/dev/null 2>&1 || true
  git push origin main >/dev/null || fail "push"
  echo "  pushed"
else
  git fetch origin main >/dev/null 2>&1 || fail "cannot reach origin"
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || fail "local HEAD != origin/main (unpushed changes)"
  echo "  ok: local == origin/main"
fi

echo "[5/6] end-to-end: remote manifest as consumers will fetch it"
EXPECT="$VERSION"
GOT=""
for i in 1 2 3 4 5; do
  GOT=$(curl -fsS "$RAW_BASE/plugins/$NAME/.zcode-plugin/plugin.json" 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin).get('version',''))" || echo "")
  [ "$GOT" = "$EXPECT" ] && break
  sleep 2
done
[ "$GOT" = "$EXPECT" ] || fail "remote manifest still reports '${GOT:-nothing}' (CDN lag? push failed?)"
echo "  ok: remote manifest = $GOT"

echo "[6/6] consumer steps"
echo "  every instance: refresh the marketplace -> Update '$NAME' -> toggle off/on -> chip tooltip starts with v$VERSION"
echo "RELEASE OK"
