#!/usr/bin/env bash
# Runs the same task twice through `claude -p`, once without and once with the
# three mods, each in a fresh copy of bench/fixture, and prints the usage
# Claude Code reports for each run. User settings are left out of both runs
# (--setting-sources project) so only the mods differ.
#
# Usage: bench/run.sh [runs-per-side]   (default 1; each run spends plan usage)

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
kit="$(cd "$here/.." && pwd)"
runs="${1:-1}"
out="$here/results"
mkdir -p "$out"

prompt='Run `node test.js`, find the failing test, fix the bug in src/math.js, then run `node test.js` again to confirm everything passes. Reply with one sentence naming the fix.'

run() {
  local side="$1" n="$2"
  local work
  work="$(mktemp -d)"
  cp -r "$here/fixture/." "$work/"
  local mods=()
  if [ "$side" = "with" ]; then
    for m in pro-hud output-diet reread-guard; do mods+=(--plugin-dir "$kit/plugins/$m"); done
  fi
  (
    cd "$work"
    # A session started from inside Claude Code inherits its plugin folders;
    # clear them so only --plugin-dir decides which mods load.
    env -u CLAUDE_CODE_PLUGIN_DIRS CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude -p "$prompt" \
      --output-format json \
      --setting-sources project \
      --allowedTools "Bash(node test.js)" "PowerShell(node test.js)" Read Edit \
      "${mods[@]}" < /dev/null
  ) > "$out/$side-$n.json" || true
  node -e '
    const r = require(process.argv[1]); const u = r.usage || {}
    const inTok = (u.input_tokens||0) + (u.cache_read_input_tokens||0) + (u.cache_creation_input_tokens||0)
    console.log([process.argv[2], inTok, u.cache_read_input_tokens||0, u.output_tokens||0, r.num_turns, r.is_error ? `error: ${r.result}` : "ok"].join("\t"))
  ' "$out/$side-$n.json" "$side-$n"
  rm -rf "$work"
}

printf 'run\tin\tcached\tout\tturns\tresult\n'
# The second run of a pair starts with a warmer prompt cache, so the order
# alternates: odd pairs run without first, even pairs run with first.
for n in $(seq 1 "$runs"); do
  if [ $((n % 2)) -eq 1 ]; then
    run without "$n"
    run with "$n"
  else
    run with "$n"
    run without "$n"
  fi
done
