import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { cycleRange, DEFAULTS, fmt, parseSettings, parseTokens, summarize, toSettings } from '../hooks/lib'
import type { Settings } from '../types'

// Noon on 10 Nov 2026, local time: the day is the same in every time zone the test runs in.
const NOON = new Date(2026, 10, 10, 12).getTime()

const PANE = {
  plugin: 'token-watcher',
  component: 'Pane',
  requestId: 'token-watcher',
  props: {
    title: 'Tokens',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'token-watcher',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

/** Stands in for the engine: a clock, a store, and a record of what the mod showed. */
function world(on: On, entries: Record<string, unknown> = {}, isPlaced = true) {
  const clock = mock.clock(on, { now: NOON })
  // The store, as JSON text per key: what is read back is never the object that was written.
  const kept = new Map(Object.entries(entries).map(([key, value]) => [key, JSON.stringify(value)]))
  const store = {
    get: (key: string): unknown => (kept.has(key) ? JSON.parse(kept.get(key) ?? 'null') : undefined),
    set: (key: string, value: unknown) => void kept.set(key, JSON.stringify(value)),
    delete: (key: string) => void kept.delete(key),
  }
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...kept.keys()] }))
  // Where the mod draws nothing of its own, this stands for the engine's drawing.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  const toasts: string[] = []
  const status: (string | undefined)[] = []
  const copied: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    status.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.copy', (_, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('ui.open', () => ({ value: isPlaced ? { isPlaced: true } : { isPlaced: false, reason: 'no-surface' } }))
  on('command.register', () => ({ value: { command: 'tokens' } }))
  on('session.usage', () => ({
    value: {
      startedAt: NOON,
      context: { window: 200_000 },
      rateLimits: [{ kind: 'seven_day', percentUsed: 41, resetsAt: new Date(NOON + 3 * 3_600_000).toISOString() }],
    },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  return { clock, toasts, status, copied, store }
}

const start = ($: Engine) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

/** Ends a turn that used `output` tokens and nothing else, unless more is given. */
const turn = ($: Engine, output: number, more: { input?: number; cacheWrite?: number; cacheRead?: number } = {}) =>
  $.turn.complete({
    answer: 'done',
    durationMs: 1000,
    isAborted: false,
    turnId: `t${output}`,
    reason: 'answer',
    usage: {
      model: 'claude-test',
      input_tokens: more.input ?? 0,
      output_tokens: output,
      cache_creation_input_tokens: more.cacheWrite ?? 0,
      cache_read_input_tokens: more.cacheRead ?? 0,
    },
  })

const settings = (patch: Partial<Settings>): Settings => ({ ...DEFAULTS, ...patch })

// --- the arithmetic ----------------------------------------------------------------------------

test('a monthly cycle renews on its day, or on the last day of a shorter month', () => {
  const on31 = settings({ renewalDay: 31 })
  expect(cycleRange(on31, '2026-02-10')).toEqual({ start: '2026-01-31', end: '2026-02-28' })
  expect(cycleRange(on31, '2026-02-28')).toEqual({ start: '2026-02-28', end: '2026-03-31' })
  expect(cycleRange(on31, '2028-02-29')).toEqual({ start: '2028-02-29', end: '2028-03-31' })
  // Across the year's end.
  const on15 = settings({ renewalDay: 15 })
  expect(cycleRange(on15, '2026-12-20')).toEqual({ start: '2026-12-15', end: '2027-01-15' })
  expect(cycleRange(on15, '2027-01-03')).toEqual({ start: '2026-12-15', end: '2027-01-15' })
  expect(cycleRange(settings({ renewalDay: 1 }), '2026-11-10')).toEqual({ start: '2026-11-01', end: '2026-12-01' })
})

test('a weekly cycle starts on the chosen day', () => {
  // 10 Nov 2026 is a Tuesday.
  expect(cycleRange(settings({ cycle: 'week', weekStart: 1 }), '2026-11-10')).toEqual({ start: '2026-11-09', end: '2026-11-16' })
  expect(cycleRange(settings({ cycle: 'week', weekStart: 2 }), '2026-11-10')).toEqual({ start: '2026-11-10', end: '2026-11-17' })
  expect(cycleRange(settings({ cycle: 'week', weekStart: 3 }), '2026-11-10')).toEqual({ start: '2026-11-04', end: '2026-11-11' })
})

test('token counts are read and written the way people write them', () => {
  expect(parseTokens('50M')).toBe(50_000_000)
  expect(parseTokens(' 2.5m ')).toBe(2_500_000)
  expect(parseTokens('500k')).toBe(500_000)
  expect(parseTokens('1,200,000')).toBe(1_200_000)
  expect(parseTokens('1b')).toBe(1_000_000_000)
  expect(parseTokens('0')).toBe(0)
  expect(parseTokens('lots')).toBeNull()
  expect(parseTokens('-5k')).toBeNull()
  expect(parseTokens('')).toBeNull()
  expect(fmt(950)).toBe('950')
  expect(fmt(12_340)).toBe('12.3k')
  expect(fmt(50_000_000)).toBe('50M')
  expect(fmt(999_999)).toBe('1M')
  expect(fmt(1_250_000_000)).toBe('1.3B')
})

test('each way of counting adds up its own kinds, and the levels follow what is left', () => {
  const days = { '2026-11-10': { input: 100, output: 200, cacheWrite: 300, cacheRead: 4000, turns: 1 } }
  const spent = (counting: Settings['counting']) => summarize(settings({ counting }), days, '2026-11-10').spent
  expect(spent('io')).toBe(300)
  expect(spent('no-cache-read')).toBe(600)
  expect(spent('all')).toBe(4600)

  const level = (limit: number) => summarize(settings({ limit }), days, '2026-11-10').level
  expect(level(0)).toBe('none')
  expect(level(6000)).toBe('ok')
  expect(level(750)).toBe('warn')
  expect(level(630)).toBe('critical')
  expect(level(600)).toBe('out')
  // A day before the cycle began is not counted.
  expect(summarize(settings({ renewalDay: 11 }), { ...days, '2026-10-01': days['2026-11-10'] }, '2026-11-10').spent).toBe(600)
})

test('copied settings paste back the same, and anything else is refused', () => {
  const mine = settings({ cycle: 'week', weekStart: 0, limit: 5_000_000, counting: 'all', warnPct: 30, criticalPct: 10 })
  expect(parseSettings(JSON.stringify(mine))).toEqual(mine)
  expect(parseSettings('hello')).toBeNull()
  expect(parseSettings('[1,2]')).toBeNull()
  expect(parseSettings('{"a":1}')).toBeNull()
  // A sticky line at or over the warning line cannot stand.
  expect(toSettings({ warnPct: 10, criticalPct: 50 }).criticalPct).toBe(5)
})

// --- the mod in a session ----------------------------------------------------------------------

test("a turn's tokens land in today's bucket and on the status line", async ($, on) => {
  const { status, store } = world(on)
  await start($)
  expect(status.at(-1)).toBe('Tokens: 0 this cycle · /tokens to set a limit')

  await turn($, 2000, { input: 1000, cacheWrite: 3000, cacheRead: 100_000 })
  expect(status.at(-1)).toBe('Tokens: 6k this cycle · /tokens to set a limit')
  expect(store.get('month:2026-11')).toEqual({
    '2026-11-10': { input: 1000, output: 2000, cacheWrite: 3000, cacheRead: 100_000, turns: 1 },
  })
})

test('what other sessions spent is counted, and read again every minute', async ($, on) => {
  const { clock, status, store } = world(on, {
    settings: settings({ limit: 100_000 }),
    'month:2026-11': { '2026-11-03': { input: 0, output: 25_000, cacheWrite: 0, cacheRead: 0, turns: 4 } },
  })
  await start($)
  expect(status.at(-1)).toBe('Tokens 25k / 100k · 75% left · renews in 21d')

  store.set('month:2026-11', { '2026-11-03': { input: 0, output: 50_000, cacheWrite: 0, cacheRead: 0, turns: 8 } })
  await clock.advance(60_000)
  expect(status.at(-1)).toBe('Tokens 50k / 100k · 50% left · renews in 21d')
})

test('it warns once at 20% left with a band that hides, and stays at 5% left', async ($, on) => {
  const { toasts, status } = world(on, { settings: settings({ limit: 10_000 }) })
  await start($)
  expect(toasts).toHaveLength(0)

  let band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Button', key: 'tw-details' })).toBeUndefined()
  await band.unmount()

  await turn($, 8500)
  expect(toasts).toEqual(['Token budget low: 15% left (1.5k of 10k), renews in 21d.'])
  expect(status.at(-1)).toBe('⚠ Tokens low: 15% left (1.5k of 10k) · renews in 21d')
  await turn($, 100)
  expect(toasts).toHaveLength(1)

  band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /Token budget low/ })).toBeDefined()
  await band.press({ key: 'tw-hide' })
  expect(await band.find({ type: 'Text', text: /Token budget low/ })).toBeUndefined()
  await band.unmount()

  // Past the sticky line: a second toast, and the band is back with no way to hide it.
  await turn($, 1000)
  expect(toasts).toHaveLength(2)
  expect(toasts[1]).toBe('Token budget almost gone: 4% left (400 of 10k), renews in 21d.')
  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const sticky = await $.ui.mount({ ...BAND, surface })
    expect(await sticky.find({ type: 'Text', text: /almost gone/ })).toBeDefined()
    expect(await sticky.find({ type: 'Button', key: 'tw-details' })).toBeDefined()
    expect(await sticky.find({ type: 'Button', key: 'tw-hide' })).toBeUndefined()
    await sticky.unmount()
  }

  await turn($, 1000)
  expect(status.at(-1)).toBe('⚠ Token budget used up: 10.6k / 10k · renews in 21d')
  expect(toasts).toHaveLength(2)
})

