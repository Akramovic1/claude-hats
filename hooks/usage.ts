// Usage arithmetic, with no I/O: the limit windows, how two readings of one
// window combine, how full an account is, and how to read a response's
// rate-limit headers.

import type { AccountUsage, Limit } from '../types'

export const WARN_AT = 80
export const ALERT_AT = 90

// Long and short names per window, in the order they are listed.
const WINDOWS: Array<[kind: string, name: string, short: string]> = [
  ['five_hour', '5-hour', '5h'],
  ['seven_day', 'Weekly', 'week'],
  ['seven_day_fable', 'Fable', 'Fable'],
  ['seven_day_opus', 'Opus', 'Opus'],
  ['seven_day_sonnet', 'Sonnet', 'Sonnet'],
  ['spend_limit', 'Spend', 'spend'],
]
const NAME = new Map(WINDOWS.map(([k, n]) => [k, n]))
const SHORT = new Map(WINDOWS.map(([k, , s]) => [k, s]))
const ORDER = new Map(WINDOWS.map(([k], i) => [k, i]))

export function nameOf(kind: string): string {
  return NAME.get(kind) ?? kind
}

export function shortKind(kind: string): string {
  return SHORT.get(kind) ?? kind
}

export function sortedLimits(limits: Limit[]): Limit[] {
  return [...limits].sort((x, y) => (ORDER.get(x.kind) ?? 99) - (ORDER.get(y.kind) ?? 99))
}

export function isLimit(x: unknown): x is Limit {
  const l = x as Limit
  return (
    typeof l === 'object' &&
    l !== null &&
    typeof l.kind === 'string' &&
    typeof l.percentUsed === 'number' &&
    (l.resetsAt === undefined || typeof l.resetsAt === 'string')
  )
}

export function isAccount(x: unknown): x is AccountUsage {
  const a = x as AccountUsage
  return (
    typeof a === 'object' &&
    a !== null &&
    typeof a.id === 'string' &&
    typeof a.label === 'string' &&
    typeof a.updatedAt === 'number' &&
    Array.isArray(a.limits) &&
    a.limits.every(isLimit)
  )
}

