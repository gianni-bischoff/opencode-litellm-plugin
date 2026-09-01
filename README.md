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
curl -fsSL https://raw.githubusercontent.com/gianni-bischoff/opencode-litellm-plugin/main/install.sh | bash
```

If your proxy is not at the default `http://127.0.0.1:4000/v1`, pass its URL:

```bash
LITELLM_BASE_URL=https://litellm.example.com/v1 \
  curl -fsSL https://raw.githubusercontent.com/gianni-bischoff/opencode-litellm-plugin/main/install.sh | bash
```

The installer runs `opencode2 plugin add`, adds the required
`providers.litellm` block to your global config, and applies the proxy URL.

Then connect your key:

```bash
opencode auth login
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
appear in `/connect` / `opencode auth login`:

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
`/connect` and `opencode auth login`.

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
| `exclude`        | `":"`                          | Skip model IDs containing this substring (e.g. prefixed variants) |
| `apiKey`         | —                              | Hardcoded API key (prefer `/connect` or the env var instead)      |
| `providerID`     | `"litellm"`                    | Provider/integration ID                                           |
| `name`           | `"LiteLLM"`                    | Display name                                                      |

With no options at all, every default applies.

## API key resolution order

1. The `/connect` credential (`opencode auth login` → LiteLLM)
2. `options.apiKey`
3. The `LITELLM_API_KEY` environment variable

## Notes

- The customer ID default changed value in v1.0.0: your OS username is used
  unless you set `customerID` explicitly. If your LiteLLM proxy routes or
  budgets by customer ID, make sure a matching member exists (LiteLLM
  auto-creates unknown customer IDs by default).
- `exclude: ":"` filters out colon-prefixed model IDs (e.g. `team:glm-5.2`
  aliases) so only the canonical names appear.

## License

[MIT](./LICENSE)