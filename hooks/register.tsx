// Token Watcher: counts the tokens every session on this machine uses, against a budget the person
// sets. A status line shows where it stands, `/tokens` opens a pane with the figures and the
// settings, and a band above the prompt warns when little is left (and stays when almost none is).
//
// The ledger lives in the mod's own store, one key per month holding a bucket per local day, so
// every session adds to the same count. It only knows what sessions with this mod loaded used.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register } from 'claude-code'

import type { AccountWindow, Alerts, DayBucket, Settings, Snapshot } from '../types'
import {
  COUNTING_LABELS,
  DEFAULTS,
  EMPTY_BUCKET,
  WEEKDAYS,
  addBuckets,
  addDays,
  bar,
  countOf,
  cycleRange,
  dayKey,
  fmt,
  parseSettings,
  parseTokens,
  pctText,
  shortDate,
  statusText,
  summarize,
  toBucket,
  toSettings,
  until,
  warningText,
  weekRow,
} from './lib'
import type { Level, Summary } from './lib'

type Engine = EngineInterface

const PANE = 'token-watcher'
const TITLE = 'Tokens'
const REFRESH_MS = 60_000
/** Months of history kept in the store. */
const KEEP_MONTHS = 6

// Change the tag when Snapshot changes shape: it declines what an earlier version stored.
const snapshot = atom(
  { plugin: 'token-watcher', key: 'snapshot' } as const,
  { settings: DEFAULTS, days: {}, session: EMPTY_BUCKET, windows: [], today: '', at: 0 } as Snapshot,
  { shape: 'snapshot-1' },
)
const view = atom({ plugin: 'token-watcher', key: 'view' } as const, 'usage')
const isBandHidden = atom({ plugin: 'token-watcher', key: 'isBandHidden' } as const, false)
const isResetArmed = atom({ plugin: 'token-watcher', key: 'isResetArmed' } as const, false)
const note = atom({ plugin: 'token-watcher', key: 'note' } as const, '')

// --- the ledger --------------------------------------------------------------------------------

const monthKey = (day: string) => `month:${day.slice(0, 7)}`
const firstOfMonth = (day: string) => `${day.slice(0, 7)}-01`

async function readMonth($: Engine, key: string): Promise<Record<string, DayBucket>> {
  const stored = await $.store.get(key)
  const days: Record<string, DayBucket> = {}
  if (typeof stored === 'object' && stored !== null) {
    for (const [day, bucket] of Object.entries(stored)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(day)) days[day] = toBucket(bucket)
    }
  }
  return days
}

/** This month's days and last month's: a cycle and the last seven days never reach further back. */
async function readDays($: Engine, today: string): Promise<Record<string, DayBucket>> {
  const lastMonth = addDays(firstOfMonth(today), -1)
  return { ...(await readMonth($, monthKey(lastMonth))), ...(await readMonth($, monthKey(today))) }
}

/** One write at a time within this session, so two turns ending together both land. */
let chain: Promise<unknown> = Promise.resolve()
function queued<T>(work: () => Promise<T>): Promise<T> {
  const run = chain.then(work, work)
  chain = run.catch(() => undefined)
  return run
}

/** Reads the store again, redraws, sets the status line and raises a warning that is newly due. */
async function refresh($: Engine, used?: DayBucket): Promise<Summary> {
  const now = await $.clock.now()
  const today = dayKey(now)
  const settings = toSettings(await $.store.get('settings'))
  const days = await readDays($, today)
  await update($, snapshot, s => ({
    ...s,
    settings,
    days,
    today,
    at: now,
    session: used ? addBuckets(s.session, used) : s.session,
  }))
  const u = summarize(settings, days, today)
  $.ui.status(statusText(u))
  await alert($, u)
  return u
}

/** Adds one turn's tokens to today's bucket. The day is read again first: other sessions write too. */
function record($: Engine, usage: ModelUsage): Promise<Summary> {
  return queued(async () => {
    const used: DayBucket = {
      input: usage.input_tokens,
      output: usage.output_tokens,
      cacheWrite: usage.cache_creation_input_tokens,
      cacheRead: usage.cache_read_input_tokens,
      turns: 1,
    }
    const today = dayKey(await $.clock.now())
    const month = await readMonth($, monthKey(today))
    month[today] = addBuckets(month[today] ?? EMPTY_BUCKET, toBucket(used))
    await $.store.set(monthKey(today), month)
    return refresh($, used)
  })
}

