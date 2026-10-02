import {
  VERSION,
  rotateLogIfNeeded,
  createEngine,
  costFor,
  log,
  sync,
  budgetSchema,
} from "./litellm-core.js"

/**
 * OpenCode V2 server plugin: LiteLLM proxy integration.
 *
 * Loads as a config plugin (default export `{ id, setup }`) on V2-style
 * plugin API builds:
 *   - Older V2 builds pass a ctx with `provider`/`model` transforms,
 *     `rpc`, `session`, `event` and `storage` — all used when present.
 *   - Released OpenCode 2.x passes `catalog` / `integration` hooks — the
 *     discovered models are registered on the V2 catalog, which powers
 *     the model list (`/api/model`) and session-cost pricing.
 *
 * Responsibilities:
 *  - Auto-discovers models from the proxy's /models endpoint and
 *    registers them on the "litellm" provider.
 *  - Keeps the provider entry (base URL, API key, headers) in sync.
 *  - Re-syncs every `refreshMinutes` so models added on the proxy
 *    appear automatically.
 *  - Reads proxy pricing (`/model/info`) and the key budget (`/key/info`).
 *
 * The function-form V1 entrypoint (litellm-hooks.js) is what makes
 * sessions use these models on released OpenCode 2.x; install.sh seeds
 * both.
 */