export function sameList(a: AccountUsage[], b: AccountUsage[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function sortAccounts(list: AccountUsage[]): AccountUsage[] {
  return [...list].sort((x, y) => x.label.localeCompare(y.label, undefined, { numeric: true }))
}

/** The window's share as of `t`: a window whose reset time has passed is back to 0. */
export function effectivePercent(limit: Limit, t: number): number {
  if (limit.resetsAt && Date.parse(limit.resetsAt) <= t) return 0
  return limit.percentUsed
}

export function untilText(resetsAt: string | undefined, t: number): string {
  if (!resetsAt) return ''
  const ms = Date.parse(resetsAt) - t
  if (Number.isNaN(ms)) return ''
  if (ms <= 0) return 'reset'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `resets in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `resets in ${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return `resets in ${days}d ${hours % 24}h`
}

export function agoText(updatedAt: number, t: number): string {
  if (updatedAt === 0) return 'no reading yet'
  const minutes = Math.round((t - updatedAt) / 60_000)
  if (minutes < 1) return 'updated just now'
  if (minutes < 60) return `updated ${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `updated ${hours}h ago`
  return `updated ${Math.floor(hours / 24)}d ago`
}

/** The weekly window, else whatever the account reports first. */
export function weekly(a: AccountUsage): Limit | undefined {
  return a.limits.find(l => l.kind === 'seven_day') ?? sortedLimits(a.limits)[0]
}

/** The window that runs out first: the busiest one. */
export function busiest(a: AccountUsage, t: number): Limit | undefined {
  return [...a.limits].sort((x, y) => effectivePercent(y, t) - effectivePercent(x, t))[0]
}

/** How full an account is, by its busiest window; 0 with no reading. */
export function fullness(a: AccountUsage, t: number): number {
  const top = busiest(a, t)
  return top ? effectivePercent(top, t) : 0
}

/**
 * Two readings of one window. Sources round differently (16% and 17% for the
 * same moment), and usage only rises until the reset, so within one window the
 * higher figure stands and the number never flickers.
 */
export function settle(fresh: Limit, old: Limit | undefined): Limit {
  if (!old || !fresh.resetsAt || !old.resetsAt) return fresh
  const isSameWindow = Math.abs(Date.parse(fresh.resetsAt) - Date.parse(old.resetsAt)) < 600_000
  return isSameWindow && old.percentUsed > fresh.percentUsed ? { ...fresh, percentUsed: old.percentUsed } : fresh
}

// Windows every response reports while the plan has them. One of these that a
// fresh reading leaves out, and whose reset has passed, is a window the plan
// no longer has (not one at 0%), so it is let go.
const ALWAYS_REPORTED = new Set(['five_hour', 'seven_day'])

/**
 * Fresh readings folded into the ones already held: settled per window, the
 * rest kept, except a window that has ended and is no longer reported.
 */
export function mergeLimits(old: Limit[], fresh: Limit[], t = 0): Limit[] {
  const isGone = (o: Limit): boolean =>
    ALWAYS_REPORTED.has(o.kind) && o.resetsAt !== undefined && Date.parse(o.resetsAt) <= t
  return sortedLimits([
    ...fresh.map(f => settle(f, old.find(o => o.kind === f.kind))),
    ...old.filter(o => !fresh.some(f => f.kind === o.kind) && !isGone(o)),
  ])
}

// The account's own usage report (`/api/oauth/usage`). The plain windows are
// keys holding `{ utilization (0 to 100), resets_at }`, null where the plan
// has none. Per-model weekly windows are in `limits`, as
// `{ kind: "weekly_scoped", percent, resets_at, scope: { model: { display_name } } }`.
const REPORT_KEYS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']
const SCOPED_KINDS: Record<string, string> = {
  fable: 'seven_day_fable',
  opus: 'seven_day_opus',
  sonnet: 'seven_day_sonnet',
}

function reportLimit(kind: string, percent: unknown, resetsAt: unknown): Limit | undefined {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return undefined
  const reset = typeof resetsAt === 'string' ? Date.parse(resetsAt) : NaN
  return {
    kind,
    percentUsed: Math.round(percent * 10) / 10,
    resetsAt: Number.isNaN(reset) ? undefined : new Date(reset).toISOString(),
  }
}

/** The windows in an account's usage report; none where the body is not one. */
export function reportLimits(body: unknown): Limit[] {
  if (typeof body !== 'object' || body === null) return []
  const report = body as Record<string, unknown>
  const out: Limit[] = []
  const add = (l: Limit | undefined): void => {
    if (l && !out.some(o => o.kind === l.kind)) out.push(l)
  }
  for (const key of REPORT_KEYS) {
    const v = report[key] as { utilization?: unknown; resets_at?: unknown } | null | undefined
    if (typeof v === 'object' && v !== null) add(reportLimit(key, v.utilization, v.resets_at))
  }
  for (const item of Array.isArray(report.limits) ? report.limits : []) {
    const l = item as {
      kind?: unknown
      percent?: unknown
      resets_at?: unknown
      scope?: { model?: { display_name?: unknown } | null } | null
    } | null
    if (typeof l !== 'object' || l === null || l.kind !== 'weekly_scoped') continue
    const model = l.scope?.model?.display_name
    const kind = typeof model === 'string' ? SCOPED_KINDS[model.toLowerCase()] : undefined
    if (kind) add(reportLimit(kind, l.percent, l.resets_at))
  }
  return sortedLimits(out)
}

// Every response from the Messages API says how full the subscription's
// windows are, in `anthropic-ratelimit-unified-<window>-utilization` (0 to 1)
// and `-reset` (epoch seconds). `7d_oi` is the weekly window of the top model
// (Fable): it is present only on that model's own responses. The reading of
// that bucket is credited to claude-swap (MIT), which documented it.
const HEADER_WINDOWS: Array<[suffix: string, kind: string]> = [
  ['5h', 'five_hour'],
  ['7d', 'seven_day'],
  ['7d_oi', 'seven_day_fable'],
]

/** The usage windows a response's headers report; none where it carries no such headers. */
export function headerLimits(headers: Record<string, string>): Limit[] {
  const h: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v
  const out: Limit[] = []
  for (const [suffix, kind] of HEADER_WINDOWS) {
    const raw = h[`anthropic-ratelimit-unified-${suffix}-utilization`]
    if (raw === undefined || raw === '') continue
    const used = Number(raw)
    if (!Number.isFinite(used)) continue
    const reset = Number(h[`anthropic-ratelimit-unified-${suffix}-reset`])
    out.push({
      kind,
      percentUsed: Math.round(used * 1000) / 10,
      resetsAt: Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : undefined,
    })
  }
  return out
}

const HOUR = 3_600_000

/**
 * Whether, at the pace so far, this window is spent before it resets. Quiet
 * for the first part of a window and for small figures, where a projection
 * is noise.
 */
export function runsOutEarly(limit: Limit, t: number): boolean {
  if (!limit.resetsAt) return false
  const length = limit.kind === 'five_hour' ? 5 * HOUR : limit.kind.startsWith('seven_day') ? 168 * HOUR : 0
  const reset = Date.parse(limit.resetsAt)
  if (length === 0 || Number.isNaN(reset) || reset <= t) return false
  const elapsed = t - (reset - length)
  const used = limit.percentUsed
  if (elapsed < length * 0.12 || used < 10) return false
  return used / (elapsed / length) > 100
}

/** A name as the row shows it: whole when short, else cut with an ellipsis. */
export function shortLabel(label: string, max = 14): string {
  return label.length <= max ? label : `${label.slice(0, max - 1).trimEnd()}…`
}

export type RowPlan = {
  /** `full`: name, meter and figure. `compact`: name and figure. */
  style: 'full' | 'compact'
  /** How many accounts the row shows, from the first; the rest are behind "+N more". */
  shown: number
}

/**
 * How the accounts fit on one line of `columns` cells, so the row never wraps:
 * every account with its meter while they fit, then without meters, then as
 * many as fit with the rest behind "+N more". The first (the one in use) is
 * always shown. `quick` is the quick switch's label, when the row has one.
 */
export function planRow(labels: string[], columns: number, quick?: string): RowPlan {
  // In cells: the character and "Weekly" lead the row; a chip is its name and
  // marks, its figure, and in full style its meter; then the quick switch.
  // and "+ Add" follows the accounts.
  const room = columns - 12 - 7 - (quick === undefined ? 0 : quick.length + 2)
  const compact = labels.map(l => shortLabel(l).length + 9)
  const full = compact.map(w => w + 8)
  const sum = (ws: number[]) => ws.reduce((a, b) => a + b, 0)
  if (sum(full) <= room) return { style: 'full', shown: labels.length }
  if (sum(compact) <= room) return { style: 'compact', shown: labels.length }
  let shown = 1
  while (shown < labels.length && sum(compact.slice(0, shown + 1)) + 8 <= room) shown += 1

  return { style: 'compact', shown }
}