/** Drops months older than the history kept. */
async function prune($: Engine): Promise<void> {
  let oldest = firstOfMonth(dayKey(await $.clock.now()))
  for (let i = 0; i < KEEP_MONTHS; i += 1) oldest = firstOfMonth(addDays(oldest, -1))
  for (const key of await $.store.keys()) {
    if (key.startsWith('month:') && key < monthKey(oldest)) await $.store.delete(key)
  }
}

// --- warnings ----------------------------------------------------------------------------------

function toAlerts(v: unknown, cycleStart: string): Alerts {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>
  if (o.cycleStart !== cycleStart) return { cycleStart, warned: false, critical: false }
  return { cycleStart, warned: o.warned === true, critical: o.critical === true }
}

/** Toasts once per cycle when a line is crossed, in whichever session crosses it. */
async function alert($: Engine, u: Summary): Promise<void> {
  if (u.level === 'none') return
  const stored = await $.store.get('alerts')
  const was = toAlerts(stored, u.start)
  let now = was

  if (u.level === 'ok') {
    // The limit was raised or the cycle renewed: a later crossing warns again.
    now = { ...was, warned: false, critical: false }
  } else if (u.level === 'warn') {
    if (!was.warned) $.ui.toast(warningText(u), { timeoutMs: 8000 })
    now = { ...was, warned: true, critical: false }
  } else {
    if (!was.critical) $.ui.toast(warningText(u), { timeoutMs: 12_000 })
    now = { ...was, warned: true, critical: true }
  }

  const isSame = stored !== undefined && now.warned === was.warned && now.critical === was.critical
  const isNothing = stored === undefined && !now.warned && !now.critical
  if (!isSame && !isNothing) await $.store.set('alerts', now)
}

// --- settings ----------------------------------------------------------------------------------

const say = ($: Engine, text: string) => update($, note, () => text)

async function save($: Engine, patch: Partial<Settings>, said: string): Promise<void> {
  const current = toSettings(await $.store.get('settings'))
  await $.store.set('settings', toSettings({ ...current, ...patch }))
  await say($, said)
  await refresh($)
}

async function setLimit($: Engine, text: string): Promise<string> {
  const limit = parseTokens(text)
  if (limit === null) {
    const said = `Couldn't read "${text.trim()}" as a number of tokens. Try 50M, 2.5M or 500k.`
    await say($, said)
    return said
  }
  const said = limit === 0 ? 'Limit cleared: nothing to warn about.' : `Limit set to ${fmt(limit)} tokens per cycle.`
  await save($, { limit }, said)
  return said
}

async function setRenewalDay($: Engine, text: string): Promise<void> {
  const day = Number(text.trim())
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    await say($, 'The renewal day is a number from 1 to 31.')
    return
  }
  const short = day > 28 ? ' A shorter month renews on its last day.' : ''
  await save($, { renewalDay: day }, `Renews on day ${day} of each month.${short}`)
}

async function setPercent($: Engine, which: 'warnPct' | 'criticalPct', text: string): Promise<void> {
  const pct = Number(text.trim().replace(/%$/, ''))
  const s = toSettings(await $.store.get('settings'))
  const warn = which === 'warnPct' ? pct : s.warnPct
  const critical = which === 'criticalPct' ? pct : s.criticalPct
  if (!Number.isInteger(pct) || warn < 1 || warn > 99 || critical < 0 || critical >= warn) {
    await say($, 'Use whole percentages, the sticky warning lower than the first warning (for example 20 and 5).')
    return
  }
  await save($, { [which]: pct }, `Warns at ${warn}% left; the warning stays at ${critical}% left.`)
}

/** Empties this cycle's days, so the count starts over from now. */
function resetCycle($: Engine): Promise<void> {
  return queued(async () => {
    const today = dayKey(await $.clock.now())
    const { start } = cycleRange(toSettings(await $.store.get('settings')), today)
    for (const key of new Set([monthKey(start), monthKey(today)])) {
      const month = await readMonth($, key)
      for (const day of Object.keys(month)) {
        if (day >= start && day <= today) delete month[day]
      }
      await $.store.set(key, month)
    }
    await $.store.delete('alerts')
    await update($, isResetArmed, () => false)
    await say($, "This cycle's count was reset to zero.")
    await refresh($)
  })
}

