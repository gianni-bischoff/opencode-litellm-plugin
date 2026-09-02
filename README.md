# opencode-litellm-plugin

An [OpenCode 2](https://opencode.ai/v2/docs/) plugin for [LiteLLM](https://docs.litellm.ai/) proxies.

It gives you a fully wired `litellm` provider with:

- **Automatic model discovery** — fetches `/models` from your proxy at
  startup and re-syncs every 5 minutes, so models added on the proxy
  appear in `/models` automatically (no manual model lists).
- **Provider wiring** — keeps the provider's `baseURL`, API key and
  `x-litellm-customer-id` header in sync with your `/connect` credential
  and options.
- **Session tracking** — sends an `x-litellm-session-id` header on every
  LiteLLM request so per-session spend shows up in the LiteLLM UI.

## Requirements

- OpenCode 2 (`opencode2`) — this is a V2 plugin, it does not work on V1.
- A reachable LiteLLM proxy (OpenAI-compatible endpoints, default port 4000).

## Install

One command (Linux/macOS/WSL):

```bash
curl -fsSL "https://raw.githubusercontent.com/gianni-bischoff/opencode-litellm-plugin/main/install.sh?t=$(date +%s)" | bash
```

If your proxy is not at the default `http://127.0.0.1:4000/v1`, pass its URL
**as an argument** (env vars on the `curl` side of a pipe do not reach `bash`):

```bash
curl -fsSL "https://raw.githubusercontent.com/gianni-bischoff/opencode-litellm-plugin/main/install.sh?t=$(date +%s)" \
  | bash -s -- https://litellm.example.com/v1
```

The `?t=$(date +%s)` parameter only busts raw.githubusercontent's ~5-minute
CDN cache so you always get the latest script.

The installer runs `opencode2 plugin add`, adds the required
`providers.litellm` block to your global config, applies the proxy URL, and
clears previously cached copies of the plugin package — so **re-running it
also updates the plugin to the latest version**.

Then connect your key:

```bash
opencode2 auth login
```

Pick **LiteLLM** and paste your LiteLLM proxy key. After a restart the plugin
discovers your models automatically.

> **The LiteLLM provider only appears in `/models` once a key is connected
> and at least one model has been discovered.** No key → no models → no
> visible provider.

### Manual install (any OS)

```bash
opencode2 plugin add git+https://github.com/gianni-bischoff/opencode-litellm-plugin.git
```

Then add this block to `~/.config/opencode/opencode.json` (or
`opencode.jsonc`) yourself — it registers the provider and makes LiteLLM
appear in `/connect` / `opencode2 auth login`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "git+https://github.com/gianni-bischoff/opencode-litellm-plugin.git",
      "options": {
        "baseURL": "https://litellm.example.com/v1",
        "customerID": "my-team-id"
      }
    }
  ]
}
```

You also need a provider entry so OpenCode knows which package to use for
requests (the plugin keeps its settings updated at runtime):

```jsonc
{
  "providers": {
    "litellm": {
      "name": "LiteLLM",
      "env": ["LITELLM_API_KEY"],
      "package": "@opencode-ai/ai/providers/openai-compatible"
    }
  }
}
```

No `models` block is needed — the plugin adds the discovered models
automatically. The `env` field is what makes LiteLLM appear in
`/connect` and `opencode2 auth login`.

## How the proxy URL is resolved

The plugin talks to `options.baseURL`, which defaults to
`http://127.0.0.1:4000/v1` (LiteLLM's default port). If your proxy runs
elsewhere and you did not use `LITELLM_BASE_URL` with the installer, edit
the `plugins` entry in `~/.config/opencode/opencode.json` to pass options:

## Options

| Option           | Default                        | Description                                                        |
| ---------------- | ------------------------------ | ------------------------------------------------------------------ |
| `baseURL`        | `http://127.0.0.1:4000/v1`     | LiteLLM proxy OpenAI-compatible endpoint                          |
| `customerID`    | current OS username            | Value sent as `x-litellm-customer-id` header for spend attribution  |
| `sessionHeader`  | `true`                         | Send `x-litellm-session-id` on every request                      |
| `refreshMinutes` | `5`                            | Interval between model-list refreshes                             |
| `exclude`        | `""` (empty)                   | Skip model IDs containing this substring. Empty excludes nothing — all models are listed (e.g. `":"` hides prefixed variants like `team:glm-5.2`) |
| `apiKey`         | —                              | Hardcoded API key (prefer `/connect` or the env var instead)      |
| `providerID`     | `"litellm"`                    | Provider/integration ID                                           |
| `name`           | `"LiteLLM"`                    | Display name                                                      |

With no options at all, every default applies.

## API key resolution order

1. The `/connect` credential (`opencode2 auth login` → LiteLLM)
2. `options.apiKey`
3. The `LITELLM_API_KEY` environment variable

