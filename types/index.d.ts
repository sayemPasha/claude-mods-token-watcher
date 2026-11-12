// Token Watcher's values: the settings a person chooses, the ledger of tokens per day, and the
// snapshot the pane, the band and the status line are drawn from.

/** Which tokens count toward the budget. The breakdown always shows all four kinds. */
export type Counting = 'all' | 'no-cache-read' | 'io'

export type Settings = {
  /** How often the budget renews. */
  cycle: 'month' | 'week'
  /** Day of the month the budget renews, 1 to 31; a shorter month renews on its last day. */
  renewalDay: number
  /** Day the week starts for a weekly budget: 0 Sunday to 6 Saturday. */
  weekStart: number
  /** Most tokens per cycle; 0 means no limit has been set. */
  limit: number
  counting: Counting
  /** Percent remaining at or under which the warning shows. */
  warnPct: number
  /** Percent remaining at or under which the warning stays and cannot be hidden. */
  criticalPct: number
}

/** Tokens of one day (local date), or of one session, by kind. */
export type DayBucket = {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  turns: number
}

/** One of Claude's own account windows, as the last response reported it. */
export type AccountWindow = { kind: string; percentUsed: number; resetsAt?: string }

export type Snapshot = {
  settings: Settings
  /** Recent days by local date, `YYYY-MM-DD`. */
  days: Record<string, DayBucket>
  /** What this session alone has used. */
  session: DayBucket
  windows: AccountWindow[]
  /** The local date when the snapshot was read. */
  today: string
  /** When it was read, in milliseconds. */
  at: number
}

/** Which toasts were already shown for the cycle that starts on `cycleStart`. */
export type Alerts = { cycleStart: string; warned: boolean; critical: boolean }

declare module 'claude-code' {
  interface PluginState {
    'token-watcher': {
      snapshot: Shaped<Snapshot>
      view: 'usage' | 'settings'
      isBandHidden: boolean
      isResetArmed: boolean
      /** The last thing the settings view has to say: what was saved, or why not. */
      note: string
      /**
       * The boot sequence's frame: -1 before it has played this session, 0 up to the last frame
       * while it plays, and the frame count once it has played or was skipped.
       */
      splash: number
    }
  }
}
