#!/usr/bin/env bash
# Generate the deterministic capability report from authoritative Rust sources.
#
# This script is the single source of truth for the numbers in
# `contracts/capabilities.txt`. Run it as a drift check:
#
#   platform/containers/pin-builder/capabilities.sh --check
#
# Exit 0 = manifest matches source; exit 1 = drift detected (diff printed).
# Without `--check` the script writes the generated manifest to stdout.

set -euo pipefail

repo_root="${AI_PIN_SOURCE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../pin" && pwd)}"
tool_catalog="$repo_root/runtime/core/src/services/aibus/tools/catalog.rs"
stock_agent_rs="$repo_root/runtime/core/src/services/aibus/tools/stock_agent.rs"
synapse_dir="$repo_root/runtime/core/src/synapse"
config_rs="$repo_root/runtime/core/src/config.rs"
chat_turn_loop_rs="$repo_root/runtime/core/src/synapse/chat_turn_loop.rs"
stock_deadline_rs="$repo_root/runtime/core/src/services/aibus/stock_deadline.rs"
orchestration_rs="$repo_root/runtime/core/src/services/aibus/turn/orchestration.rs"
action_catalog_rs="$repo_root/runtime/core/src/synapse/catalog.rs"
tier_a_rs="$repo_root/runtime/core/src/tier_a.rs"
manifest="$repo_root/contracts/capabilities.txt"

for f in "$tool_catalog" "$stock_agent_rs" "$config_rs" "$chat_turn_loop_rs" \
         "$stock_deadline_rs" "$orchestration_rs" "$action_catalog_rs" \
         "$tier_a_rs"; do
    if [[ ! -f "$f" ]]; then
        echo "ERROR: missing source: $f" >&2
        exit 2
    fi
done
if [[ ! -d "$synapse_dir" ]]; then
    echo "ERROR: missing synapse directory: $synapse_dir" >&2
    exit 2
fi

