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
# With a proxy URL (pass it as an argument — env vars on the curl side of a
# pipe do NOT reach bash):
#
#   curl -fsSL https://raw.githubusercontent.com/gianni-bischoff/opencode-litellm-plugin/main/install.sh \
#     | bash -s -- https://your-proxy.example.com/v1
#
# (LITELLM_BASE_URL is still honored as a fallback.)
set -euo pipefail

PLUGIN_SPEC="git+https://github.com/gianni-bischoff/opencode-litellm-plugin.git"
# Proxy URL: first script argument, else LITELLM_BASE_URL, else unset
PROXY_URL="${1:-${LITELLM_BASE_URL:-}}"
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
import json, sys, os
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
            "package": "@opencode/ai/providers/openai-compatible",
        }
        changed = True
elif action == "apply-plugin-options":
    base_url = arg
    opts = {"baseURL": base_url} if base_url else {}
    # Same options on both config keys:
    #   - "plugins": object entries (V2-style catalog on every build)
    #   - "plugin":  tuple entries released OpenCode 2.x uses for the
    #                session runtime; the tuple points at the hooks
    #                file (the V1 function-form entrypoint seeded by
    #                ensure-hooks-tuple).
    plugins = cfg.get("plugins", []) or []
    for entry in plugins:
        if isinstance(entry, str) and "opencode-litellm-plugin" in entry:
            idx = plugins.index(entry)
            plugins[idx] = {"package": entry, "options": opts or {"baseURL": "http://127.0.0.1:4000/v1"}}
            changed = True
        elif isinstance(entry, dict) and "opencode-litellm-plugin" in str(entry.get("package", "")):
            entry.setdefault("options", {}).update(opts)
            changed = True
    for entry in (cfg.get("plugin", []) or []):
        if isinstance(entry, list) and "opencode-litellm-plugin" in str(entry[0]):
            entry[1] = dict(entry[1] or {})
            entry[1].update(opts)
            changed = True
elif action == "normalize-plugin-entries":
    # Keep the litellm package entry under the plural "plugins" key (both
    # generations process it) and keep ONLY the hooks tuple under the
    # singular "plugin" key, so the strict V1 loader (released OpenCode
    # 2.x) never trips over the {id, setup}-shaped package entry.
    kept = []
    mutated = False
    for entry in (cfg.get("plugin", []) or []):
        if isinstance(entry, dict) and "opencode-litellm-plugin" in str(entry.get("package", "")):
            mutated = True
            plugins = cfg.setdefault("plugins", [])
            if entry not in plugins and not any(
                isinstance(e, dict) and e.get("package") == entry.get("package") for e in plugins
            ):
                plugins.append(entry)
        elif isinstance(entry, str) and "opencode-litellm-plugin" in entry:
            mutated = True
            plugins = cfg.setdefault("plugins", [])
            if entry not in plugins and not any(
                isinstance(e, dict) and e.get("package") == entry for e in plugins
            ):
                plugins.append(entry)
        else:
            kept.append(entry)
    if mutated:
        if kept:
            cfg["plugin"] = kept
        else:
            cfg.pop("plugin", None)
        changed = True
elif action == "has-plugin":
    for entry in (cfg.get("plugins", []) or []):
        if isinstance(entry, str) and "opencode-litellm-plugin" in entry:
            print("yes"); sys.exit(0)
        if isinstance(entry, dict) and "opencode-litellm-plugin" in str(entry.get("package", "")):
            print("yes"); sys.exit(0)
    print("no"); sys.exit(0)
