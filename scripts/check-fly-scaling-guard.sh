#!/usr/bin/env bash
# OAKLEAGUE-SCALING-GUARD enforcer — fails on uncommented scaling-field changes.
#
# Wired by .github/workflows/scaling-guard.yml on every PR that touches
# server/voice-proxy/fly.toml. Rationale: SPIKE_A_DEFERRED_FIXUP_PLAN.md §3D.
#
# What we gate:
#   - min_machines_running going above 0
#   - new [[vm]] blocks beyond the existing one
#   - any auto_scale_* / scale_count / max_machines_running fields appearing
#
# Bypass: add a `# scaling-approved: <issue#>` comment within the touched diff
# to acknowledge the decision is intentional.

set -euo pipefail

FLY_TOML="server/voice-proxy/fly.toml"
BASE_REF="${BASE_REF:-main}"

if [[ ! -f "$FLY_TOML" ]]; then
  echo "✓ $FLY_TOML not present, nothing to check"
  exit 0
fi

# Get the diff for this file vs the base branch.
DIFF=$(git diff "origin/$BASE_REF...HEAD" -- "$FLY_TOML" || true)

if [[ -z "$DIFF" ]]; then
  echo "✓ no changes to $FLY_TOML"
  exit 0
fi

# Extract added lines (start with '+', not '+++').
ADDED=$(echo "$DIFF" | grep -E '^\+[^+]' || true)

# Patterns that signal a scaling change. min_machines_running > 0 is the most
# common one; the others are forward-looking guards.
SCALING_PATTERNS=(
  'min_machines_running\s*=\s*[1-9]'
  'auto_scale_'
  'max_machines_running'
  'scale_count'
  '^\+\[\[vm\]\]'
)

TRIGGERED=()
for pat in "${SCALING_PATTERNS[@]}"; do
  if echo "$ADDED" | grep -Eq "$pat"; then
    TRIGGERED+=("$pat")
  fi
done

if [[ ${#TRIGGERED[@]} -eq 0 ]]; then
  echo "✓ no scaling-field changes in $FLY_TOML"
  exit 0
fi

# Scaling change detected. Require an explicit approval comment in the diff.
if echo "$ADDED" | grep -Eq '#\s*scaling-approved:\s*\S+'; then
  echo "✓ scaling change found AND scaling-approved comment present"
  echo "  triggered patterns: ${TRIGGERED[*]}"
  exit 0
fi

cat >&2 <<EOF

✗ scaling-guard: $FLY_TOML has scaling changes without approval annotation.

Triggered patterns:
$(printf '  - %s\n' "${TRIGGERED[@]}")

This proxy holds per-session in-memory state (cogs failure counter, quota
cache, sessionToWs Map). Scaling beyond 1 machine without session-affinity
routing or shared state will silently drop turns mid-conversation.

If this scaling change is intentional, add a comment in the diff:

  # scaling-approved: <github-issue-or-pr-number>

…next to the change, then re-push. See:
  docs/_planning/SPIKE_A_DEFERRED_FIXUP_PLAN.md §3D

EOF
exit 1