# POSIX-awk helper: extract `name: "..."` values from a named fn's body.
# Usage: extract_name_values <file> <fn_name>
extract_name_values() {
    local file="$1" fn="$2"
    awk -v fn="^fn $fn\\(\\)" '
        $0 ~ fn,/^}/ {
            if ($0 ~ /^[[:space:]]*name:[[:space:]]*"/) {
                s = $0
                sub(/^[[:space:]]*name:[[:space:]]*"/, "", s)
                sub(/".*$/, "", s)
                print s
            }
        }
    ' "$file"
}

# POSIX-awk helper: extract `from_secs(N)` from a line matching a pattern.
# Usage: extract_from_secs <file> <pattern>
extract_from_secs() {
    local file="$1" pattern="$2"
    awk -v pat="$pattern" '
        $0 ~ pat {
            s = $0
            if (match(s, /from_secs\([0-9]+\)/)) {
                sub(/.*from_secs\(/, "", s)
                sub(/\).*/, "", s)
                print s
                exit
            }
        }
    ' "$file"
}

# ─── 1. Tool-catalog read tools ───────────────────────────────────────
read_tool_names="$(extract_name_values "$tool_catalog" "read_specs")"
read_tool_count="$(echo "$read_tool_names" | grep -c . || true)"

# ─── 2. Tool-catalog mutation tools ───────────────────────────────────
mutation_tool_names="$(extract_name_values "$tool_catalog" "mutation_specs")"
mutation_specs_count="$(echo "$mutation_tool_names" | grep -c . || true)"

has_play_music="$(grep -c 'const PLAY_MUSIC_TOOL' "$tool_catalog" || true)"
play_music_count=$(( has_play_music > 0 ? 1 : 0 ))
total_mutation=$(( mutation_specs_count + play_music_count ))
if (( play_music_count > 0 )); then
    mutation_tool_names=$'play_music\n'"$mutation_tool_names"
fi

# ─── 3. Stock agent tools (bounded schemas in tools/stock_agent.rs) ────
# Count distinct StockIntent enum variants.
stock_intent_count=$(awk '
    /^enum StockIntent/,/^}/ {
        if ($0 ~ /^[[:space:]]+[A-Z][A-Za-z]+(\(|[[:space:]]|$)/) count++
    }
    END { print count+0 }
' "$stock_agent_rs")

# Resolve the generated `native_actions::CONST` references and the three
# stock-only food literals materialized by the *_vN_functions() builders.
# Counting resolved wire values preserves the pre-Tier-A manifest semantics:
# aliases would still count once, and an unknown generated symbol fails closed.
stock_routed_tool_names="$(awk '
    FNR == NR {
        if ($0 ~ /^pub mod native_actions[[:space:]]*\{/) {
            in_native_actions = 1
            next
        }
        if (in_native_actions && $0 ~ /^}/) {
            in_native_actions = 0
            next
        }
        if (in_native_actions && $0 ~ /^[[:space:]]*pub const [A-Z][A-Z0-9_]*: &str = "[A-Z][A-Za-z0-9]+";/) {
            symbol = $0
            sub(/^[[:space:]]*pub const /, "", symbol)
            sub(/:.*/, "", symbol)
            value = $0
            sub(/^[^"]*"/, "", value)
            sub(/".*$/, "", value)
            native_action[symbol] = value
        }
        next
    }

    /^(fn timer_v1_functions|fn alarm_v1_functions|fn contacts_v1_functions|fn settings_v3_functions|fn food_v4_functions)\(\)/ {
        in_builder = 1
    }

    in_builder {
        if ($0 ~ /native_actions::[A-Z][A-Z0-9_]*\.to_string\(\)/) {
            symbol = $0
            sub(/^.*native_actions::/, "", symbol)
            sub(/\.to_string\(\).*$/, "", symbol)
            if (!(symbol in native_action)) {
                print "ERROR: unresolved generated native action symbol: " symbol > "/dev/stderr"
                unresolved = 1
            } else {
                names[native_action[symbol]] = 1
            }
        } else if ($0 ~ /"[A-Z][A-Za-z0-9]+"\.to_string\(\)/) {
            value = $0
            sub(/^[^"]*"/, "", value)
            sub(/".*$/, "", value)
            names[value] = 1
        }
        if ($0 ~ /^}/) in_builder = 0
    }

    END {
        if (unresolved) exit 42
        for (name in names) print name
    }
' "$tier_a_rs" "$stock_agent_rs")"
stock_routed_tool_count="$(printf '%s\n' "$stock_routed_tool_names" | grep -c . || true)"

# ─── 4. Deterministic fast-path planners (synapse/) ────────────────────
planner_count=0
planner_lines=""
while IFS= read -r f; do
    module="$(basename "$f" .rs)"
    # Include both `pub fn plan_*` and private `fn plan_*` helpers — all are
    # part of the deterministic fast-path surface.
    while IFS= read -r fn_name; do
        [[ -z "$fn_name" ]] && continue
        planner_count=$((planner_count + 1))
        planner_lines+="$module $fn_name"$'\n'
    done < <(grep -oE '(pub( *\([^)]*\))? *)?fn plan_[A-Za-z_]+' "$f" \
                | sed 's/^.*fn //' | sort -u)
done < <(find "$synapse_dir" -maxdepth 3 -type f -name '*.rs' ! -name 'tests.rs' | sort)
planner_lines="$(printf '%s' "$planner_lines" | sort -k1,1 -k2,2)"
planner_modules="$(printf '%s' "$planner_lines" | awk 'NF{print $1}' | sort -u | wc -l | tr -d ' ')"

# ─── 5. Agentic loop configuration ────────────────────────────────────
max_tool_turns="$(awk '
    /^fn default_max_tool_turns\(\)/ { flag=1; next }
    flag && $0 ~ /[0-9]/ {
        s = $0
        gsub(/[^0-9]/, "", s)
        print s
        exit
    }
' "$config_rs")"

grace_reserve_secs="$(extract_from_secs "$chat_turn_loop_rs" "DEFAULT_GRACE_RESERVE")"
slow_step_cue_after_secs="$(extract_from_secs "$chat_turn_loop_rs" "SLOW_STEP_CUE_AFTER")"
stock_turn_deadline_secs="$(extract_from_secs "$stock_deadline_rs" "STOCK_TURN_DEADLINE")"
http_step_timeout_secs="$(extract_from_secs "$orchestration_rs" "const HTTP_PROVIDER_MODEL_STEP_TIMEOUT")"

inner_agent_budget_secs=75  # documented in turn/orchestration.rs code comments

# ─── 6. Native action catalog size ────────────────────────────────────
native_action_catalog_count="$(awk '
    /^pub static NATIVE_ACTION_CATALOG/,/^\];[[:space:]]*$/ {
        if ($0 ~ /action_spec!\(/) count++
    }
    END { print count+0 }
' "$action_catalog_rs")"

# ─── Render ─────────────────────────────────────────────────────────────
render() {
    cat <<EOF
# Generated Capability Manifest

> Auto-generated from Rust source registries by \`platform/containers/pin-builder/capabilities.sh\`.
> Authoritative counts for tools, planners, and agentic loop configuration.
>
> Deterministic snapshot of current source; no wall-clock value is embedded.

## Tool Catalog Read Tools (Advertised to Model)

Count: **$read_tool_count** (depends on authorization/subscription/provider gates).

$(printf '%s\n' "$read_tool_names" | awk 'NF { printf "- `%s`\n", $0 }')

## Tool Catalog Mutation Tools (Native Actions via Model)

Count: **$total_mutation** (=$mutation_specs_count regular + $play_music_count conditional play_music).

$(printf '%s\n' "$mutation_tool_names" | awk 'NF { printf "- `%s`\n", $0 }')

## Stock Agent Tools (Bounded Schema-Aware Routes)

StockIntent variants: **$stock_intent_count**
Routed tool names in v1/v3/v4 function schemas: **$stock_routed_tool_count**

## Deterministic Fast-Path Planners

Count: **$planner_count** plan functions across **$planner_modules** modules in \`synapse/\`.

$(printf '%s' "$planner_lines" | awk 'NF { printf "- `%s` in `%s.rs`\n", $2, $1 }')

## Agentic Loop Configuration

| Parameter | Value | Source |
|-----------|-------|--------|
| Step budget (max_tool_turns) | $max_tool_turns | config.rs default_max_tool_turns |
| Grace reserve | ${grace_reserve_secs}s | chat_turn_loop.rs DEFAULT_GRACE_RESERVE |
| Slow-step cue threshold | ${slow_step_cue_after_secs}s | chat_turn_loop.rs SLOW_STEP_CUE_AFTER |
| Inner agent budget | ${inner_agent_budget_secs}s | turn/orchestration.rs (documented) |
| Outer stock turn deadline | ${stock_turn_deadline_secs}s | stock_deadline.rs STOCK_TURN_DEADLINE |
| HTTP provider step timeout | ${http_step_timeout_secs}s | turn/orchestration.rs HTTP_PROVIDER_MODEL_STEP_TIMEOUT |

## Native Action Catalog

**$native_action_catalog_count** entries in NATIVE_ACTION_CATALOG (validation table, NOT a tool-advertisement source).
EOF
}

output="$(render)"

if [[ "${1:-}" == "--check" ]]; then
    if [[ ! -f "$manifest" ]]; then
        echo "ERROR: manifest not found at $manifest" >&2
        exit 1
    fi
    # Compare only the structured sections this script regenerates. The
    # hand-maintained sections (Provider Matrix, On-Device NLU, static
    # per-tool gate tables) are intentionally excluded from the diff.
    normalize() {
        awk '
            /^> Last generated:/ { next }
            /^## / {
                keep = 0
                if ($0 ~ /^## Tool Catalog Read Tools/) keep = 1
                if ($0 ~ /^## Tool Catalog Mutation Tools/) keep = 1
                if ($0 ~ /^## Stock Agent Tools/) keep = 1
                if ($0 ~ /^## Deterministic Fast-Path Planners/) keep = 1
                if ($0 ~ /^## Agentic Loop Configuration/) keep = 1
                if ($0 ~ /^## Native Action Catalog/) keep = 1
            }
            keep { print }
        ' "$1" \
            | sed 's/[[:space:]]\+$//' \
            | awk '
                NF {
                    while (blank > 0) {
                        print ""
                        blank--
                    }
                    print
                    next
                }
                { blank++ }
            '
    }
    tmp_gen="$(mktemp)"
    tmp_manifest_normalized="$(mktemp)"
    tmp_generated_normalized="$(mktemp)"
    trap 'rm -f "$tmp_gen" "$tmp_manifest_normalized" "$tmp_generated_normalized"' EXIT
    printf '%s\n' "$output" > "$tmp_gen"
    normalize "$manifest" > "$tmp_manifest_normalized"
    normalize "$tmp_gen" > "$tmp_generated_normalized"
    if diff -u "$tmp_manifest_normalized" "$tmp_generated_normalized"; then
        echo "OK: capability manifest is in sync with source."
        exit 0
    else
        echo "DRIFT DETECTED: capability manifest does not match source." >&2
        echo "Re-run \`platform/containers/pin-builder/capabilities.sh\` and review the diff." >&2
        exit 1
    fi
else
    printf '%s\n' "$output"
fi
