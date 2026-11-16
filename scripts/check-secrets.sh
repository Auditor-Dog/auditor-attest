#!/usr/bin/env bash
# Scans files for secrets before they enter git.
#   scripts/check-secrets.sh            # scan the whole working tree
#   scripts/check-secrets.sh --staged   # scan only staged changes (pre-commit)
# Exit 1 on any hit. Patterns are deliberately broad; add allowlist lines to
# .secretsignore (one regex per line) for known false positives.
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

MODE="${1:-tree}"
IGNORE_FILE=".secretsignore"

# What we look for. Each line: <label>|<extended regex>
PATTERNS='
Anthropic API key|sk-ant-[A-Za-z0-9_-]{20,}
OpenAI-style key|sk-[A-Za-z0-9]{32,}
GitHub token|gh[pousr]_[A-Za-z0-9]{30,}
GitHub fine-grained token|github_pat_[A-Za-z0-9_]{50,}
Helius/RPC api-key in URL|api-key=[A-Za-z0-9-]{20,}
AWS access key|AKIA[0-9A-Z]{16}
Private key block|-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----
Solana keypair JSON (64-byte array)|^\s*\[\s*([0-9]{1,3}\s*,\s*){63}[0-9]{1,3}\s*\]\s*$
Base58 secret assignment|(SECRET|PRIVATE)_?KEY\s*[=:]\s*["'"'"']?[1-9A-HJ-NP-Za-km-z]{80,}
Generic secret assignment|(api[_-]?key|secret|token|password)\s*[=:]\s*["'"'"'][^"'"'"'\s]{16,}["'"'"']
'

if [ "$MODE" = "--staged" ]; then
  # Block any staged change inside the pinned corpus submodule.
  if git diff --cached --name-only | grep -q '^vendor/auditor-skill'; then
    if [ "${ALLOW_CORPUS_BUMP:-0}" != "1" ] && git diff --cached --submodule=short -- vendor/auditor-skill | grep -q '^Subproject commit'; then
      echo "✗ Refusing to commit: vendor/auditor-skill submodule pointer changed. A deliberate bump updates every CORPUS_SHA / CORPUS_VERSION too, then commits with ALLOW_CORPUS_BUMP=1." >&2
      exit 1
    fi
  fi
  FILES="$(git diff --cached --name-only --diff-filter=ACM)"
else
  FILES="$(git ls-files --cached --others --exclude-standard)"
fi

# Never scan these paths (binary, vendored, or the example env that documents names, not values).
FILES="$(echo "$FILES" | grep -Ev '^(vendor/|node_modules/|pnpm-lock\.yaml$|\.env\.example$|scripts/check-secrets\.sh$|\.secretsignore$|.*\.(png|jpg|jpeg|gif|ico|woff2?|pdf|lock)$)' || true)"

[ -z "$FILES" ] && exit 0

STATUS=0
while IFS='|' read -r LABEL REGEX; do
  [ -z "$LABEL" ] && continue
  while IFS= read -r FILE; do
    [ -f "$FILE" ] || continue
    if [ "$MODE" = "--staged" ]; then
      CONTENT="$(git show ":$FILE" 2>/dev/null || true)"
    else
      CONTENT="$(cat "$FILE")"
    fi
    HITS="$(printf '%s\n' "$CONTENT" | grep -nE -e "$REGEX" || true)"
    if [ -n "$HITS" ]; then
      if [ -f "$IGNORE_FILE" ]; then
        FILTERED="$HITS"
        while IFS= read -r IGN; do
          [ -z "$IGN" ] && continue
          FILTERED="$(printf '%s\n' "$FILTERED" | grep -vE -e "$IGN" || true)"
        done < "$IGNORE_FILE"
        HITS="$FILTERED"
      fi
      if [ -n "$HITS" ]; then
        echo "✗ $LABEL in $FILE:" >&2
        printf '%s\n' "$HITS" | sed 's/^/    /' | cut -c1-160 >&2
        STATUS=1
      fi
    fi
  done <<< "$FILES"
done <<< "$PATTERNS"

if [ $STATUS -ne 0 ]; then
  echo "" >&2
  echo "Secrets must never enter git. Move them to .env (gitignored) or a keyfile outside the repo." >&2
  echo "False positive? Add a regex line to .secretsignore." >&2
fi
exit $STATUS
