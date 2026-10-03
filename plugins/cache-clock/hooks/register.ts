import type { EngineInterface, Register } from 'claude-code'

// The prompt cache keeps the conversation for a fixed time after each main-thread
// request; the next message after that re-sends the whole context uncached.
// Every main-thread response restarts the clock, and its reported usage is the
// exact size the next request re-sends. Nothing is sent to the model.
//
// The engine does not report the cache's lifetime on a turn, so it is learned:
// 5 minutes until a cache hit after a longer gap proves 1 hour, or a miss after
// one proves 5 minutes. The answer is kept across sessions. Until it is known
// the status line hedges and no toast is shown: a 1-hour cache would make a
// 5-minute alarm false.

const FIVE_MIN = 5 * 60_000
const ONE_HOUR = 60 * 60_000
const TICK_MS = 5_000

export type Ttl = { ms: number; isConfirmed: boolean }
export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

const tokens = (n: number) => n.toLocaleString('en-US')

export const contextOf = (u: Usage) =>
  u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + u.output_tokens

export const formatGap = (ms: number) => {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

export const formatLeft = (ms: number) => {
  const s = Math.ceil(ms / 1000)
  return s >= 60 ? `${Math.floor(s / 60)}m` : `${s}s`
}

// What one main-thread response after `gapMs` of quiet says about the cache: the
// lifetime it proves, and the tokens it re-sent uncached when the cache was gone.
export const classify = (gapMs: number, prevContext: number, u: Usage, ttl: Ttl) => {
  const isHit = (u.cache_read_input_tokens ?? 0) >= prevContext / 2
  let next = ttl
  if (gapMs > FIVE_MIN && gapMs < ONE_HOUR) next = { ms: isHit ? ONE_HOUR : FIVE_MIN, isConfirmed: true }
  const missTokens =
    !isHit && gapMs > next.ms ? u.input_tokens + (u.cache_creation_input_tokens ?? 0) : undefined
  return { ttl: next, missTokens }
}

export const statusText = (leftMs: number, contextTok: number, ttl: Ttl) => {
  if (leftMs > 0) return `cache warm · ${ttl.isConfirmed ? '' : '≥'}${formatLeft(leftMs)} left`
  return `cache ${ttl.isConfirmed ? 'cold' : 'likely cold'} · next message re-sends ${tokens(contextTok)} tokens`
}

// The module's own: a reload starts the clock over, and the next response restarts it.
let ttl: Ttl = { ms: FIVE_MIN, isConfirmed: false }
let lastAt: number | undefined
let contextTok = 0
let isColdShown = false
let ticker: { cancel: () => void } | undefined

async function tick($: EngineInterface) {
  if (lastAt === undefined) return
  const left = lastAt + ttl.ms - (await $.clock.now())
  $.ui.status(statusText(left, contextTok, ttl))
  if (left > 0) return
  ticker?.cancel()
  ticker = undefined
  if (!isColdShown && ttl.isConfirmed) {
    isColdShown = true
    $.ui.toast(`Prompt cache expired: your next message re-sends ${tokens(contextTok)} tokens uncached.`)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const saved = (await $.store.get('ttlMs')) as number | undefined
    if (saved === FIVE_MIN || saved === ONE_HOUR) ttl = { ms: saved, isConfirmed: true }
    lastAt = undefined
    contextTok = 0
    ticker?.cancel()
    ticker = undefined
    $.ui.status(undefined)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const step = yield* next(e)
    const usage = step.usage
    if (e.agentId !== undefined || !usage) return step

    const at = await $.clock.now()
    if (lastAt !== undefined && contextTok > 0) {
      const gap = at - lastAt
      const seen = classify(gap, contextTok, usage, ttl)
      if (seen.ttl.isConfirmed && (!ttl.isConfirmed || seen.ttl.ms !== ttl.ms)) await $.store.set('ttlMs', seen.ttl.ms)
      ttl = seen.ttl
      if (seen.missTokens !== undefined) {
        $.ui.log(`cache-clock: cache expired after ${formatGap(gap)} idle; this message re-sent ${tokens(seen.missTokens)} tokens uncached.`)
      }
    }

    lastAt = at
    contextTok = contextOf(usage)
    isColdShown = false
    if (ticker === undefined) ticker = $.clock.every(TICK_MS, () => void tick($))
    void tick($)
    return step
  })
}
