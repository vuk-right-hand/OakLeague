#!/usr/bin/env bash
# HUME_TTS_PLAN §5.5 — writer discipline CI grep.
#
# Enforces that every .insert() / .upsert() call site on
# voice_clone_uploads / voice_delete_queue / voice_tickets includes a
# `tts_provider:` literal key in its call body.
#
# Once the follow-up migration drops the DEFAULT, any writer site
# without explicit tts_provider will 23502 NOT NULL at runtime. This
# grep is the pre-commit / CI gate that catches the omission before
# deploy.
#
# Exit 0: all writer sites pass. Exit 1: at least one site missing.
# Print the offending lines + file:line markers.
#
# Strategy: anchor on `.insert(` / `.upsert(` lines. For each anchor,
# scan the 6-line window BACKWARD for the `.from('TABLE')` call (the
# Supabase chain idiom is `.from(...).insert(...)`) AND scan the
# 28-line window FORWARD for `tts_provider:` (or `tts_provider =`).
# This dodges false-positives from SELECTs that happen to share a
# file with unrelated INSERTs.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

TARGETS=(
  "src"
  "server"
)

TABLES=(
  "voice_clone_uploads"
  "voice_delete_queue"
  "voice_tickets"
)

EXIT=0

# Build a single regex matching any of the tables: voice_clone_uploads|...
TABLE_RE=$(printf "%s|" "${TABLES[@]}" | sed 's/|$//')

# Find every .insert( / .upsert( line in our targets. For each, decide
# whether it belongs to one of our tables and whether tts_provider is
# present in the call body.
while IFS= read -r hit; do
  file="${hit%%:*}"
  rest="${hit#*:}"
  lineno="${rest%%:*}"

  # Skip tests + this script + migration SQL.
  case "$file" in
    *.test.ts|*.test.js|scripts/check-tts-provider-writes.sh|supabase/migrations/*) continue ;;
  esac

  # Scan backward 8 lines for .from('<one of our tables>')
  back_start=$((lineno > 8 ? lineno - 8 : 1))
  back_window=$(sed -n "${back_start},${lineno}p" "$file" 2>/dev/null || echo "")
  if ! echo "$back_window" | grep -qE "\.from\((['\"])(${TABLE_RE})\1\)"; then
    continue
  fi

  # Scan forward 28 lines from .insert( for tts_provider key
  fwd_end=$((lineno + 28))
  fwd_window=$(sed -n "${lineno},${fwd_end}p" "$file" 2>/dev/null || echo "")
  if echo "$fwd_window" | grep -qE '\btts_provider\b\s*[:=]'; then
    continue
  fi

  echo "::error file=$file,line=$lineno::writer missing tts_provider literal (HUME_TTS_PLAN §5.5)"
  echo "  context (line $lineno + 28):"
  echo "$fwd_window" | sed 's/^/    /'
  echo ""
  EXIT=1
done < <(grep -rnE '\.(insert|upsert)\s*\(' "${TARGETS[@]}" --include='*.ts' --include='*.js' 2>/dev/null || true)

if [[ $EXIT -eq 0 ]]; then
  echo "✅ check-tts-provider-writes: all voice_clone_uploads + voice_delete_queue + voice_tickets writers pass tts_provider explicitly"
fi

exit $EXIT
