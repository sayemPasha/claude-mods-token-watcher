// Token Watcher's arithmetic: dates and cycles, counting, wording. Nothing here touches the engine,
// so every rule can be tested by itself. Dates are local calendar days written `YYYY-MM-DD`.

import type { Counting, DayBucket, Settings } from '../types'

export const DEFAULTS: Settings = {
  cycle: 'month',
  renewalDay: 1,
  weekStart: 1,
  limit: 0,
  counting: 'no-cache-read',
  warnPct: 20,
  criticalPct: 5,
}

export const EMPTY_BUCKET: DayBucket = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, turns: 0 }

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// --- dates -------------------------------------------------------------------------------------

const two = (n: number) => String(n).padStart(2, '0')
const keyOf = (y: number, m: number, d: number) => `${y}-${two(m)}-${two(d)}`

/** The local calendar day of a moment. */
export function dayKey(ms: number): string {
  const d = new Date(ms)
  return keyOf(d.getFullYear(), d.getMonth() + 1, d.getDate())
}

function parts(key: string): [number, number, number] {
  const [y, m, d] = key.split('-').map(Number)
  return [y ?? 1970, m ?? 1, d ?? 1]
}

/** Calendar arithmetic in UTC, so a daylight-saving change never moves a day. */
const utc = (key: string) => {
  const [y, m, d] = parts(key)
  return Date.UTC(y, m - 1, d)
}

export function addDays(key: string, n: number): string {
  const d = new Date(utc(key) + n * 86_400_000)
  return keyOf(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
}

/** Whole days from `a` to `b`; negative when `b` is earlier. */
export const daysBetween = (a: string, b: string) => Math.round((utc(b) - utc(a)) / 86_400_000)

export const weekdayOf = (key: string) => new Date(utc(key)).getUTCDay()

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate()

/** The day a month's budget renews: `renewalDay`, or the month's last day when it is shorter. */
function renewalIn(y: number, m: number, renewalDay: number): string {
  const year = y + Math.floor((m - 1) / 12)
  const month = ((((m - 1) % 12) + 12) % 12) + 1
  return keyOf(year, month, Math.min(renewalDay, daysInMonth(year, month)))
}

/** The cycle `today` falls in: its first day, and the day the next one starts. */
export function cycleRange(s: Settings, today: string): { start: string; end: string } {
  if (s.cycle === 'week') {
    const start = addDays(today, -((weekdayOf(today) - s.weekStart + 7) % 7))
    return { start, end: addDays(start, 7) }
  }
  const [y, m] = parts(today)
  const here = renewalIn(y, m, s.renewalDay)
  return today >= here
    ? { start: here, end: renewalIn(y, m + 1, s.renewalDay) }
    : { start: renewalIn(y, m - 1, s.renewalDay), end: here }
}

/** `10 Nov`. */
export function shortDate(key: string): string {
  const [, m, d] = parts(key)
  return `${d} ${MONTHS[m - 1]}`
}

/** `Tue 10`. */
export const weekRow = (key: string) => `${WEEKDAYS[weekdayOf(key)]?.slice(0, 3)} ${two(parts(key)[2])}`

/** How long until a moment, in words: `3d 4h`, `2h 10m`, `5m`, `now`. */
export function until(ms: number, now: number): string {
  const mins = Math.round((ms - now) / 60_000)
  if (mins <= 0) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ${mins % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

// --- counting ----------------------------------------------------------------------------------

export function addBuckets(a: DayBucket, b: DayBucket): DayBucket {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheRead: a.cacheRead + b.cacheRead,
    turns: a.turns + b.turns,
  }
}

/** What a bucket comes to under the chosen way of counting. */
export function countOf(b: DayBucket, counting: Counting): number {
  if (counting === 'io') return b.input + b.output
  if (counting === 'no-cache-read') return b.input + b.output + b.cacheWrite
  return b.input + b.output + b.cacheWrite + b.cacheRead
}

export const COUNTING_LABELS: Record<Counting, string> = {
  'no-cache-read': 'All except cache reads',
  all: 'All tokens',
  io: 'Input + output only',
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)

/** A bucket read back from the store, with anything that is not a count read as zero. */
export function toBucket(v: unknown): DayBucket {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>
  return {
    input: num(o.input),
    output: num(o.output),
    cacheWrite: num(o.cacheWrite),
    cacheRead: num(o.cacheRead),
    turns: num(o.turns),
  }
}

// --- numbers as text ---------------------------------------------------------------------------

/** `950`, `12.3k`, `12.4M`, `1.2B`. */
export function fmt(n: number): string {
  const abs = Math.abs(n)
  const scaled = (v: number, unit: string) => {
    const text = v >= 100 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, '')
    return `${text}${unit}`
  }
  if (abs < 1000) return String(Math.round(n))
  if (abs < 999_950) return scaled(n / 1e3, 'k')
  if (abs < 999_950_000) return scaled(n / 1e6, 'M')
  return scaled(n / 1e9, 'B')
}

/** Reads `50M`, `2.5m`, `500k`, `1,200,000`, `1b`; null for anything else or a negative. */
export function parseTokens(text: string): number | null {
  const m = /^([0-9]+(?:\.[0-9]+)?)\s*([kmb])?$/i.exec(text.trim().replace(/[,_\s]/g, ''))
  if (!m) return null
  const unit = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? '').toLowerCase()] ?? 1
  const n = Math.round(Number(m[1]) * unit)
  return Number.isSafeInteger(n) ? n : null
}

/** A bar of `width` cells, `fraction` of them filled. */
export function bar(fraction: number, width: number): string {
  const w = Math.max(1, Math.floor(width))
  const filled = Math.max(0, Math.min(w, Math.round(fraction * w)))
  return '█'.repeat(filled) + '░'.repeat(w - filled)
}

