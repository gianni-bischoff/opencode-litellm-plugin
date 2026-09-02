/** @jsxImportSource @opentui/solid */
// TUI part of the plugin. Loaded automatically when this file sits beside
// index.js (local path installs) or via the "./tui" package export
// (npm/git installs). Renders the LiteLLM key budget — "$spent / $limit"
// with a reset countdown — into the prompt footer status line, and warns
// once per budget window when spending crosses 90%.
import { Plugin } from "@opencode-ai/plugin/tui"
import { createSignal } from "solid-js"

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

// Mirrors the RPC registration in .opencode/plugins/litellm.js.
const definition = {
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
}

const money = (value) =>
  `$${Number(value).toFixed(2)}`

function countdown(resetAt) {
  const ms = Date.parse(resetAt) - Date.now()
  if (!Number.isFinite(ms)) return undefined
  if (ms <= 0) return "resets soon"
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m left`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours < 48) return `${hours}h ${rest}m left`
  return `${Math.floor(hours / 24)}d ${hours % 24}h left`
}

export default Plugin.define({
  id: "litellm-budget",
  setup(ctx) {
    const theme = ctx.theme
    const colors = {
      ok: theme?.text?.feedback?.success?.default ?? "green",
      warn: theme?.text?.feedback?.warning?.default ?? "yellow",
      danger: theme?.text?.feedback?.error?.default ?? "red",
      subdued: theme?.text?.subdued ?? "gray",
    }

    const [budget, setBudget] = createSignal(undefined)
    const [, forceTick] = createSignal(0, { equals: false })
    let warnedWindow = null // resetAt already warned about this run

    const cleanups = []

    // Current value on startup, then live updates from every sync.
    try {
      const rpc = ctx.client.rpc(definition)
      rpc
        .budget({})
        .then((value) => setBudget(value))
        .catch(() => setBudget(null))
      cleanups.push(
        rpc.events.on("budget", (event) => setBudget(event.data)),
      )
    } catch {
      setBudget(null) // older server without plugin RPC — stay hidden
    }

    // Keep the countdown moving.
    const ticker = setInterval(() => forceTick((n) => n + 1), 60_000)
    cleanups.push(() => clearInterval(ticker))

    try {
      cleanups.push(
        ctx.ui.slot({
          append: "prompt.footer.status",
          render: () => {
            const data = budget()
            if (!data) {
              return (
                <text fg={colors.subdued}>
                  {data === undefined ? " litellm budget — waiting for sync…" : ""}
                </text>
              )
            }

            const spend = Number(data.spend) || 0
            const limit = Number.isFinite(Number(data.maxBudget))
              ? Number(data.maxBudget)
              : undefined
            const left = limit !== undefined ? countdown(data.resetAt) : undefined

            let body
            let color
            if (limit !== undefined && limit > 0) {
              const ratio = spend / limit
              color = ratio >= 0.85 ? colors.danger : ratio >= 0.6 ? colors.warn : colors.ok
              const percent = `${Math.round(ratio * 100)}%`
              body = `${money(spend)} / ${money(limit)} (${percent})`
              if (left) body += ` · ${left}`

              if (ratio >= 0.9 && data.resetAt && warnedWindow !== data.resetAt) {
                warnedWindow = data.resetAt
                try {
                  ctx.ui.toast.show({
                    title: "LiteLLM budget",
                    message: `${money(spend)} of ${money(limit)} used (${percent})${
                      left ? ` — ${left}` : ""
                    }`,
                    variant: ratio >= 1 ? "error" : "warning",
                  })
                } catch {}
              }
            } else {
              color = colors.subdued
              body = `${money(spend)} spent${left ? ` · ${left}` : ""}`
            }

            return (
              <box flexDirection="row">
                <text fg={colors.subdued}> litellm </text>
                <text fg={color}>{body}</text>
              </box>
            )
          },
        }),
      )
    } catch {
      // slot API unavailable — nothing to render in this build
    }

    return () => {
      for (const cleanup of cleanups) {
        try {
          cleanup?.()
        } catch {}
      }
    }
  },
})