elif action == "ensure-hooks-tuple":
    # Seed the V1 hooks entrypoint (released OpenCode 2.x session
    # runtime). Copies the hooks file to a stable location in the config
    # dir so the tuple survives plugin cache refreshes.
    import glob as _glob, shutil as _shutil
    hooks_dir = os.path.join(os.path.dirname(config_path), "hooks")
    pkg = None
    for pat in (
        f"{os.environ.get('XDG_CONFIG_HOME', os.path.expanduser('~/.config'))}/opencode/node_modules/opencode-litellm-plugin",
        f"{os.environ.get('XDG_CACHE_HOME', os.path.expanduser('~/.cache'))}/opencode/packages/git-*/node_modules/opencode-litellm-plugin",
        f"{os.environ.get('XDG_CACHE_HOME', os.path.expanduser('~/.cache'))}/opencode/packages/git-*",
        f"{os.environ.get('XDG_CACHE_HOME', os.path.expanduser('~/.cache'))}/opencode/npm/git-opencode-litellm-plugin*/opencode-litellm-plugin",
        f"{os.environ.get('XDG_CACHE_HOME', os.path.expanduser('~/.cache'))}/opencode/npm/git-opencode-litellm-plugin*",
    ):
        for d in sorted(_glob.glob(pat)):
            if os.path.isdir(os.path.join(d, ".opencode", "plugins")):
                pkg = d
                break
        if pkg:
            break
    hooks = os.path.join(pkg, ".opencode", "plugins", "litellm-hooks.js") if pkg else None
    core = os.path.join(pkg, ".opencode", "plugins", "litellm-core.js") if pkg else None
    old = [e for e in (cfg.get("plugin", []) or [])
           if isinstance(e, list) and "opencode-litellm-plugin" in str(e[0])]
    if hooks and core and os.path.isfile(hooks):
        os.makedirs(hooks_dir, exist_ok=True)
        _shutil.copyfile(hooks, os.path.join(hooks_dir, "litellm-hooks.js"))
        _shutil.copyfile(core, os.path.join(hooks_dir, "litellm-core.js"))
        entry = [os.path.join(hooks_dir, "litellm-hooks.js"), {"baseURL": arg} if arg else {}]
        rest = [e for e in (cfg.get("plugin", []) or []) if e not in old]
        cfg["plugin"] = [entry] + rest
        changed = True
    elif old:
        # hooks file no longer exists — clean the stale entry up
        cfg["plugin"] = [e for e in (cfg.get("plugin", []) or []) if e not in old]
        changed = True
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

# 3. Apply the proxy URL, if provided (to both config keys) and normalize
#    the plugin entries across config generations.
json_edit "$CONFIG_FILE" normalize-plugin-entries -
if [ -n "$PROXY_URL" ]; then
  json_edit "$CONFIG_FILE" apply-plugin-options "$PROXY_URL"
  echo "==> Proxy URL set to: $PROXY_URL"
fi

# 4. Seed the V1 hooks entrypoint (function form) so released OpenCode 2.x
#    builds can hand the discovered models to the session runtime. Needs
#    the installed package on disk; when it is not locatable this is a
#    no-op (set LITELLM_BASE_URL instead — the hooks entrypoint reads it).
HOOKS_URL_ARG="${PROXY_URL:-${LITELLM_BASE_URL:-}}"
json_edit "$CONFIG_FILE" ensure-hooks-tuple "$HOOKS_URL_ARG"

# 5. Clear cached copies of this package so the next start fetches the
#    latest version (makes re-running this installer act as an update).
#    Handles both cache layouts: the original packages/git-*/ and the
#    newer npm/git-<name>-<hash>/ scheme used by recent opencode2 builds.
#    Note: the cache is cleared BEFORE the plugin add below would run —
#    but the hooks entrypoint copies to a stable location, so it is done
#    here at the end (the runtime re-installs at the next start).
CACHE_BASE="${XDG_CACHE_HOME:-$HOME/.cache}/opencode"
if [ -d "$CACHE_BASE/packages" ]; then
  for d in "$CACHE_BASE"/packages/git-*/; do
    [ -d "$d/node_modules/opencode-litellm-plugin" ] || continue
    rm -rf "$d"
    echo "==> Cleared cached package copy (packages layout)"
  done
fi
if [ -d "$CACHE_BASE/npm" ]; then
  for d in "$CACHE_BASE"/npm/git-opencode-litellm-plugin-*/; do
    [ -d "$d" ] || continue
    rm -rf "$d"
    echo "==> Cleared cached package copy (npm layout)"
  done
fi

echo ""
echo "Installed. Next steps:"
echo ""
echo "  1. Connect your LiteLLM API key:"
echo ""
echo "       opencode2 auth login"
echo ""
echo "     (pick LiteLLM and paste the key)"
echo ""
if [ -z "$PROXY_URL" ]; then
  echo "  2. If your proxy is not at http://127.0.0.1:4000/v1, set the URL:"
  echo ""
  echo '       In '"$CONFIG_FILE"' change the plugins entry to:'
  echo '       { "package": "'"$PLUGIN_SPEC"'", "options": { "baseURL": "https://your-proxy/v1" } }'
  echo ""
  echo "  3. Restart the service if OpenCode is running:"
else
  echo "  2. Restart the service if OpenCode is running:"
fi
echo ""
echo "       opencode2 service restart"
echo ""
echo "  Then pick a litellm/* model. The provider becomes visible in /models"
echo "  once your key is connected and the first models are discovered."
echo ""
echo "  If no models appear, check the plugin log:"
echo ""
echo "       tail -20 ~/.local/share/opencode/litellm-plugin.log"