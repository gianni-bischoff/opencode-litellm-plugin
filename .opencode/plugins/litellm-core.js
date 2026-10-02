import { homedir, userInfo } from "node:os"
import { appendFileSync, statSync, renameSync, unlinkSync, readFileSync } from "node:fs"

/**
 * Shared engine for the LiteLLM OpenCode plugin.
 *
 * Two entrypoints build on top of this module:
 *   - litellm.js       → V2 server plugin ({ id, setup(ctx) }), used for the
 *                        V2 catalog (model discovery, pricing, budget for the
 *                        TUI on V2-style builds)
 *   - litellm-hooks.js → V1 hooks plugin (default export function), which is
 *                        the documented plugin form of released OpenCode 2.x
 *                        and injects the provider + discovered models into
 *                        the live config so sessions can use them
 *
 * Both share state (models, prices, budget) and the sync() logic below.
 */

export const VERSION = "1.8.1"

export const DEFAULTS = {
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

export function osUsername() {
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

function logFile() {
  return process.env.LITELLM_PLUGIN_DEBUG
    ? (process.env.LITELLM_PLUGIN_DEBUG === "1"
        ? `${dataDir()}/litellm-plugin.log`
        : process.env.LITELLM_PLUGIN_DEBUG)
    : `${dataDir()}/litellm-plugin.log`
}

export function log(message) {
  try {
    appendFileSync(logFile(), `${new Date().toISOString()} ${message}\n`)
  } catch {}
}

// Keep the log from growing without bound: rotate once when it passes 256 KB.
let logRotated = false
export function rotateLogIfNeeded() {
  try {
    if (logRotated) return
    logRotated = true
    if (statSync(logFile()).size > 256 * 1024) {
      try {
        unlinkSync(`${logFile()}.old`)
      } catch {}
      renameSync(logFile(), `${logFile()}.old`)
    }
  } catch {}
}

// ---------------------------------------------------------------------
// Pricing helpers — costs are USD per 1M tokens in the catalog.
// ---------------------------------------------------------------------
const perMillion = (value) => {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}
const num = (value) => {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

export function userCostFor(pricing, id, wildcard = false) {
  if (!pricing || typeof pricing !== "object") return undefined
  const entry = wildcard ? pricing["*"] : pricing[id]
  if (!entry || typeof entry !== "object") return undefined
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

export function costFor(state, id) {
  const user = userCostFor(state.options.pricing, id)
  if (user) return user
  const auto = state.autoInfo.get(id)
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
  return userCostFor(state.options.pricing, id, true)
}

// ---------------------------------------------------------------------
// Proxy endpoints
// ---------------------------------------------------------------------
// LiteLLM management routes live at the proxy root, not under the OpenAI
// /v1 prefix — strip a trailing "/v1" from baseURL. The raw baseURL is
// tried as a fallback for exotic mounts.
function infoCandidates(baseURL) {
  return [...new Set([baseURL.replace(/\/v1\/?$/, ""), baseURL])].map(
    (b) => `${b.replace(/\/$/, "")}/model/info`,
  )
}

export async function fetchModelInfo(state, reason) {
  const key = state.options.infoKey || state.apiKey
  if (!key) return
  const headers = {
    Authorization: `Bearer ${key}`,
    ...(state.options.customerID
      ? { "x-litellm-customer-id": state.options.customerID }
      : {}),
  }

  let rejected = false
  for (const url of infoCandidates(state.baseURL)) {
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
          // LiteLLM reports per-token costs; the catalog wants per 1M.
          const scale = (value) => {
            const n = num(value)
            return n === undefined ? undefined : n * 1_000_000
          }
          const entry = {
            input: scale(info.input_cost_per_token),
            output: scale(info.output_cost_per_token),
            cacheRead: scale(info.cache_read_input_token_cost),
            cacheWrite: scale(info.cache_creation_input_token_cost),
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
        state.autoInfo = next
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
  if (state.autoInfo.size > 0) state.autoInfo = new Map()
  if (rejected) {
    log(
      `sync (${reason}): /model/info rejected — this key is not allowed the route. ` +
        `Add "/model/info" to the key's routes on the proxy (or set options.infoKey). ` +
        `Manual options.pricing is used meanwhile.`,
    )
  }
}

export const budgetSchema = {
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

export async function fetchBudget(state, reason) {
  const key = state.options.infoKey || state.apiKey
  if (!key) return
  state.lastBudgetFetchAt = Date.now()
  const root = state.baseURL.replace(/\/v1\/?$/, "").replace(/\/$/, "")
  try {
    const res = await fetch(`${root}/key/info`, {
      headers: {
        Authorization: `Bearer ${key}`,
        ...(state.options.customerID
          ? { "x-litellm-customer-id": state.options.customerID }
          : {}),
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (res.ok) {
      const json = await res.json()
      const info =
        json && json.info && typeof json.info === "object" ? json.info : json
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
      const budget = state.budget = {
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
        await state.storage?.set?.("budget", budget)
      } catch {
        // storage unavailable in this build — RPC still serves it
      }
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

// ---------------------------------------------------------------------
// Engine factory
//
// Creates the shared mutable state and returns it. Entry files call
// sync()/etc. directly against it.
// ---------------------------------------------------------------------
// A local path spec points at a checkout — match it by its package.json name.
function looksLikeThisPackage(spec) {
  try {
    const pkg = JSON.parse(readFileSync(`${spec}/package.json`, "utf8"))
    return pkg?.name === "opencode-litellm-plugin"
  } catch {
    return false
  }
}

/**
 * Recover this package's options from the OpenCode config files (and, as a
 * last resort, LITELLM_BASE_URL). Needed because some released OpenCode 2.x
 * loaders invoke the config plugin without forwarding the entry's options
 * (e.g. the V2 catalog form loaded from the plural "plugins" key), even
 * though options like baseURL were written right next to the package spec.
 */
export function configOptionsFallback() {
  try {
    const dir = process.env.XDG_CONFIG_HOME || `${homedir()}/.config`
    for (const name of ["opencode.json", "opencode.jsonc"]) {
      let text
      try {
        text = readFileSync(`${dir}/opencode/${name}`, "utf8")
      } catch {
        continue
      }
      const cleaned = text
        .replace(/^[ \t]*\/\/[^\n]*/gm, "")   // full-line // comments
        .replace(/\/\*[\s\S]*?\*\//g, "")      // block comments
      let cfg
      try {
        cfg = JSON.parse(cleaned)
      } catch {
        continue
      }
      for (const list of [cfg.plugin, cfg.plugins]) {
        if (!Array.isArray(list)) continue
        for (const entry of list) {
          const spec = Array.isArray(entry) ? entry[0] : entry?.package
          const opts = Array.isArray(entry) ? entry[1] : entry?.options
          if (typeof spec !== "string" || !opts || typeof opts !== "object") continue
          if (spec.includes("opencode-litellm-plugin") || looksLikeThisPackage(spec)) {
            return opts
          }
        }
      }
    }
  } catch {}
  if (process.env.LITELLM_BASE_URL) return { baseURL: process.env.LITELLM_BASE_URL }
  return undefined
}

export function createEngine(ctx, optionsArg) {
  const source = optionsArg ?? ctx?.options
  const options = { ...DEFAULTS, ...source }
  options.customerID ??= osUsername()
  if (!source?.baseURL && process.env.LITELLM_BASE_URL) {
    // Documented fallback for installs where no options reached the plugin
    // (install.sh honors LITELLM_BASE_URL the same way).
    options.baseURL = process.env.LITELLM_BASE_URL
  }

  let baseURL = options.baseURL
  let apiKey = options.apiKey || process.env.LITELLM_API_KEY
  let keySource = options.apiKey
    ? "options.apiKey"
    : process.env.LITELLM_API_KEY
      ? "LITELLM_API_KEY env"
      : "none"

  return {
    VERSION,
    ctx,
    options,
    providerID: options.providerID,
    baseURL,
    apiKey,
    keySource,
    models: [], // discovered model ids, latest sync
    appliedModels: new Set(), // model ids this materialized in a catalog/runtime
    autoInfo: new Map(),
    budget: undefined,
    budgetSchema,
    rpc: undefined,
    storage: undefined,
    lastBudgetFetchAt: 0,
  }
}

export async function resolveCredential(state) {
  try {
    const connection = await state.ctx.integration?.connection?.active?.(state.providerID)
    if (!connection) return undefined
    const credential = await state.ctx.integration.connection.resolve?.(connection)
    if (credential && credential.type === "key") {
      return { key: credential.key, source: "auth login credential" }
    }
    return undefined
  } catch {
    return undefined
  }
}

// Main sync: refresh key -> models -> pricing -> budget. Entry files
// apply the results to their respective APIs afterwards.
export async function sync(state, reason, apply) {
  const credential = await resolveCredential(state)
  if (credential) {
    state.apiKey = credential.key
    state.keySource = credential.source
  }
  if (state.options.apiKey) {
    state.apiKey = state.options.apiKey
    state.keySource = "options.apiKey"
  }
  const why = reason || "startup"
  state.baseURL = state.options.baseURL

  if (!state.apiKey) {
    log(
      `sync (${why}): no API key found — models NOT fetched. Fix one of: ` +
        `run "opencode2 auth login" and pick LiteLLM, ` +
        `or set options.apiKey, or export LITELLM_API_KEY`,
    )
    if (apply) await apply()
    return
  }

  log(`sync (${why}): key from ${state.keySource}, baseURL=${state.baseURL}`)
  try {
    const res = await fetch(`${state.baseURL.replace(/\/$/, "")}/models`, {
      headers: {
        Authorization: `Bearer ${state.apiKey}`,
        ...(state.options.customerID
          ? { "x-litellm-customer-id": state.options.customerID }
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
        .filter((id) => !state.options.exclude || !id.includes(state.options.exclude))
      const added = discovered.filter((id) => !state.models.includes(id))
      const removed = state.models.filter((id) => !discovered.includes(id))
      state.models = discovered
      log(
        `sync (${why}): ${discovered.length} models (+${added.length} new, -${removed.length} gone)`,
      )
    } else {
      const hint =
        res.status === 401 || res.status === 403
          ? " — key rejected: check it is a valid LiteLLM proxy key"
          : ""
      log(`sync (${why}): GET ${state.baseURL}/models -> ${res.status} ${res.statusText}${hint}`)
      // keep the previous model list
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    log(
      `sync (${why}): fetch failed: ${message} — is the proxy reachable at ${state.baseURL}?`,
    )
    // network failures keep the previous model list
  }

  // Pricing + context limits from the proxy (non-fatal on failure).
  await fetchModelInfo(state, why)

  // Budget window from the proxy (non-fatal on failure).
  await fetchBudget(state, why)

  if (apply) await apply()
}