// --- settings ----------------------------------------------------------------------------------

const whole = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fallback

/** Settings from whatever was stored or pasted: each field kept when valid, else the default. */
export function toSettings(v: unknown): Settings {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>
  const warnPct = whole(o.warnPct, 1, 99, DEFAULTS.warnPct)
  const criticalPct = whole(o.criticalPct, 0, 98, DEFAULTS.criticalPct)
  return {
    cycle: o.cycle === 'week' ? 'week' : 'month',
    renewalDay: whole(o.renewalDay, 1, 31, DEFAULTS.renewalDay),
    weekStart: whole(o.weekStart, 0, 6, DEFAULTS.weekStart),
    limit: Math.round(num(o.limit)),
    counting: o.counting === 'all' || o.counting === 'io' ? o.counting : 'no-cache-read',
    warnPct,
    criticalPct: criticalPct < warnPct ? criticalPct : Math.min(DEFAULTS.criticalPct, warnPct - 1),
  }
}

/** Settings from pasted text: the JSON the Copy button made. Null when it is not that. */
export function parseSettings(text: string): Settings | null {
  try {
    const v: unknown = JSON.parse(text.trim())
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
    if (!('cycle' in v) || !('limit' in v)) return null
    return toSettings(v)
  } catch {
    return null
  }
}

// --- the summary everything is drawn from ------------------------------------------------------

export type Level = 'none' | 'ok' | 'warn' | 'critical' | 'out'

export type Summary = {
  start: string
  /** The day the next cycle starts. */
  end: string
  daysLeft: number
  /** Tokens counted this cycle, under the chosen way of counting. */
  spent: number
  /** Every kind this cycle, counted or not. */
  kinds: DayBucket
  limit: number
  /** Never under zero. */
  remaining: number
  /** Percent of the limit left, 0 to 100; 100 with no limit. */
  pctLeft: number
  level: Level
  /** The last seven days, oldest first, today last. */
  week: { key: string; count: number }[]
  weekTotal: number
  today: number
  perDay: number
  /** The day the budget runs out at this pace, when that is before it renews. */
  runsOut: string | null
}

export function summarize(s: Settings, days: Record<string, DayBucket>, today: string): Summary {
  const { start, end } = cycleRange(s, today)
  const count = (key: string) => countOf(days[key] ?? EMPTY_BUCKET, s.counting)

  let kinds = EMPTY_BUCKET
  for (let key = start; key <= today; key = addDays(key, 1)) {
    kinds = addBuckets(kinds, days[key] ?? EMPTY_BUCKET)
  }
  const spent = countOf(kinds, s.counting)
  const remaining = Math.max(0, s.limit - spent)
  const pctLeft = s.limit > 0 ? Math.max(0, Math.min(100, (remaining / s.limit) * 100)) : 100

  let level: Level = 'none'
  if (s.limit > 0) {
    level = remaining === 0 ? 'out' : pctLeft <= s.criticalPct ? 'critical' : pctLeft <= s.warnPct ? 'warn' : 'ok'
  }

  const week = Array.from({ length: 7 }, (_, i) => {
    const key = addDays(today, i - 6)
    return { key, count: count(key) }
  })

  const perDay = spent / (daysBetween(start, today) + 1)
  let runsOut: string | null = null
  if (s.limit > 0 && perDay > 0 && remaining > 0) {
    const day = addDays(today, Math.ceil(remaining / perDay))
    if (day < end) runsOut = day
  }

  return {
    start,
    end,
    daysLeft: daysBetween(today, end),
    spent,
    kinds,
    limit: s.limit,
    remaining,
    pctLeft,
    level,
    week,
    weekTotal: week.reduce((n, d) => n + d.count, 0),
    today: count(today),
    perDay,
    runsOut,
  }
}

const renews = (u: Summary) => (u.daysLeft <= 1 ? 'renews tomorrow' : `renews in ${u.daysLeft}d`)

/** Percent left as a person reads it: never `0%` while something is left. */
export function pctText(u: Summary): string {
  if (u.remaining > 0 && u.pctLeft < 1) return '<1%'
  return `${Math.floor(u.pctLeft)}%`
}

/** The line kept under the prompt. */
export function statusText(u: Summary): string {
  switch (u.level) {
    case 'none':
      return `Tokens: ${fmt(u.spent)} this cycle · /tokens to set a limit`
    case 'ok':
      return `Tokens ${fmt(u.spent)} / ${fmt(u.limit)} · ${pctText(u)} left · ${renews(u)}`
    case 'warn':
      return `⚠ Tokens low: ${pctText(u)} left (${fmt(u.remaining)} of ${fmt(u.limit)}) · ${renews(u)}`
    case 'critical':
      return `⚠ Tokens critical: ${pctText(u)} left (${fmt(u.remaining)} of ${fmt(u.limit)}) · ${renews(u)}`
    case 'out':
      return `⚠ Token budget used up: ${fmt(u.spent)} / ${fmt(u.limit)} · ${renews(u)}`
  }
}

/** The warning's words, for the band and the toast; empty when there is nothing to warn of. */
export function warningText(u: Summary): string {
  if (u.level === 'warn') {
    return `Token budget low: ${pctText(u)} left (${fmt(u.remaining)} of ${fmt(u.limit)}), ${renews(u)}.`
  }
  if (u.level === 'critical') {
    return `Token budget almost gone: ${pctText(u)} left (${fmt(u.remaining)} of ${fmt(u.limit)}), ${renews(u)}.`
  }
  if (u.level === 'out') {
    return `Token budget used up: ${fmt(u.spent)} of ${fmt(u.limit)}, ${renews(u)}.`
  }
  return ''
}
