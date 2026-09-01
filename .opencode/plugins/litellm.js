import { userInfo } from "node:os"
import { appendFileSync } from "node:fs"

/**
 * OpenCode V2 plugin: LiteLLM proxy integration.
 *
 * Responsibilities:
 *  - Auto-discovers models from the proxy's /models endpoint and
 *    registers them on the "litellm" provider.
 *  - Keeps the provider catalog entry (baseURL, apiKey, headers) in sync
 *    with the effective configuration.
 *  - Adds an x-litellm-session-id header to every LiteLLM request.
 *  - Re-syncs every `refreshMinutes` so models added on the proxy
 *    appear automatically.
 *
 * API key resolution order:
 *   1. The /connect credential (via `opencode2 auth login` / TUI)
 *   2. options.apiKey (hardcoded)
 *   3. LITELLM_API_KEY environment variable
 *
 * Base URL resolution order:
 *   1. options.baseURL
 *   2. http://127.0.0.1:4000/v1 (LiteLLM proxy default port)
 *
 * Options (in the opencode.json "plugins" entry):
 *   baseURL         Proxy base URL (default http://127.0.0.1:4000/v1)
 *   customerID      Value for the x-litellm-customer-id header
 *                   (default: current OS username, falls back to $USER/$USERNAME)
 *   sessionHeader   Send x-litellm-session-id header (default true)
 *   refreshMinutes  How often to re-sync the model list (default 5)
 *   exclude         Substring filter for model IDs to skip (default ":")
 *   apiKey          Hardcoded API key (normally not needed)
 *   providerID      Provider/integration ID (default "litellm")
 *   name            Display name (default "LiteLLM")
 *
 * With no options at all, every default above applies.
 */

const DEFAULTS = {
  providerID: "litellm",
  name: "LiteLLM",
  baseURL: "http://127.0.0.1:4000/v1",
  customerID: undefined,
  sessionHeader: true,
  refreshMinutes: 5,
  exclude: ":",
  apiKey: undefined,
}

function osUsername() {
  try {
    const name = userInfo().username
    if (name) return name
  } catch {}
  return process.env.USER || process.env.USERNAME || undefined
}

const DEBUG_FILE = process.env.LITELLM_PLUGIN_DEBUG
  ? (process.env.LITELLM_PLUGIN_DEBUG === "1"
      ? `${process.env.HOME || process.env.USERPROFILE || "."}/.local/share/opencode/litellm-plugin-debug.log`
      : process.env.LITELLM_PLUGIN_DEBUG)
  : undefined
function debug(message) {
  if (!DEBUG_FILE) return
  try {
    appendFileSync(DEBUG_FILE, `${new Date().toISOString()} ${message}\n`)
  } catch {}
}

export default {
  id: "litellm",
  async setup(ctx) {
    const options = { ...DEFAULTS, ...(ctx.options || {}) }
    options.customerID ??= osUsername()
    const providerID = options.providerID

    // Mutable state captured by the catalog transform. sync() updates it
    // and triggers a reload so the transform replays with fresh values.
    let baseURL = options.baseURL
    let apiKey = options.apiKey || process.env.LITELLM_API_KEY
    let models = []

    async function resolveCredential() {
      try {
        const connection = await ctx.integration.connection.active(providerID)
        if (!connection) return undefined
        const credential = await ctx.integration.connection.resolve(connection)
        return credential && credential.type === "key" ? credential.key : undefined
      } catch {
        return undefined
      }
    }

    // Registered once; replayed on every catalog reload.
    await ctx.catalog.transform((catalog) => {
      catalog.provider.update(providerID, (provider) => {
        provider.name = options.name
        if (!provider.package) provider.package = "@opencode-ai/ai/providers/openai-compatible"
        if (!provider.settings) provider.settings = {}
        provider.settings.baseURL = baseURL
        if (apiKey) provider.settings.apiKey = apiKey
        if (options.customerID) {
          if (!provider.headers) provider.headers = {}
          provider.headers["x-litellm-customer-id"] = options.customerID
        }
      })
      for (const id of models) {
        catalog.model.update(providerID, id, (model) => {
          model.name = id
        })
      }
      // Drop the installer's placeholder seed once real models exist
      if (models.length > 0) catalog.model.remove(providerID, "placeholder")
    })

    async function sync(reason) {
      const credentialKey = await resolveCredential()
      if (credentialKey) apiKey = credentialKey
      if (options.apiKey) apiKey = options.apiKey
      debug(`sync (${reason || "startup"}): key=${apiKey ? "set" : "unset"} baseURL=${baseURL}`)

      if (apiKey) {
        try {
          const res = await fetch(`${baseURL.replace(/\/$/, "")}/models`, {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              ...(options.customerID
                ? { "x-litellm-customer-id": options.customerID }
                : {}),
            },
            signal: AbortSignal.timeout(15_000),
          })
          if (res.ok) {
            const json = await res.json()
            const data = Array.isArray(json && json.data) ? json.data : []
            const discovered = data
              .map((m) => (m ? m.id : undefined))
              .filter((id) => typeof id === "string" && !!id)
              .filter((id) => !id.includes(options.exclude))
            const added = discovered.filter((id) => !models.includes(id))
            const removed = models.filter((id) => !discovered.includes(id))
            models = discovered
            debug(`sync (${reason || "startup"}): ${discovered.length} models (+${added.length} new, -${removed.length} gone)`)
          }
        } catch {
          debug(`sync (${reason || "startup"}): fetch failed`)
          // network failures keep the previous model list
        }
      }

      await ctx.catalog.reload()
    }

    await sync("startup")

    if (options.sessionHeader) {
      await ctx.session.hook(
        "model.request",
        (event) => {
          event.headers["x-litellm-session-id"] = event.sessionID
        },
        { providerID },
      )
    }

    // Refresh when a new session starts (covers "opening OpenCode" against
    // an already-running service). Throttled to at most once per 30 seconds.
    const controller = new AbortController()
    let lastSyncAt = Date.now()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (
            event &&
            event.type === "session.created" &&
            Date.now() - lastSyncAt >= 30_000
          ) {
            lastSyncAt = Date.now()
            debug("event: session.created -> sync")
            void sync("session.created").catch(() => {})
          }
        }
      } catch {
        // stream closed
      }
    })()

    const timer = setInterval(
      () => {
        void sync("timer").catch(() => {})
      },
      Math.max(1, options.refreshMinutes) * 60_000,
    )

    return () => {
      clearInterval(timer)
      controller.abort()
    }
  },
}