// --- wording -----------------------------------------------------------------------------------

const TONE: Record<Level, string> = {
  none: 'subtle',
  ok: 'success',
  warn: 'warning',
  critical: 'error',
  out: 'error',
}

function windowName(kind: string): string {
  if (kind === 'five_hour') return '5-hour'
  if (kind === 'seven_day') return '7-day'
  return kind.replace(/_/g, ' ')
}

function windowLine(w: AccountWindow, now: number): string {
  const resets = w.resetsAt ? Date.parse(w.resetsAt) : NaN
  const when = Number.isFinite(resets) ? ` · resets in ${until(resets, now)}` : ''
  return `${windowName(w.kind)}: ${w.percentUsed}% used${when}`
}

const pace = (u: Summary) =>
  u.runsOut
    ? `At ${fmt(u.perDay)}/day it runs out around ${shortDate(u.runsOut)}, before it renews.`
    : `At ${fmt(u.perDay)}/day it lasts until it renews.`

/** The figures as plain lines, for where no pane can be drawn. */
function report(u: Summary, s: Snapshot): string {
  const lines = [statusText(u)]
  if (u.level !== 'none') lines.push(`Renews ${shortDate(u.end)}. ${u.spent > 0 ? pace(u) : ''}`.trim())
  lines.push(`Last 7 days: ${fmt(u.weekTotal)} · today: ${fmt(u.today)} · this session: ${fmt(countOf(s.session, s.settings.counting))}`)
  for (const w of s.windows) lines.push(`Claude account, ${windowLine(w, s.at)}`)
  return lines.join('\n')
}