export default {
  id: "litellm",
  async setup(ctx) {
    const state = createEngine(ctx)
    const options = state.options
    const providerID = state.providerID

    rotateLogIfNeeded()
    log(`litellm plugin v${VERSION} loaded (providerID=${providerID}, baseURL=${options.baseURL})`)

    // ------------------------------------------------------------------
    // Budget serving: plugin RPC (when the build offers it) + storage.
    // ------------------------------------------------------------------
    let rpc = undefined
    if (typeof ctx.rpc?.register === "function") {
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
              if (!state.budget) throw new Error("no budget data yet — /key/info not read or not granted")
              return state.budget
            },
          },
        )
        state.rpc = rpc
      } catch (error) {
        const message = error && error.message ? error.message : String(error)
        log(`rpc register failed: ${message} (budget RPC unavailable, non-fatal)`)
        rpc = undefined
      }
    }

    let budgetRpcNoteLogged = false
    async function publishBudget() {
      if (!state.budget) return
      if (rpc) {
        try {
          await rpc.events.emit("budget", state.budget)
        } catch {
          // no subscriber / transport hiccup — storage still has the value
        }
      } else if (!budgetRpcNoteLogged) {
        budgetRpcNoteLogged = true
        log("budget: plugin RPC is not available in this build — the TUI budget widget stays hidden, values are still logged and shown in the proxy")
      }
    }

    // Message-driven refresh: after a response finishes, re-read the
    // budget so the status line ticks up right away. Debounced (LiteLLM
    // commits the spend a beat after the execution ends) and throttled
    // (agentic loops finish many executions back to back).
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
        void sync(state, "message", publishBudget).catch(() => {})
      }, wait)
    }

    // ------------------------------------------------------------------
    // Catalog application (V2)
    // ------------------------------------------------------------------
    const PROVIDER_PACKAGE =
      ctx.catalog && !ctx.provider
        ? "@ai-sdk/openai-compatible" // released OpenCode ships the AI SDK provider packages
        : "@opencode/ai/providers/openai-compatible" // older V2 fork

    function providerSettings() {
      return state.apiKey
        ? { apiKey: state.apiKey, baseURL: state.baseURL }
        : {}
    }

    function modelApi(id) {
      return {
        id,
        type: "aisdk",
        package: PROVIDER_PACKAGE,
        url: state.baseURL,
        settings: { ...providerSettings() },
      }
    }

    function applyModelCosts(m, id) {
      const cost = costFor(state, id)
      if (cost) m.cost = [cost]
      const info = state.autoInfo.get(id)
      const context = info?.context ?? 200_000
      const output = info?.outputLimit ?? 32_000
      if (m.limit && typeof m.limit === "object") {
        m.limit.context = context
        m.limit.output = output
      } else {
        m.limit = { context, output }
      }
      m.status = "active"
      m.enabled = true
    }

    if (typeof ctx.catalog?.transform === "function") {
      // Released OpenCode 2.x catalog API.
      await ctx.catalog.transform((draft) => {
        draft.provider.update(providerID, (provider) => {
          provider.name = options.name
          provider.api = {
            type: "aisdk",
            package: PROVIDER_PACKAGE,
            url: state.baseURL,
            settings: { ...providerSettings() },
          }
          if (!provider.request || typeof provider.request !== "object") {
            provider.request = { headers: {}, body: {} }
          }
          provider.request.headers = provider.request.headers || {}
          provider.request.body = provider.request.body || {}
          if (options.customerID) {
            provider.request.headers["x-litellm-customer-id"] = options.customerID
          }
          if (provider.disabled === undefined || state.models.length > 0) {
            provider.disabled = false
          }
        })

        if (state.models.length > 0) {
          for (const id of state.models) {
            try {
              draft.model.update(providerID, id, (m) => {
                m.name = id
                m.api = modelApi(id)
                if (!m.capabilities || typeof m.capabilities !== "object") {
                  m.capabilities = { tools: true, input: ["text", "image"], output: ["text"] }
                } else {
                  m.capabilities.tools = true
                  if (!Array.isArray(m.capabilities.input) || m.capabilities.input.length === 0) {
                    m.capabilities.input = ["text", "image"]
                  }
                  if (!Array.isArray(m.capabilities.output) || m.capabilities.output.length === 0) {
                    m.capabilities.output = ["text"]
                  }
                }
                if (!m.request || typeof m.request !== "object") {
                  m.request = { headers: {}, body: {} }
                }
                m.request.headers = m.request.headers || {}
                m.request.body = m.request.body || {}
                if (!Array.isArray(m.variants)) m.variants = []
                if (!m.time || typeof m.time !== "object") m.time = { released: 0 }
                if (!Array.isArray(m.cost)) m.cost = []
                applyModelCosts(m, id)
              })
            } catch (error) {
              log(`catalog: model update failed for ${id}: ${error?.message ?? error}`)
            }
          }
          // Drop discovery-tracked models that the proxy no longer serves
          // (config-defined static models are never tracked/removed).
          for (const id of state.appliedModels) {
            if (state.models.includes(id)) continue
            try {
              draft.model.remove(providerID, id)
            } catch {}
          }
        }
        // Drop the installer's placeholder seed once real models exist
        if (state.models.length > 0 && draft.model.get?.(providerID, "placeholder")) {
          try {
            draft.model.remove(providerID, "placeholder")
          } catch {}
        }
        state.appliedModels = new Set(state.models)
      })
    } else {
      // Older V2 builds: provider + model transforms.
      // Legacy V2 record shape (older builds with editor.add/editor.models).
      function modelRecordLegacy(id) {
        const record = {
          id,
          modelID: id,
          providerID,
          name: id,
          capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
          variants: [],
          time: { released: 0 },
          cost: [],
          status: "active",
          enabled: true,
          limit: { context: 200_000, output: 32_000 },
        }
        const cost = costFor(state, id)
        if (cost) record.cost = [cost]
        const info = state.autoInfo.get(id)
        if (info) {
          if (info.context) record.limit.context = info.context
          if (info.outputLimit) record.limit.output = info.outputLimit
        }
        return record
      }

      await ctx.provider?.transform?.((editor) => {
        const existing = editor.get(providerID)
        if (existing) {
          editor.update(providerID, (provider) => {
            provider.name = options.name
            if (!provider.package) provider.package = PROVIDER_PACKAGE
            if (!provider.settings) provider.settings = {}
            provider.settings.baseURL = state.baseURL
            if (state.apiKey) provider.settings.apiKey = state.apiKey
            if (options.customerID) {
              if (!provider.headers) provider.headers = {}
              provider.headers["x-litellm-customer-id"] = options.customerID
            }
          })
          // Source model definitions are immutable records: rebuild the
          // inventory as proxy models plus any config-defined static models
          // (an empty discovery list keeps the previous inventory, e.g.
          // after a network failure).
          if (state.models.length > 0) {
            const kept = []
            for (const [id, info] of existing.models) {
              if (!state.models.includes(id)) kept.push(info)
            }
            editor.models.set(providerID, [...kept, ...state.models.map(modelRecordLegacy)])
          }
        } else {
          // No providers.litellm config block: register the provider so the
          // model list and auth flow can discover it.
          editor.add({
            info: {
              id: providerID,
              name: options.name,
              activation: "enabled",
              package: PROVIDER_PACKAGE,
              settings: { baseURL: state.baseURL, ...(state.apiKey ? { apiKey: state.apiKey } : {}) },
              ...(options.customerID
                ? { headers: { "x-litellm-customer-id": options.customerID } }
                : {}),
            },
            models: state.models.map(modelRecordLegacy),
          })
        }
        state.appliedModels = new Set(state.models)
      })

      await ctx.model?.transform?.((editor) => {
        if (!editor.provider.get(providerID)) return
        for (const id of state.models) {
          editor.update(providerID, id, (model) => {
            model.name = id
            applyModelCosts(model, id)
          })
        }
        // Drop the installer's placeholder seed once real models exist
        if (state.models.length > 0 && editor.get(providerID, "placeholder")) {
          editor.remove(providerID, "placeholder")
        }
      })
    }

    async function reload() {
      try {
        if (typeof ctx.catalog?.reload === "function") {
          await ctx.catalog.reload()
          return
        }
        await ctx.provider?.reload?.()
      } catch (error) {
        log(`reload failed: ${error && error.message ? error.message : error} (non-fatal)`)
      }
    }

    await sync(state, "startup", reload)

    if (options.sessionHeader) {
      try {
        await ctx.session?.hook?.(
          "model.request",
          (event) => {
            event.headers["x-litellm-session-id"] = event.sessionID
          },
          { providerID },
        )
      } catch (error) {
        log(
          `session hook unavailable: ${error && error.message ? error.message : error} — ` +
            `x-litellm-session-id will not be sent on this build (non-fatal)`,
        )
      }
    }

    const BUDGET_EVENT_TYPES = new Set([
      "session.execution.succeeded",
      "session.execution.failed",
      "session.execution.interrupted",
    ])

    // Event-driven refreshes are optional: newer builds expose an event
    // subscription, others fall back to the timer below.
    let lastSyncAt = Date.now()
    let eventStream = undefined
    try {
      if (typeof ctx.event?.subscribe === "function") {
        const controller = new AbortController()
        eventStream = controller
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
                void sync(state, "session.created", reload).catch(() => {})
              }
              if (event && BUDGET_EVENT_TYPES.has(event.type)) {
                queueBudgetRefresh()
              }
            }
          } catch {
            // stream closed
          }
        })()
      }
    } catch (error) {
      log(`event subscribe unavailable: ${error && error.message ? error.message : error} (non-fatal)`)
    }

    const timer = setInterval(
      () => {
        void sync(state, "timer", reload).catch(() => {})
      },
      Math.max(1, options.refreshMinutes) * 60_000,
    )
    // Do not keep the OpenCode process alive just for the refresh timer.
    try {
      timer.unref?.()
    } catch {}

    return () => {
      clearInterval(timer)
      clearTimeout(budgetDebounceTimer)
      eventStream?.abort?.()
    }
  },
}