export type HudLimit = {
  kind: string
  pct: number
  resetsAt?: string
}

export type HudTurn = {
  startedAt: number
  isRunning: boolean
  /** Set when the turn ends: the engine's own duration. */
  ms?: number
  tools: number
  files: number
  /** Input tokens of the turn's main-thread requests: uncached, cache-written and cache-read. */
  inTok: number
  /** The part of `inTok` the prompt cache served. */
  cacheTok: number
  outTok: number
  /** The 5h window's reading when the turn started; the band shows the change since. */
  fiveStart?: number
}

export type HudPrefs = {
  band: boolean
  spinner: boolean
  cards: boolean
}

export type HudContext = { pct?: number; tokens?: number; window?: number }

declare module 'claude-code' {
  interface PluginState {
    'pro-hud': {
      limits: HudLimit[]
      context: HudContext
      turn: HudTurn | null
      now: number
      prefs: HudPrefs
    }
  }
}