// --- hooks -------------------------------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'tokens',
        description: 'Show token usage against your budget, and its settings',
        argumentHint: '[settings | limit 50M]',
      })
      const { rateLimits } = await $.session.usage()
      await update($, snapshot, s => ({ ...s, windows: [...rateLimits] }))
      await prune($)
      await refresh($)
      // Other sessions spend from the same budget: read it again every minute.
      $.clock.every(REFRESH_MS, () => void refresh($).catch(() => undefined))
    } catch (err) {
      $.ui.log(`token-watcher could not start: ${err instanceof Error ? err.message : String(err)}`)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.usage) {
      await record($, e.usage).catch(() => undefined)
    }

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      await update($, snapshot, s => ({ ...s, windows: [...e.rateLimits] }))
    }

    return next(e)
  })

  on('command.run', { command: 'tokens' }, async ($, e) => {
    const args = e.args.trim()
    const limit = /^limit\s+(.+)$/i.exec(args)
    if (limit) {
      return { text: await setLimit($, limit[1] ?? '') }
    }

    await update($, view, () => (/^settings\b/i.test(args) ? 'settings' : 'usage'))
    const u = await refresh($)
    const opened = await $.ui.open({ id: PANE, title: TITLE, columns: 50 })

    return { text: opened.isPlaced ? statusText(u) : report(u, await read($, snapshot)) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, snapshot)
    if (e.props.hasSurvey || s.today === '') return next(e)

    const u = summarize(s.settings, s.days, s.today)
    const isSticky = u.level === 'critical' || u.level === 'out'
    if (!isSticky && (u.level !== 'warn' || (await read($, isBandHidden)))) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const open = () => {
      void update($, view, () => 'usage').then(() => $.ui.open({ id: PANE, title: TITLE, columns: 50 }))
    }

    return (
      <Box flexDirection="row" gap="sm" alignItems="center">
        <Text color={TONE[u.level]} weight={isSticky ? 'bold' : 'regular'}>
          ⚠ {warningText(u)}
        </Text>
        <Button key="tw-details" label="Details" onPress={open} />
        {isSticky ? null : (
          <Button key="tw-hide" label="Hide" role="dismiss" onPress={() => void update($, isBandHidden, () => true)} />
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Input, Select, Text } = $.ui.resolve(e)
    const s = await read($, snapshot)
    const shown = await read($, view)
    const cols = Math.max(24, e.props.bodyColumns)

    if (s.today === '') {
      return <Text dimColor>Reading the ledger…</Text>
    }

    const u = summarize(s.settings, s.days, s.today)
    const tone = TONE[u.level]
    const heading = (title: string, aside?: string) => (
      <Box flexDirection="row" gap="sm" marginTop="md" alignItems="center">
        <Text weight="semibold">{title}</Text>
        {aside ? <Text dimColor size="footnote">{aside}</Text> : null}
      </Box>
    )

    // --- settings ---
    if (shown === 'settings') {
      const armed = await read($, isResetArmed)
      const said = await read($, note)
      const set = s.settings
      const back = () => {
        void update($, isResetArmed, () => false)
        void say($, '')
        void update($, view, () => 'usage')
      }
      const copy = async () => {
        const text = JSON.stringify(set)
        const copied = await $.ui.copy({ text, surface: e.surface })
        await say($, copied.isCopied ? 'Settings copied. Paste them into the field below on another PC.' : `Couldn't copy here. The settings are: ${text}`)
      }
      const paste = async (text: string) => {
        const pasted = parseSettings(text)
        if (!pasted) {
          await say($, "That isn't settings text. Use Copy settings on the other PC and paste what it copied.")
          return
        }
        await save($, pasted, 'Settings pasted and saved.')
      }

      return (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" alignItems="center">
            <Text size="heading" weight="semibold">Token budget settings</Text>
            <Button key="back" label="Back" onPress={back} />
          </Box>
          <Text dimColor size="footnote">Saved as you change them, for every session on this PC.</Text>
          {said ? <Text color="suggestion">{said}</Text> : null}

          {heading('Budget')}
          <Input
            key="limit"
            label="Max tokens per cycle"
            placeholder="50M, 2.5M, 500k"
            value={set.limit > 0 ? fmt(set.limit) : ''}
            submitLabel="save"
            onSubmit={value => void setLimit($, value)}
          />
          <Select
            key="cycle"
            label="Renews"
            value={set.cycle}
            options={[
              { value: 'month', label: 'Every month' },
              { value: 'week', label: 'Every week' },
            ]}
            onSelect={value =>
              void save($, { cycle: value === 'week' ? 'week' : 'month' }, value === 'week' ? 'The budget renews every week.' : 'The budget renews every month.')
            }
          />
          {set.cycle === 'month' ? (
            <Input
              key="renewalDay"
              label="Renewal day of the month (1-31)"
              value={String(set.renewalDay)}
              submitLabel="save"
              onSubmit={value => void setRenewalDay($, value)}
            />
          ) : (
            <Select
              key="weekStart"
              label="Week starts on"
              value={String(set.weekStart)}
              options={WEEKDAYS.map((label, n) => ({ value: String(n), label }))}
              onSelect={value => void save($, { weekStart: Number(value) }, `The week starts on ${WEEKDAYS[Number(value)]}.`)}
            />
          )}
          <Select
            key="counting"
            label="What counts"
            value={set.counting}
            options={(['no-cache-read', 'all', 'io'] as const).map(value => ({ value, label: COUNTING_LABELS[value] }))}
            onSelect={value => {
              const counting = value === 'all' || value === 'io' ? value : 'no-cache-read'
              void save($, { counting }, `Counting: ${COUNTING_LABELS[counting].toLowerCase()}.`)
            }}
          />
          <Text dimColor size="footnote">
            Cache reads are usually far larger than everything else, so including them changes the count a lot.
          </Text>

          {heading('Warnings')}
          <Input
            key="warnPct"
            label="Warn when % left is at or under"
            value={String(set.warnPct)}
            submitLabel="save"
            onSubmit={value => void setPercent($, 'warnPct', value)}
          />
          <Input
            key="criticalPct"
            label="Keep the warning up when % left is at or under"
            value={String(set.criticalPct)}
            submitLabel="save"
            onSubmit={value => void setPercent($, 'criticalPct', value)}
          />

          {heading('This cycle')}
          <Box flexDirection="row" gap="sm">
            <Button
              key="reset"
              label={armed ? 'Press again to reset the count' : "Reset this cycle's count"}
              onPress={() => void (armed ? resetCycle($) : update($, isResetArmed, () => true))}
            />
            {armed ? <Button key="reset-cancel" label="Cancel" onPress={() => void update($, isResetArmed, () => false)} /> : null}
          </Box>

          {heading('Another PC')}
          <Box flexDirection="row" gap="sm">
            <Button key="copy" label="Copy settings" onPress={() => void copy()} />
          </Box>
          <Input key="paste" label="Paste settings" placeholder='{"cycle":…}' submitLabel="apply" onSubmit={value => void paste(value)} />
          <Text dimColor size="footnote">Each PC counts its own sessions; only the settings travel.</Text>
        </Box>
      )
    }

    // --- usage ---
    const barWidth = Math.max(10, Math.min(30, cols - 10))
    const peak = Math.max(1, ...u.week.map(d => d.count))
    const counted = s.settings.counting
    const kinds: [string, number, boolean][] = [
      ['Input', u.kinds.input, true],
      ['Output', u.kinds.output, true],
      ['Cache write', u.kinds.cacheWrite, counted !== 'io'],
      ['Cache read', u.kinds.cacheRead, counted === 'all'],
    ]

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text size="heading" weight="semibold">Token budget</Text>
          <Box flexDirection="row" gap="sm">
            <Button key="settings" label="Settings" variant={u.level === 'none' ? 'primary' : 'secondary'} onPress={() => void update($, view, () => 'settings')} />
            <Button key="refresh" label="Refresh" onPress={() => void refresh($)} />
          </Box>
        </Box>

        {u.level === 'none' ? (
          <Box flexDirection="column">
            <Text>{`${fmt(u.spent)} tokens used since ${shortDate(u.start)}.`}</Text>
            <Text color="warning">No limit is set. Open Settings, or type /tokens limit 50M.</Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            <Box flexDirection="row" gap="sm">
              <Text color={tone} mono>{bar(u.pctLeft / 100, barWidth)}</Text>
              <Text color={tone} weight="semibold">{`${pctText(u)} left`}</Text>
            </Box>
            <Text>{`Spent ${fmt(u.spent)} of ${fmt(u.limit)} · ${fmt(u.remaining)} left`}</Text>
            <Text dimColor>{`Renews ${shortDate(u.end)} (${u.daysLeft <= 1 ? 'tomorrow' : `in ${u.daysLeft} days`}) · ${s.settings.cycle === 'week' ? 'weekly' : 'monthly'}`}</Text>
            {u.level === 'ok' ? null : <Text color={tone}>{warningText(u)}</Text>}
            {u.spent > 0 && u.level !== 'out' ? <Text color={u.runsOut ? 'warning' : 'subtle'}>{pace(u)}</Text> : null}
          </Box>
        )}

        {heading('Last 7 days', `${fmt(u.weekTotal)} total`)}
        {u.week.map(d => (
          <Box key={`day:${d.key}`} flexDirection="row" gap="sm">
            <Text dimColor={d.key !== s.today} mono>{weekRow(d.key)}</Text>
            <Text color="suggestion" mono>{bar(d.count / peak, 12)}</Text>
            <Text dimColor={d.count === 0} tabular>{fmt(d.count)}</Text>
          </Box>
        ))}
        <Text>{`Today ${fmt(u.today)} · this session ${fmt(countOf(s.session, counted))} (${s.session.turns} ${s.session.turns === 1 ? 'turn' : 'turns'})`}</Text>

        {heading('By kind', 'this cycle')}
        {kinds.map(([label, tokens, isCounted]) => (
          <Box key={`kind:${label}`} flexDirection="row" gap="sm">
            <Text dimColor={!isCounted}>{`${label}: ${fmt(tokens)}`}</Text>
            {isCounted ? null : <Text dimColor size="footnote">not counted</Text>}
          </Box>
        ))}

        {s.windows.length > 0 ? heading('Claude account limits', 'all your devices') : null}
        {s.windows.map(w => (
          <Text key={`window:${w.kind}`} color={w.percentUsed >= 95 ? 'error' : w.percentUsed >= 80 ? 'warning' : 'text'}>
            {windowLine(w, s.at)}
          </Text>
        ))}

        <Box marginTop="md">
          <Text dimColor size="footnote">
            Counts Claude Code sessions on this PC since the mod was installed.
          </Text>
        </Box>
      </Box>
    )
  })
}
