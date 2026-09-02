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
 *   pricing         Optional manual prices in USD per 1M tokens — used as a
 *                   fallback for models whose price could not be read from
 *                   the proxy, or as an explicit override:
 *                     { "glm-5.2": { "input": 0.6, "output": 2.2 },
 *                       "*":      { "input": 1,  "output": 4 } }
 *                   Optional "cacheRead"/"cacheWrite" (per 1M tokens).
 *   infoKey         Optional separate key allowed the /model/info route.
 *                   When set (or when the main key can call it), per-token
 *                   prices and context limits are read from the proxy
 *                   automatically and power session costs
 *                   (`opencode2 stats --cost`).
 *
 * Budget display: when the key is also allowed the /key/info route, the
 * plugin reads the LiteLLM key budget (e.g. $100/day) on every sync and
 * publishes it over plugin RPC (method "budget", event "budget"). The
 * TUI widget in ./tui.tsx (same package) renders "$spent / $limit · time
 * left" in the status line, color-coded, with a warning toast at 90%.
 *
 * With no options at all, every default above applies.
 *
 * Diagnostics: every sync is logged to
 *   ~/.local/share/opencode/litellm-plugin.log
 * (set LITELLM_PLUGIN_DEBUG to log to a custom path instead).
 */

const VERSION = "1.5.1"

