/**
 * Formatting helpers shared by the status-strip meters (context occupancy and
 * account usage): compact token counts and rate-limit reset countdowns.
 *
 * @module dsh-cc/client/status/format
 */

/**
 * Format a token count compactly.
 * @param tokens - the count.
 * @returns e.g. `37.0K`, or the plain integer under 1000.
 */
export function compact(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}K` : String(tokens)
}

/**
 * How long until a rate-limit window resets.
 * @param resetsAt - ISO timestamp, or null/undefined when the CLI has none.
 * @param now - current epoch ms.
 * @returns e.g. `2h31m`, or empty when there is nothing to say (no timestamp,
 * an unparsable one, or one already in the past).
 */
export function untilText(resetsAt: string | null | undefined, now: number): string {
  if (resetsAt === null || resetsAt === undefined || resetsAt === '') return ''
  const at = Date.parse(resetsAt)
  if (Number.isNaN(at) || at <= now) return ''
  const minutes = Math.round((at - now) / 60000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return minutes % 60 > 0 ? `${hours}h${minutes % 60}m` : `${hours}h`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}