test('a new session does not repeat a warning already given this cycle', async ($, on) => {
  const { toasts } = world(on, {
    settings: settings({ limit: 10_000 }),
    'month:2026-11': { '2026-11-09': { input: 0, output: 8500, cacheWrite: 0, cacheRead: 0, turns: 1 } },
    alerts: { cycleStart: '2026-11-01', warned: true, critical: false },
  })
  await start($)
  expect(toasts).toHaveLength(0)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /Token budget low/ })).toBeDefined()
  await band.unmount()
})

test('the pane shows the figures and the account windows on every surface', async ($, on) => {
  world(on, {
    settings: settings({ limit: 50_000_000 }),
    'month:2026-11': {
      '2026-11-08': { input: 0, output: 4_000_000, cacheWrite: 0, cacheRead: 0, turns: 9 },
      '2026-11-10': { input: 0, output: 15_000_000, cacheWrite: 0, cacheRead: 9_000_000, turns: 30 },
    },
  })
  await start($)

  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^Spent/ }))?.text).toBe('Spent 19M of 50M · 31M left')
    expect((await ui.find({ type: 'Text', text: /% left$/ }))?.text).toBe('62% left')
    expect((await ui.find({ type: 'Text', text: /^Renews/ }))?.text).toBe('Renews 1 Dec (in 21 days) · monthly')
    expect((await ui.find({ type: 'Text', text: /^Today/ }))?.text).toBe('Today 15M · this session 0 (0 turns)')
    expect((await ui.find({ type: 'Text', text: /^Cache read/ }))?.text).toBe('Cache read: 9M')
    expect((await ui.find({ type: 'Text', text: /^7-day/ }))?.text).toBe('7-day: 41% used · resets in 3h 0m')
    // 19M in ten days is 1.9M a day: the 31M left lasts 17 more days, short of 1 Dec.
    expect((await ui.find({ type: 'Text', text: /^At / }))?.text).toBe('At 1.9M/day it runs out around 27 Nov, before it renews.')
    await ui.unmount()
  }
})

