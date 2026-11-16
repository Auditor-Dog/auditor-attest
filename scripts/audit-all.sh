#!/usr/bin/env bash
# Run scripts/audit-local.sh over clones in "examples i runned local", one at a time,
# smallest program first, skipping clones already audited with the current corpus, and
# publishing each result (--ingest). Log: audit-all.log in the repo root.
#
# Usage-limit aware: your Claude login has a 5-hour session budget and one audit uses a
# large share of it. Before each repo (and after a run that ended without doing any work)
# the queue probes the CLI with a tiny prompt and waits, in 15-minute steps, until the
# limit has reset. A repo is only counted as failed when the run actually did work.
#
#   pnpm audit:all                                   # everything not yet audited with 7.7.5
#   pnpm audit:all -- --only kamino                  # substring filter
#   pnpm audit:all -- --only "Serum/swap,Kamino/kfarms"   # exact list (comma-separated)
#   pnpm audit:all -- --model opus --scope program   # anything else goes to audit-local.sh
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
ONLY=""; EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="$2"; shift 2 ;;
    *) EXTRA+=("$1"); shift ;;
  esac
done
CORPUS_VERSION="${CORPUS_VERSION:-7.7.5@8ecccb4}"
LOG="audit-all.log"
MAX_WAIT_MIN="${MAX_WAIT_MIN:-720}"   # give up waiting for capacity after 12 h

CLI="$(command -v claude || ls -1d "$HOME"/.vscode-server/extensions/anthropic.claude-code-*-linux-x64/resources/native-binary/claude 2>/dev/null | sort -V | tail -1)"
log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$LOG"; }

selected() {  # $1 = Org/repo
  [ -z "$ONLY" ] && return 0
  if [[ "$ONLY" == *,* ]]; then
    local x; IFS=',' read -ra x <<< "$ONLY"
    for e in "${x[@]}"; do [ "$(echo "$e" | tr -d ' ')" = "$1" ] && return 0; done
    return 1
  fi
  echo "$1" | grep -qi -- "$ONLY"
}

# 0 when the CLI answers a trivial prompt with real tokens; 1 when it returns nothing
# (the signature of the session usage limit) or errors.
have_capacity() {
  local out
  out="$(timeout 120 env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN -u CLAUDE_CODE_CHILD_SESSION \
    "$CLI" -p "Reply with exactly: OK" --model haiku --no-session-persistence --permission-mode dontAsk --output-format json < /dev/null 2>/dev/null)" || return 1
  node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(!r.is_error&&(r.usage?.output_tokens||0)>0?0:1)' <<< "$out" 2>/dev/null
}

wait_for_capacity() {
  local waited=0
  while ! have_capacity; do
    if [ "$waited" -ge "$MAX_WAIT_MIN" ]; then log "gave up waiting for capacity after ${waited} min"; return 1; fi
    log "usage limit reached: waiting 15 min (waited ${waited} min so far)"
    sleep 900; waited=$((waited+15))
  done
  return 0
}

# Did the last failed run stop because the session usage limit was hit mid-audit?
# (evidence dir written by audit-local.sh). Such a run must be retried, not counted failed,
# however much work it had already done.
hit_limit() {
  local ev; ev="$(ls -td audit-failures/*/ 2>/dev/null | head -1)"
  [ -n "$ev" ] && [ -f "$ev/run.json" ] || return 1
  node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(/session limit|usage limit|rate limit/i.test(String(r.result||""))?0:1)' "$ev/run.json" 2>/dev/null
}

# Did the last failed run do any work? (evidence dir written by audit-local.sh)
did_work() {
  local ev; ev="$(ls -td audit-failures/*/ 2>/dev/null | head -1)"
  [ -n "$ev" ] && [ -f "$ev/run.json" ] || return 1
  node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const t=Object.values(r.modelUsage||{}).reduce((n,u)=>n+(u.outputTokens||0),0);process.exit(t>0||(r.num_turns||0)>1?0:1)' "$ev/run.json" 2>/dev/null
}

# Order by Rust LOC ascending so the cheap ones land first.
list=()
while IFS= read -r d; do
  rel="${d#examples i runned local/}"
  selected "$rel" || continue
  if grep -rqs "\"corpus\": \"$CORPUS_VERSION\"" "$d"/audit_*/.attest.json 2>/dev/null; then
    log "skip $rel: already audited with $CORPUS_VERSION"; continue
  fi
  loc=$(tokei --output json "$d" 2>/dev/null | node -e "const j=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log((j.Rust||{code:0}).code)" 2>/dev/null || echo 0)
  list+=("$loc	$rel")
done < <(find "examples i runned local" -mindepth 2 -maxdepth 2 -type d | while read -r d; do [ -d "$d/.git" ] && echo "$d"; done | sort)

[ ${#list[@]} -gt 0 ] || { log "nothing to do"; exit 0; }
mapfile -t queue < <(printf '%s\n' "${list[@]}" | sort -n | cut -f2)
log "queue (${#queue[@]}): ${queue[*]}  options: ${EXTRA[*]:-none}"

ok=0; fail=0
for rel in "${queue[@]}"; do
  attempt=0
  while :; do
    attempt=$((attempt+1))
    wait_for_capacity || { log "stopping the queue: no capacity"; break 2; }
    log "=== start $rel (attempt $attempt)"
    if bash scripts/audit-local.sh "$rel" --ingest "${EXTRA[@]}" < /dev/null >> "$LOG" 2>&1; then
      ok=$((ok+1)); log "=== done  $rel"; break
    fi
    if hit_limit; then
      # The limit landed mid-audit. Retry from the top after it resets; no attempt cap,
      # since nothing is wrong with the repo. wait_for_capacity does the actual waiting.
      attempt=$((attempt-1))
      log "=== $rel stopped on the session usage limit; retrying when it resets"
      sleep 900; continue
    fi
    if did_work || [ "$attempt" -ge 3 ]; then
      fail=$((fail+1)); log "=== FAIL  $rel (see $LOG)"; break
    fi
    log "=== $rel ended without doing any work (usage limit?); will retry after the limit resets"
    sleep 900
  done
done
log "finished: $ok ok, $fail failed"
