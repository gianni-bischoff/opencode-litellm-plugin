#!/usr/bin/env bash
#
# opencode-litellm-plugin installer
#
# Installs the plugin for OpenCode V2 and adds the required
# `providers.litellm` configuration block.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/gianni-bischoff/opencode-litellm-plugin/main/install.sh | bash
#
# Optional environment variables:
#   LITELLM_BASE_URL  Your proxy URL (default handled by the plugin:
#                     http://127.0.0.1:4000/v1). Example:
#
#   LITELLM_BASE_URL=https://litellm.example.com/v1 \
#     curl -fsSL https://raw.githubusercontent.com/gianni-bischoff/opencode-litellm-plugin/main/install.sh | bash
#
set -euo pipefail

PLUGIN_SPEC="git+https://github.com/gianni-bischoff/opencode-litellm-plugin.git"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
CONFIG_FILE="$CONFIG_DIR/opencode.json"
CONFIG_FILEC="$CONFIG_DIR/opencode.jsonc"

# ---------------------------------------------------------------------------
# Locate the global config file (prefer jsonc when it is the only one present)
# ---------------------------------------------------------------------------
if [ -f "$CONFIG_FILEC" ] && [ ! -f "$CONFIG_FILE" ]; then
  CONFIG_FILE="$CONFIG_FILEC"
fi
mkdir -p "$CONFIG_DIR"
[ -f "$CONFIG_FILE" ] || printf '{\n  "$schema": "https://opencode.ai/config.json"\n}\n' > "$CONFIG_FILE"

# ---------------------------------------------------------------------------
# JSON editor: python3 -> bun -> node
# ---------------------------------------------------------------------------
json_edit() {
  if command -v python3 >/dev/null 2>&1; then python3 - "$1" "$2" "$3" << 'PYEOF'
import json, sys
config_path, action, arg = sys.argv[1], sys.argv[2], sys.argv[3]
with open(config_path) as f:
    text = f.read()
try:
    cfg = json.loads(text)
except json.JSONDecodeError as e:
    sys.exit(f"ERROR: {config_path} is not valid JSON: {e}")
changed = False
if action == "add-provider":
    providers = cfg.setdefault("providers", {})
    if "litellm" not in providers:
        providers["litellm"] = {
            "name": "LiteLLM",
            "env": ["LITELLM_API_KEY"],
            "package": "@opencode-ai/ai/providers/openai-compatible",
            "models": {"placeholder": {"name": "placeholder"}},
        }
        changed = True
elif action == "ensure-plugin-options":
    base_url = arg
    plugins = cfg.setdefault("plugins", [])
    for entry in plugins:
        if isinstance(entry, str) and "opencode-litellm-plugin" in entry:
            idx = plugins.index(entry)
            plugins[idx] = {"package": entry, "options": {"baseURL": base_url}}
            changed = True
        elif isinstance(entry, dict) and "opencode-litellm-plugin" in str(entry.get("package", "")):
            opts = entry.setdefault("options", {})
            if opts.get("baseURL") != base_url:
                opts["baseURL"] = base_url
                changed = True
elif action == "has-plugin":
    plugins = cfg.get("plugins", []) or []
    for entry in plugins:
        if isinstance(entry, str) and "opencode-litellm-plugin" in entry:
            print("yes"); sys.exit(0)
        if isinstance(entry, dict) and "opencode-litellm-plugin" in str(entry.get("package", "")):
            print("yes"); sys.exit(0)
    print("no"); sys.exit(0)
if changed or action == "has-plugin":
    with open(config_path, "w") as f:
        json.dump(cfg, f, indent=2)
        f.write("\n")
PYEOF
  else
    echo "ERROR: python3 is required by the installer but was not found." >&2
    echo "Install the plugin manually with: opencode2 plugin add $PLUGIN_SPEC" >&2
    echo "and add the providers.litellm block from the README to $CONFIG_FILE" >&2
    exit 1
  fi
}

echo "==> Installing opencode-litellm-plugin"

# 1. Install the plugin via the official command (skip if already present)
if [ "$(json_edit "$CONFIG_FILE" has-plugin -)" = "no" ]; then
  opencode2 plugin add "$PLUGIN_SPEC"
else
  echo "==> Plugin entry already present in config (skipping plugin add)"
fi

# 2. Add the providers.litellm block (creates the /connect integration)
json_edit "$CONFIG_FILE" add-provider -

# 3. Apply the proxy URL, if provided
if [ -n "${LITELLM_BASE_URL:-}" ]; then
  json_edit "$CONFIG_FILE" ensure-plugin-options "$LITELLM_BASE_URL"
  echo "==> Proxy URL set to: $LITELLM_BASE_URL"
fi

echo ""
echo "Installed. Next steps:"
echo ""
echo "  1. Connect your LiteLLM API key:"
echo ""
echo "       opencode auth login"
echo ""
echo "     (pick LiteLLM and paste the key)"
echo ""
if [ -z "${LITELLM_BASE_URL:-}" ]; then
  echo "  2. If your proxy is not at http://127.0.0.1:4000/v1, set the URL:"
  echo ""
  echo '       In '"$CONFIG_FILE"' change the plugins entry to:'
  echo '       { "package": "'"$PLUGIN_SPEC"'", "options": { "baseURL": "https://your-proxy/v1" } }'
  echo ""
fi
echo "  Restart OpenCode if it is running, then pick a litellm/* model."
echo "  The provider becomes visible in /models once your key is connected"
echo "  and the first models are discovered."