test('the settings view saves each change, and refuses what it cannot read', async ($, on) => {
  const { status, store } = world(on)
  await start($)

  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    store.delete('settings')
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Text', text: /No limit is set/ })).toBeDefined()
    await ui.press({ key: 'settings' })

    await ui.input({ key: 'limit', text: 'lots' })
    expect((await ui.find({ type: 'Text', text: /Couldn't read/ }))?.text).toBe(
      'Couldn\'t read "lots" as a number of tokens. Try 50M, 2.5M or 500k.',
    )
    await ui.input({ key: 'limit', text: '50M' })
    expect(await ui.find({ type: 'Text', text: /^Limit set to 50M tokens per cycle\.$/ })).toBeDefined()
    expect(status.at(-1)).toBe('Tokens 0 / 50M · 100% left · renews in 21d')

    await ui.input({ key: 'renewalDay', text: '40' })
    expect(await ui.find({ type: 'Text', text: /a number from 1 to 31/ })).toBeDefined()
    await ui.input({ key: 'renewalDay', text: '25' })
    expect(status.at(-1)).toBe('Tokens 0 / 50M · 100% left · renews in 15d')

    await ui.input({ key: 'criticalPct', text: '30' })
    expect(await ui.find({ type: 'Text', text: /lower than the first warning/ })).toBeDefined()
    await ui.input({ key: 'warnPct', text: '40' })
    await ui.input({ key: 'criticalPct', text: '30' })
    await ui.select({ key: 'counting', value: 'all' })

    await ui.select({ key: 'cycle', value: 'week' })
    expect(await ui.find({ type: 'Input', key: 'renewalDay' })).toBeUndefined()
    await ui.select({ key: 'weekStart', value: '0' })
    expect(status.at(-1)).toBe('Tokens 0 / 50M · 100% left · renews in 5d')

    expect(store.get('settings')).toEqual({
      cycle: 'week',
      renewalDay: 25,
      weekStart: 0,
      limit: 50_000_000,
      counting: 'all',
      warnPct: 40,
      criticalPct: 30,
    })
    await ui.press({ key: 'back' })
    expect(await ui.find({ type: 'Text', text: /^Spent/ })).toBeDefined()
    await ui.unmount()
  }
})

test('settings copy to the clipboard and paste back on another PC', async ($, on) => {
  const mine = settings({ limit: 7_000_000, renewalDay: 12, counting: 'io' })
  const { copied, store } = world(on, { settings: mine })
  await start($)
  await $.command.run({ command: 'tokens', args: 'settings', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'copy' })
  expect(copied).toEqual([JSON.stringify(mine)])

  store.delete('settings')
  await ui.input({ key: 'paste', text: 'not settings' })
  expect(await ui.find({ type: 'Text', text: /isn't settings text/ })).toBeDefined()
  expect(store.get('settings')).toBeUndefined()
  await ui.input({ key: 'paste', text: copied[0] ?? '' })
  expect(store.get('settings')).toEqual(mine)
  await ui.unmount()
})

test("resetting the cycle's count takes two presses and leaves earlier cycles alone", async ($, on) => {
  const { store } = world(on, {
    settings: settings({ limit: 10_000, renewalDay: 5 }),
    'month:2026-11': {
      '2026-11-02': { input: 0, output: 3000, cacheWrite: 0, cacheRead: 0, turns: 1 },
      '2026-11-09': { input: 0, output: 9000, cacheWrite: 0, cacheRead: 0, turns: 1 },
    },
  })
  await start($)
  await $.command.run({ command: 'tokens', args: 'settings', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'reset' })
  expect((store.get('month:2026-11') as Record<string, unknown>)['2026-11-09']).toBeDefined()
  await ui.press({ key: 'reset-cancel' })
  await ui.press({ key: 'reset' })
  await ui.press({ key: 'reset' })
  expect(store.get('month:2026-11')).toEqual({
    '2026-11-02': { input: 0, output: 3000, cacheWrite: 0, cacheRead: 0, turns: 1 },
  })
  expect(await ui.find({ type: 'Text', text: /reset to zero/ })).toBeDefined()
  await ui.unmount()
})

test('/tokens limit sets the limit, and /tokens answers in text where no pane is drawn', async ($, on) => {
  world(on, {}, false)
  await start($)
  const run = (args: string) =>
    $.command.run({ command: 'tokens', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

  expect((await run('limit 2.5M')).text).toBe('Limit set to 2.5M tokens per cycle.')
  expect((await run('limit plenty')).text).toMatch(/Couldn't read "plenty"/)
  await turn($, 500_000)
  expect((await run('')).text).toBe(
    [
      'Tokens 500k / 2.5M · 80% left · renews in 21d',
      'Renews 1 Dec. At 50k/day it lasts until it renews.',
      'Last 7 days: 500k · today: 500k · this session: 500k',
      'Claude account, 7-day: 41% used · resets in 3h 0m',
    ].join('\n'),
  )
})
