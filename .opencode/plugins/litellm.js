import { homedir, userInfo } from "node:os"
import { appendFileSync, statSync, renameSync, unlinkSync } from "node:fs"

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
 *   exclude         Substring filter for model IDs to skip. Empty by
 *                   default — empty excludes nothing, so all models the
 *                   proxy serves are listed (e.g. set ":" to hide prefixed
 *                   variants such as "hakan:glm-5.3")
 *   apiKey          Hardcoded API key (normally not needed)
 *   providerID      Provider/integration ID (default "litellm")
 *   name            Display name (default "LiteLLM")
 *
 * With no options at all, every default above applies.
 *
 * Diagnostics: every sync is logged to
 *   ~/.local/share/opencode/litellm-plugin.log
 * (set LITELLM_PLUGIN_DEBUG to log to a custom path instead).
 */

const VERSION = "1.3.0"

const DEFAULTS = {
  providerID: "litellm",
  name: "LiteLLM",
  baseURL: "http://127.0.0.1:4000/v1",
  customerID: undefined,
  sessionHeader: true,
  refreshMinutes: 5,
  exclude: "",
  apiKey: undefined,
}

function osUsername() {
  try {
    const name = userInfo().username
    if (name) return name
  } catch {}
  return process.env.USER || process.env.USERNAME || undefined
}

function dataDir() {
  // os.homedir() resolves $HOME on Unix and USERPROFILE on Windows —
  // unlike process.env.HOME, which can hold a bogus MSYS-style path
  // on Windows and silently break file logging.
  return `${homedir()}/.local/share/opencode`
}
const LOG_FILE = process.env.LITELLM_PLUGIN_DEBUG
  ? (process.env.LITELLM_PLUGIN_DEBUG === "1"
      ? `${dataDir()}/litellm-plugin.log`
      : process.env.LITELLM_PLUGIN_DEBUG)
  : `${dataDir()}/litellm-plugin.log`

function log(message) {
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`)
  } catch {}
}

// Keep the log from growing without bound: rotate once when it passes 256 KB.
let logRotated = false
function rotateLogIfNeeded() {
  try {
    if (logRotated) return
    logRotated = true
    if (statSync(LOG_FILE).size > 256 * 1024) {
      try {
        unlinkSync(`${LOG_FILE}.old`)
      } catch {}
      renameSync(LOG_FILE, `${LOG_FILE}.old`)
    }
  } catch {}
}

export default {
  id: "litellm",
  async setup(ctx) {
    const options = { ...DEFAULTS, ...(ctx.options || {}) }
    options.customerID ??= osUsername()
    const providerID = options.providerID

    rotateLogIfNeeded()
    log(`litellm plugin v${VERSION} loaded (providerID=${providerID}, baseURL=${options.baseURL})`)

    // Mutable state captured by the catalog transform. sync() updates it
    // and triggers a reload so the transform replays with fresh values.
    let baseURL = options.baseURL
    let apiKey = options.apiKey || process.env.LITELLM_API_KEY
    let keySource = options.apiKey
      ? "options.apiKey"
      : process.env.LITELLM_API_KEY
        ? "LITELLM_API_KEY env"
        : "none"
    let models = []

    async function resolveCredential() {
      try {
        const connection = await ctx.integration.connection.active(providerID)
        if (!connection) return undefined
        const credential = await ctx.integration.connection.resolve(connection)
        if (credential && credential.type === "key") {
          return { key: credential.key, source: "auth login credential" }
        }
        return undefined
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
      const credential = await resolveCredential()
      if (credential) {
        apiKey = credential.key
        keySource = credential.source
      }
      if (options.apiKey) {
        apiKey = options.apiKey
        keySource = "options.apiKey"
      }
      const why = reason || "startup"

      if (!apiKey) {
        log(
          `sync (${why}): no API key found — models NOT fetched. Fix one of: ` +
            `run "opencode2 auth login" and pick LiteLLM, ` +
            `or set options.apiKey, or export LITELLM_API_KEY`,
        )
        await ctx.catalog.reload()
        return
      }

      log(`sync (${why}): key from ${keySource}, baseURL=${baseURL}`)
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
            .filter((id) => !options.exclude || !id.includes(options.exclude))
          const added = discovered.filter((id) => !models.includes(id))
          const removed = models.filter((id) => !discovered.includes(id))
          models = discovered
          log(
            `sync (${why}): ${discovered.length} models (+${added.length} new, -${removed.length} gone)`,
          )
        } else {
          const hint =
            res.status === 401 || res.status === 403
              ? " — key rejected: check it is a valid LiteLLM proxy key"
              : ""
          log(`sync (${why}): GET ${baseURL}/models -> ${res.status} ${res.statusText}${hint}`)
          // keep the previous model list
        }
      } catch (error) {
        const message = error && error.message ? error.message : String(error)
        log(
          `sync (${why}): fetch failed: ${message} — is the proxy reachable at ${baseURL}?`,
        )
        // network failures keep the previous model list
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
            log("event: session.created -> sync")
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