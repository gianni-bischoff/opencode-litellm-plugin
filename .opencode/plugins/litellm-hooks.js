import os from "node:os"
import { readFileSync } from "node:fs"

import {
  VERSION,
  rotateLogIfNeeded,
  createEngine,
  costFor,
  log,
  sync,
} from "./litellm-core.js"

/**
 * OpenCode 2.x server plugin (function form): LiteLLM proxy integration.
 *
 * Released OpenCode 2.x documents the plugin API as a default-exported
 * *function*: `default async (ctx, options) => Hooks` whose returned
 * hooks include a `config(cfg)` callback that can mutate the live merged
 * config once on init — before the session runtime builds its provider
 * registry. This entrypoint uses exactly that:
 *
 *   - `config(cfg)`: registers/refreshes the `litellm` provider with the
 *     models discovered from the proxy's `/models` route (plus proxy
 *     pricing when `/model/info` is granted) so sessions can run
 *     `litellm/*` models without any manual model list.
 *   - `event({event})`: re-syncs the model list when a new session
 *     starts (throttled) and re-reads the key budget after responses.
 *   - `chat.headers(input, output)`: adds the `x-litellm-session-id` and
 *     `x-litellm-customer-id` headers to LiteLLM requests.
 *   - `dispose()`: stops the refresh timer.
 *
 * Options resolution order:
 *   1. the config tuple's options (passed by the loader)
 *   2. the options of this package's entry in opencode.json plugins
 *   3. LITELLM_BASE_URL env, then defaults
 *
 * Options (from the `["<plugin>", { ... }]` config tuple) are the same as
 * for litellm.js — baseURL, apiKey, pricing, exclude, infoKey, …
 */

function configOptionsFallback() {
  try {
    const dir = process.env.XDG_CONFIG_HOME || `${os.homedir()}/.config`
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

// A local path spec points at a checkout — match it by its package.json name.
function looksLikeThisPackage(spec) {
  try {
    const pkg = JSON.parse(readFileSync(`${spec}/package.json`, "utf8"))
    return pkg?.name === "opencode-litellm-plugin"
  } catch {
    return false
  }
}

export default async function litellmHooks(ctx, optionsArg) {
  const state = createEngine(ctx, optionsArg ?? configOptionsFallback())
  const options = state.options
  const providerID = state.providerID

  rotateLogIfNeeded()
  log(`litellm plugin v${VERSION} loaded (hooks form, providerID=${providerID}, baseURL=${options.baseURL})`)

  // Timer-driven resync (models added on the proxy are picked up here;
  // on released builds they take effect for sessions after a restart —
  // the running session's provider registry is built once).
  const timer = setInterval(
    () => {
      void sync(state, "timer").catch(() => {})
    },
    Math.max(1, options.refreshMinutes) * 60_000,
  )
  try {
    timer.unref?.()
  } catch {}

  // Budget refresh after every response (debounced + throttled).
  const BUDGET_EVENT_DEBOUNCE_MS = 2_000
  const BUDGET_EVENT_THROTTLE_MS = 15_000
  let budgetDebounceTimer = undefined

  function queueBudgetRefresh() {
    clearTimeout(budgetDebounceTimer)
    const sinceFetch = Date.now() - state.lastBudgetFetchAt
    const wait = Math.max(
      BUDGET_EVENT_DEBOUNCE_MS,
      BUDGET_EVENT_THROTTLE_MS - sinceFetch,
    )
    budgetDebounceTimer = setTimeout(() => {
      budgetDebounceTimer = undefined
      void sync(state, "message").catch(() => {})
    }, wait)
  }

  await sync(state, "startup")

  // ------------------------------------------------------------------
  // Provider injection into the live merged config. Runs once on init,
  // before the session provider registry is built — that is what makes
  // the discovered models usable in sessions.
  // ------------------------------------------------------------------
  function injectConfig(cfg) {
    try {
      if (!cfg || typeof cfg !== "object") return
      if (!cfg.provider || typeof cfg.provider !== "object") cfg.provider = {}
      const existing = cfg.provider[providerID]
      const modelsRecord = {}
      for (const id of state.models) {
        const cost = costFor(state, id)
        const info = state.autoInfo.get(id)
        const entry = { name: id, tool_call: true }
        if (cost) {
          entry.cost = {
            input: cost.input,
            output: cost.output,
            cache_read: cost.cache.read,
            cache_write: cost.cache.write,
          }
        }
        entry.limit = {
          context: info?.context ?? 200_000,
          output: info?.outputLimit ?? 32_000,
        }
        modelsRecord[id] = entry
      }
      // Preserve config-defined static models (they win — do not touch).
      cfg.provider[providerID] = {
        name: options.name,
        npm: "@ai-sdk/openai-compatible",
        options: {
          baseURL: state.baseURL,
          ...(state.apiKey ? { apiKey: state.apiKey } : {}),
          ...(options.customerID
            ? { headers: { "x-litellm-customer-id": options.customerID } }
            : {}),
        },
        models: { ...modelsRecord, ...(existing?.models ?? {}) },
      }
      log(
        `config: litellm provider registered with ${Object.keys(modelsRecord).length} discovered models`,
      )
    } catch (error) {
      log(`config hook failed: ${error && error.message ? error.message : error} (non-fatal)`)
    }
  }

  return {
    config: (cfg) => {
      injectConfig(cfg)
    },
    event: (input) => {
      const type = input?.event?.type ?? input?.type
      // Re-sync the model list on new sessions (throttled; LiteLLM may
      // have added models since the last sync).
      if (type === "session.created" && Date.now() - state.lastBudgetFetchAt >= 30_000) {
        void sync(state, "session.created").catch(() => {})
      }
      // Re-read the budget after responses finish, so the status line
      // ticks up right away (LiteLLM commits the spend a beat later).
      if (
        type === "message.updated" ||
        type === "session.status" ||
        type === "session.idle"
      ) {
        queueBudgetRefresh()
      }
    },
    "chat.headers": (input, output) => {
      try {
        if ((input?.model?.providerID ?? input?.model?.provider) !== providerID) return
        if (options.customerID) output.headers["x-litellm-customer-id"] = options.customerID
        if (options.sessionHeader !== false && input.sessionID) {
          output.headers["x-litellm-session-id"] = input.sessionID
        }
      } catch {}
    },
    dispose: () => {
      clearInterval(timer)
      clearTimeout(budgetDebounceTimer)
    },
  }
}