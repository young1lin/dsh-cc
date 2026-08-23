/**
 * Per-session telemetry endpoints: plan quota and cost, context-window
 * breakdown, and the live model catalog with its effort levels.
 *
 * The response types mirror what the CLI's control channel returns, including
 * the fields a subscription account has and an API-key or gateway account does
 * not — `subscription_type` being null is the signal to render cumulative cost
 * instead of rate-limit windows, not a failure.
 *
 * @module dsh-cc/client/api/telemetry
 */

import { api } from './http.ts'

/** One plan rate-limit window. */
export interface UsageWindow {
  /** Percent of the window consumed, or null when the CLI cannot say. */
  utilization?: number | null
  /** ISO timestamp the window resets at, or null. */
  resets_at?: string | null
}

/** Token and cost accounting for one model within a session. */
export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  webSearchRequests?: number
  costUSD: number
  contextWindow?: number
  maxOutputTokens?: number
  canonicalModel?: string
  /** The upstream that served the request, e.g. `firstParty`. */
  provider?: string
}

/** The usage response the page renders. */
export interface UsageInfo {
  /** Cumulative cost and per-model tokens for this session. */
  session?: {
    total_cost_usd: number
    total_api_duration_ms?: number
    total_duration_ms?: number
    total_lines_added?: number
    total_lines_removed?: number
    model_usage?: Record<string, ModelUsage>
  }
  /** `pro` / `max` / `team` / `enterprise`; null for API-key and gateway auth. */
  subscription_type?: string | null
  /** False whenever the account has no plan windows — the common gateway case. */
  rate_limits_available?: boolean
  rate_limits?: {
    five_hour?: UsageWindow | null
    seven_day?: UsageWindow | null
    seven_day_opus?: UsageWindow | null
    seven_day_sonnet?: UsageWindow | null
    extra_usage?: {
      is_enabled?: boolean
      monthly_limit?: number
      used_credits?: number
      utilization?: number
      currency?: string
    } | null
  } | null
}

/**
 * GET /sessions/:id/usage.
 * @param id - session id.
 * @returns the usage response, or a reason it is unavailable.
 */
export function fetchUsage(id: string): Promise<{ available: boolean; reason?: string; usage?: UsageInfo }> {
  return api<{ available: boolean; reason?: string; usage?: UsageInfo }>(`/sessions/${id}/usage`)
}

/** One slice of the context window, as the CLI categorizes it. */
export interface ContextCategory {
  name: string
  tokens: number
  /** The CLI's own color tag for the category; the page maps it to a token. */
  color: string
  isDeferred?: boolean
}

/** Context-window occupancy from the CLI control channel. */
export interface ContextUsage {
  categories?: ContextCategory[]
  totalTokens: number
  maxTokens: number
  rawMaxTokens?: number
  /** Whole-percent occupancy the CLI itself computed. */
  percentage?: number
  isAutoCompactEnabled?: boolean
  autoCompactThreshold?: number
  model?: string
}

/**
 * GET /sessions/:id/context.
 * @param id - session id.
 * @returns the context breakdown, or availability false without a live process.
 */
export function fetchContext(id: string): Promise<{ available: boolean; context?: ContextUsage }> {
  return api<{ available: boolean; context?: ContextUsage }>(`/sessions/${id}/context`)
}

/** One selectable model from the live CLI catalog. */
export interface ModelRow {
  /** The value to send back when switching, e.g. `sonnet` or an exact id. */
  value: string
  displayName: string
  description?: string
  /** What `value` actually resolves to right now, e.g. under gateway aliases. */
  resolvedModel?: string
  supportsEffort?: boolean
  supportedEffortLevels?: string[]
}

/**
 * GET /sessions/:id/models.
 * @param id - session id.
 * @returns the catalog, the current selection, and the current effort level.
 */
export function fetchModels(id: string): Promise<{
  available: boolean
  models: ModelRow[]
  current: string
  effort?: string
}> {
  return api<{ available: boolean; models: ModelRow[]; current: string; effort?: string }>(`/sessions/${id}/models`)
}

/**
 * POST /sessions/:id/model — make this the session's model.
 * @param id - session id.
 * @param model - model id or alias; empty resets to the plugin default.
 * @returns the acknowledgement.
 */
export function setModel(id: string, model: string): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/sessions/${id}/model`, { method: 'POST', body: JSON.stringify({ model }) })
}

/**
 * POST /sessions/:id/effort — set the reasoning effort level.
 * @param id - session id.
 * @param effort - effort level; empty resets to the model default.
 * @returns the acknowledgement.
 */
export function setEffort(id: string, effort: string): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/sessions/${id}/effort`, { method: 'POST', body: JSON.stringify({ effort }) })
}
