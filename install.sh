#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BYPASS_POLICY_ENVIRONMENT="RAIL_CONNECTOR_ALLOW_BYPASS_PERMISSIONS"
CLAUDE_PATH_ENVIRONMENT="RAIL_CONNECTOR_CLAUDE_PATH"
TMUX_PATH_ENVIRONMENT="RAIL_CONNECTOR_TMUX_PATH"
ALLOWED_ROOTS_ENVIRONMENT="RAIL_CONNECTOR_ALLOWED_ROOTS"

usage() {
  cat <<'EOF'
Usage: ./install.sh [--bypass-policy Disabled|LocalHost|Isolated] [--allowed-root <path>]... [--run-tests]

Bypass policy defaults to Disabled. LocalHost and Isolated register the
required process-level acknowledgement through `codex mcp add --env`.
The installer runs syntax and smoke checks by default. --run-tests adds the
complete repository suite before registration.
Each --allowed-root must be an existing directory. Repeating the option limits
the MCP registration to those canonical project roots.
EOF
}

bypass_policy_value() {
  case "$1" in
    [Dd][Ii][Ss][Aa][Bb][Ll][Ee][Dd]) printf '%s' "" ;;
    [Ll][Oo][Cc][Aa][Ll][Hh][Oo][Ss][Tt]) printf '%s' "I_UNDERSTAND_BYPASS_CAN_MODIFY_MY_HOST_WITHOUT_PROMPTS" ;;
    [Ii][Ss][Oo][Ll][Aa][Tt][Ee][Dd]) printf '%s' "I_UNDERSTAND_THIS_REQUIRES_ISOLATION" ;;
    *)
      echo "Invalid bypass policy: $1. Expected Disabled, LocalHost, or Isolated." >&2
      return 2
      ;;
  esac
}

print_registration_command() {
  printf '  codex'
  printf ' %q' "$@"
  printf '\n'
}

main() {
  local bypass_policy="Disabled"
  local run_tests="false"
  local -a allowed_roots=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --bypass-policy)
        [ "$#" -ge 2 ] || { echo "--bypass-policy requires a value." >&2; usage >&2; return 2; }
        bypass_policy="$2"
        shift 2
        ;;
      --bypass-policy=*)
        bypass_policy="${1#*=}"
        shift
        ;;
      --run-tests)
        run_tests="true"
        shift
        ;;
      --allowed-root)
        [ "$#" -ge 2 ] || { echo "--allowed-root requires a path." >&2; usage >&2; return 2; }
        allowed_roots+=("$2")
        shift 2
        ;;
      --allowed-root=*)
        allowed_roots+=("${1#*=}")
        shift
        ;;
      -h|--help)
        usage
        return 0
        ;;
      *)
        echo "Unknown argument: $1" >&2
        usage >&2
        return 2
        ;;
    esac
  done

  local policy_value
  policy_value="$(bypass_policy_value "$bypass_policy")" || return $?

  command -v node >/dev/null || { echo "Missing node. Install Node.js first."; return 1; }
  command -v npm >/dev/null || { echo "Missing npm. Install npm first."; return 1; }
  command -v tmux >/dev/null || { echo "Missing tmux. Install tmux first."; return 1; }
  command -v claude >/dev/null || { echo "Missing claude. Install and authenticate Claude Code first."; return 1; }

  local node_major
  node_major="$(node -p "Number(process.versions.node.split('.')[0])")"
  case "$node_major" in
    22|24|26) ;;
    *)
      echo "Node.js major 22, 24, or 26 is required. Current version: $(node --version)"
      return 1
      ;;
  esac

  local node_path
  node_path="$(command -v node)"
  local claude_path
  claude_path="$(command -v claude)"
  local tmux_path
  tmux_path="$(command -v tmux)"
  local allowed_roots_value=""
  local requested_root canonical_root
  # The guarded expansion keeps an empty array safe under Bash 3.2 + set -u.
  for requested_root in ${allowed_roots[@]+"${allowed_roots[@]}"}; do
    [ -d "$requested_root" ] || { echo "Allowed root is not an existing directory: $requested_root" >&2; return 1; }
    canonical_root="$(cd "$requested_root" && pwd -P)"
    if [ -n "$allowed_roots_value" ]; then
      allowed_roots_value+=":"
    fi
    allowed_roots_value+="$canonical_root"
  done

  local registration_args=(mcp add rail-connector)
  registration_args+=(--env "$CLAUDE_PATH_ENVIRONMENT=$claude_path")
  registration_args+=(--env "$TMUX_PATH_ENVIRONMENT=$tmux_path")
  if [ -n "$policy_value" ]; then
    registration_args+=(--env "$BYPASS_POLICY_ENVIRONMENT=$policy_value")
  fi
  if [ -n "$allowed_roots_value" ]; then
    registration_args+=(--env "$ALLOWED_ROOTS_ENVIRONMENT=$allowed_roots_value")
  fi
  registration_args+=(-- "$node_path" "$ROOT_DIR/src/index.js")

  cd "$ROOT_DIR"
  npm ci
  npm run check
  npm run smoke
  if [ "$run_tests" = "true" ]; then
    npm test
  else
    echo "Skipped the full test suite. Re-run with --run-tests for complete local validation."
  fi

  if command -v codex >/dev/null; then
    if codex "${registration_args[@]}"; then
      echo
      echo "Registered MCP server as: rail-connector"
      if ! codex mcp get rail-connector; then
        echo "Warning: registration succeeded, but Codex could not read it back." >&2
      fi
      echo "Start a fresh Codex task so a new MCP process inherits this registration."
    else
      echo >&2
      echo "Codex MCP registration failed. Run this command from the same Linux/macOS Codex environment:" >&2
      print_registration_command "${registration_args[@]}" >&2
      if [ -n "$policy_value" ]; then
        echo "If codex mcp add does not support --env, update Codex or use its MCP/server configuration surface to set the printed environment entry." >&2
      fi
      return 1
    fi
  else
    echo
    echo "codex was not found on PATH; skipped automatic registration."
    echo "Register manually from this same Linux/macOS environment with:"
    print_registration_command "${registration_args[@]}"
  fi
}

main ${@+"$@"}
