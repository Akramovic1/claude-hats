/** One usage window: `five_hour`, `seven_day`, `seven_day_fable`, ... */
export type Limit = {
  kind: string
  /** 0 to 100, at most one decimal. */
  percentUsed: number
  /** ISO 8601. */
  resetsAt?: string
}

/** What Claude is doing, as the character acts it out. */
export type Activity =
  | 'idle'
  | 'thinking'
  | 'reading'
  | 'writing'
  | 'running'
  | 'browsing'
  | 'delegating'
  | 'done'

/** One account and its last reading. */
export type AccountUsage = {
  /** Also the name of its token file. */
  id: string
  label: string
  email?: string
  /** The organization its responses come from, once one has been seen. */
  org?: string
  limits: Limit[]
  /** When the reading was taken, in epoch milliseconds; 0 for none yet. */
  updatedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'account-usage': {
      accounts: Shaped<AccountUsage[]>
      /** The account requests go out as. */
      me: string
      now: number
      /** The account whose details the band shows, '' for none. */
      expanded: string
      /** An Activity: what the character is acting out. */
      activity: string
      /** The ids of the accounts that can be switched to: this window's own, and each with a saved token. */
      usable: string[]
      /** The account being renamed in the pane, '' for none. */
      renaming: string
    }
  }
}