## Model refreshing

Models are re-synced from the proxy:

- at service start,
- whenever a **new session starts** (opening OpenCode against a
  already-running service), throttled to at most once per 30 seconds,
- every `refreshMinutes` (default 5) as a fallback.

Each sync also re-resolves the `/connect` credential, so a freshly
connected key is picked up without a restart.

Set `LITELLM_PLUGIN_DEBUG=/path/to/file` in the service environment to log
to a custom path instead.

## Troubleshooting

No `litellm/*` models showing? Every sync is logged to
`~/.local/share/opencode/litellm-plugin.log` — check the last lines:

```bash
tail -20 ~/.local/share/opencode/litellm-plugin.log
```

| Log line | Cause | Fix |
|---|---|---|
| `no API key found` | No key connected | `opencode2 auth login` → pick **LiteLLM** → paste key, then restart |
| `GET .../models -> 401` / `403` | Key rejected (wrong/expired) | Reconnect a valid proxy key via `opencode2 auth login` |
| `fetch failed: ...` | Proxy unreachable | Check `options.baseURL`; for Tailscale proxies make sure the machine is on the tailnet |
| no log lines at all | Plugin not loaded | `opencode2 api get /api/plugin` must show `litellm` active — restart after install |

Quick reachability test from that machine (with your proxy key):

```bash
curl -s https://your-proxy.example.com/v1/models \
  -H "Authorization: Bearer sk-..." | head -c 300
```

## Budget display ($ spent / $ limit)

If your LiteLLM key has a budget window (e.g. a $100/day cap on the key),
the plugin shows it **live in the OpenCode status line** — but only while
the active session is running a `litellm/*` model:

```
~ $45.82 / $100.00 · 11h 47m
```

- **$spent / $limit** of the current window, plus **time until reset**
- color-coded: green < 60%, yellow 60–85%, red ≥ 85%
- a warning toast once per window when spending crosses 90%
- hidden on the home screen and whenever another provider is active

Requirements on the proxy side — grant the key two routes:

1. `/model/info` — model prices and context limits (see above)
2. `/key/info` — the key's budget: spend, limit, reset time

Both are management routes; add them to the key's `routes` list (Admin UI
→ Keys → Edit → Routes) or via `/key/update`. The plugin logs a hint if a
route is missing. The value refreshes on every sync (new sessions and a
5-minute timer), pushed to all running OpenCode windows.

How it works: the server plugin (`.opencode/plugins/litellm.js`) reads
`/key/info` on every sync and publishes the budget over OpenCode's plugin
RPC (method `budget` + event `budget`). The TUI widget (`tui.tsx`, same
package, loaded automatically) fetches it on startup and live-updates.
No plugin options are needed. To hide the widget, disable the plugin id
`litellm-budget` in `tui.json`:

```jsonc
{ "plugin_enabled": { "litellm-budget": false } }
```

## Session cost & pricing

OpenCode computes session costs from per-token model prices — with none set,
`litellm/*` models show `$0.00` in `opencode2 stats --cost --models`. This
plugin fills in prices from two sources:

1. **Automatic — read from the proxy.** Every sync calls LiteLLM's
   `/model/info` route and applies `input_cost_per_token`,
   `output_cost_per_token`, cache costs, and context/output limits.
   Regular virtual keys are usually restricted to `llm_api_routes`, so
   grant your key the `/model/info` route on the proxy (Admin UI → Keys →
   Edit → Routes, or the key's `routes` list), or set a dedicated
   `infoKey` option:

   ```jsonc
   {
     "package": "git+https://github.com/gianni-bischoff/opencode-litellm-plugin.git",
     "options": {
       "baseURL": "https://your-proxy/v1",
       "infoKey": "sk-key-allowed-model-info"
     }
   }
   ```

2. **Manual `pricing` option** — USD per 1M tokens, used when the proxy
   can't be read or to override it. Explicit per-model prices beat the
   proxy's values; `"*"` fills any model with neither:

   ```jsonc
   "options": {
     "pricing": {
       "glm-5.2": { "input": 0.6, "output": 2.2, "cacheRead": 0.1 },
       "*":       { "input": 1,   "output": 4 }
     }
   }
   ```

After prices are in place, check them with:

```bash
opencode2 stats --cost --models
```

## Notes

- The customer ID default changed value in v1.0.0: your OS username is used
  unless you set `customerID` explicitly. If your LiteLLM proxy routes or
  budgets by customer ID, make sure a matching member exists (LiteLLM
  auto-creates unknown customer IDs by default).
- `exclude: ":"` filters out colon-prefixed model IDs (e.g. `team:glm-5.2`
  aliases) so only the canonical names appear. The default is empty (no
  filtering) since v1.3.0.

## License

[MIT](./LICENSE)