const DEFAULTS = {
  providerID: "litellm",
  name: "LiteLLM",
  baseURL: "http://127.0.0.1:4000/v1",
  customerID: undefined,
  sessionHeader: true,
  refreshMinutes: 5,
  exclude: "",
  apiKey: undefined,
  pricing: undefined,
  infoKey: undefined,
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

    // ------------------------------------------------------------------
    // Pricing + limits
    //
    // Two sources, merged per model:
    //   1. Manual `options.pricing` — USD per 1M tokens (human-friendly)
    //   2. Auto-discovered from the proxy's /model/info route — USD per
    //      token + context limits. Requires the key to be allowed that
    //      route (regular virtual keys often only get llm_api_routes;
    //      an optional `options.infoKey` can supply a dedicated key).
    // Precedence: explicit per-model user price > proxy price > "*" entry.
    // ------------------------------------------------------------------
    let autoInfo = new Map() // model id -> { input?, output?, cacheRead?, cacheWrite?, context?, outputLimit? } (per-token USD)

    // ModelCost in OpenCode's catalog is USD per 1M tokens (e.g.
    // input 0.3 == $0.30 per million) — keep everything in that unit.
    function userCostFor(id, wildcard = false) {
      const pricing = options.pricing
      if (!pricing || typeof pricing !== "object") return undefined
      const entry = wildcard ? pricing["*"] : pricing[id]
      if (!entry || typeof entry !== "object") return undefined
      const perMillion = (value) => {
        const n = Number(value)
        return Number.isFinite(n) && n >= 0 ? n : undefined
      }
      const input = perMillion(entry.input)
      const output = perMillion(entry.output)
      if (input === undefined && output === undefined) return undefined
      return {
        input: input ?? 0,
        output: output ?? 0,
        cache: {
          read: perMillion(entry.cacheRead) ?? 0,
          write: perMillion(entry.cacheWrite) ?? 0,
        },
      }
    }

    function costFor(id) {
      const user = userCostFor(id)
      if (user) return user
      const auto = autoInfo.get(id)
      if (auto && (auto.input !== undefined || auto.output !== undefined)) {
        return {
          input: auto.input ?? 0,
          output: auto.output ?? 0,
          cache: {
            read: auto.cacheRead ?? 0,
            write: auto.cacheWrite ?? 0,
          },
        }
      }
      return userCostFor(id, true)
    }

    async function fetchModelInfo(reason) {
      const key = options.infoKey || apiKey
      if (!key) return
      // LiteLLM management routes live at the proxy root, not under the
      // OpenAI /v1 prefix — strip a trailing "/v1" from baseURL. The raw
      // baseURL is tried as a fallback for exotic mounts.
      const candidates = [...new Set([baseURL.replace(/\/v1\/?$/, ""), baseURL])].map(
        (b) => `${b.replace(/\/$/, "")}/model/info`,
      )

      const headers = {
        Authorization: `Bearer ${key}`,
        ...(options.customerID
          ? { "x-litellm-customer-id": options.customerID }
          : {}),
      }

      let rejected = false
      for (const url of candidates) {
        try {
          const res = await fetch(url, {
            headers,
            signal: AbortSignal.timeout(15_000),
          })
          if (res.ok) {
            const json = await res.json()
            const data = Array.isArray(json && json.data) ? json.data : []
            const next = new Map()
            for (const item of data) {
              if (!item || typeof item !== "object") continue
              const info =
                item.model_info && typeof item.model_info === "object"
                  ? item.model_info
                  : item
              const id = item.model_name || info.key || info.id
              if (typeof id !== "string" || !id) continue
              const num = (value) => {
                const n = Number(value)
                return Number.isFinite(n) && n >= 0 ? n : undefined
              }
              // LiteLLM reports per-token costs; OpenCode wants per 1M.
              const perMillion = (value) => {
                const n = num(value)
                return n === undefined ? undefined : n * 1_000_000
              }
              const entry = {
                input: perMillion(info.input_cost_per_token),
                output: perMillion(info.output_cost_per_token),
                cacheRead: perMillion(info.cache_read_input_token_cost),
                cacheWrite: perMillion(info.cache_creation_input_token_cost),
                context: num(info.max_input_tokens) ?? num(info.max_tokens),
                outputLimit: num(info.max_output_tokens),
              }
              if (
                entry.input !== undefined ||
                entry.output !== undefined ||
                entry.context !== undefined ||
                entry.outputLimit !== undefined
              ) {
                next.set(id, entry)
              }
            }
            autoInfo = next
            log(`sync (${reason}): pricing/limits for ${next.size} models from ${url}`)
            return
          }
          if (res.status === 401 || res.status === 403) {
            rejected = true
            continue
          }
          log(`sync (${reason}): GET ${url} -> ${res.status} ${res.statusText}`)
          return
        } catch (error) {
          const message = error && error.message ? error.message : String(error)
          log(`sync (${reason}): GET ${url} failed: ${message} (non-fatal)`)
        }
      }
      if (autoInfo.size > 0) autoInfo = new Map()
      if (rejected) {
        log(
          `sync (${reason}): /model/info rejected — this key is not allowed the route. ` +
            `Add "/model/info" to the key's routes on the proxy (or set options.infoKey). ` +
            `Manual options.pricing is used meanwhile.`,
        )
      }
    }

    // ------------------------------------------------------------------
    // Budget window (LiteLLM key budget, e.g. a $100/day cap)
    //
    // Read from the proxy's /key/info route on every sync. The key must
    // be allowed that route (like /model/info). The current value is:
    //   - kept in plugin storage ("budget")
    //   - served over plugin RPC (method "budget")
    //   - pushed to TUI clients (event "rpc.litellm.budget")
    // so the status-line widget in ./tui.tsx can render "$spent / $limit".
    // ------------------------------------------------------------------
    let budget = undefined // { spend, maxBudget, resetAt, duration, keyAlias, updatedAt }

    const budgetSchema = {
      type: "object",
      properties: {
        spend: { type: "number" },
        maxBudget: { type: ["number", "null"] },
        resetAt: { type: ["string", "null"] },
        duration: { type: ["string", "null"] },
        keyAlias: { type: ["string", "null"] },
        updatedAt: { type: "string" },
      },
      required: ["spend", "updatedAt"],
    }

    let rpc = undefined
    try {
      rpc = await ctx.rpc.register(
        {
          id: "litellm",
          methods: {
            budget: {
              input: { type: "object", properties: {}, additionalProperties: false },
              output: budgetSchema,
            },
          },
          events: {
            budget: { schema: budgetSchema },
          },
        },
        {
          budget: async () => {
            if (!budget) throw new Error("no budget data yet — /key/info not read or not granted")
            return budget
          },
        },
      )
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      log(`rpc register failed: ${message} (budget RPC unavailable, non-fatal)`)
    }

    async function publishBudget() {
      if (!budget || !rpc) return
      try {
        await rpc.events.emit("budget", budget)
      } catch {
        // no subscriber / transport hiccup — storage still has the value
      }
    }

    async function fetchBudget(reason) {
      const key = options.infoKey || apiKey
      if (!key) return
      const root = baseURL.replace(/\/v1\/?$/, "").replace(/\/$/, "")
      try {
        const res = await fetch(`${root}/key/info`, {
          headers: {
            Authorization: `Bearer ${key}`,
            ...(options.customerID
              ? { "x-litellm-customer-id": options.customerID }
              : {}),
          },
          signal: AbortSignal.timeout(15_000),
        })
        if (res.ok) {
          const json = await res.json()
          const info =
            json && json.info && typeof json.info === "object" ? json.info : json
          const num = (value) => {
            const n = Number(value)
            return Number.isFinite(n) && n >= 0 ? n : undefined
          }
          const limit =
            Array.isArray(info.budget_limits) && info.budget_limits[0]
              ? info.budget_limits[0]
              : {}
          const maxBudget = num(limit.max_budget) ?? num(info.max_budget)
          const spend = num(info.spend)
          if (spend === undefined && maxBudget === undefined) {
            log(`sync (${reason}): /key/info ok but the key has no budget window`)
            return
          }
          budget = {
            spend: spend ?? 0,
            maxBudget: maxBudget ?? null,
            resetAt:
              typeof limit.reset_at === "string"
                ? limit.reset_at
                : typeof info.budget_reset_at === "string"
                  ? info.budget_reset_at
                  : null,
            duration:
              typeof limit.budget_duration === "string"
                ? limit.budget_duration
                : typeof info.budget_duration === "string"
                  ? info.budget_duration
                  : null,
            keyAlias: typeof info.key_alias === "string" ? info.key_alias : null,
            updatedAt: new Date().toISOString(),
          }
          try {
            await ctx.storage.set("budget", budget)
          } catch {
            // storage unavailable in this build — RPC still serves it
          }
          await publishBudget()
          const limitText =
            budget.maxBudget !== null ? ` / $${budget.maxBudget.toFixed(2)}` : ""
          const resetText = budget.resetAt ? ` — resets ${budget.resetAt}` : ""
          log(
            `sync (${reason}): budget $${budget.spend.toFixed(2)}${limitText}${resetText}`,
          )
        } else if (res.status === 401 || res.status === 403) {
          log(
            `sync (${reason}): /key/info rejected (${res.status}) — grant the key the /key/info route to enable the budget display`,
          )
        } else {
          log(`sync (${reason}): GET /key/info -> ${res.status} ${res.statusText}`)
        }
      } catch (error) {
        const message = error && error.message ? error.message : String(error)
        log(`sync (${reason}): /key/info fetch failed: ${message} (non-fatal)`)
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
          const cost = costFor(id)
          if (cost) model.cost = [cost]
          const info = autoInfo.get(id)
          if (info) {
            if (info.context) model.limit.context = info.context
            if (info.outputLimit) model.limit.output = info.outputLimit
          }
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

      // Pricing + context limits from the proxy (non-fatal on failure).
      await fetchModelInfo(why)

      // Budget window from the proxy (non-fatal on failure).
      await fetchBudget(why)

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