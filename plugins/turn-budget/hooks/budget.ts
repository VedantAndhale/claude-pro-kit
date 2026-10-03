// The budget arithmetic: pure, so the tests exercise it directly.

export type Limits = {
  /** Session points (5-hour window) one turn may use before it asks. */
  points: number
  /** Uncached input tokens (uncached + cache-written) one turn may send before it asks. */
  tokens: number
  isOff: boolean
}

export const DEFAULTS: Limits = { points: 5, tokens: 500_000, isOff: false }

export type Spend = {
  /** Session points this turn has used, from Claude Code's readings; undefined off a subscription. */
  points?: number
  tokens: number
  requests: number
}

/** The next marks to ask at; each Continue raises the crossed one by its own step. */
export type Marks = { points: number; tokens: number }

export const firstMarks = (limits: Limits): Marks => ({ points: limits.points, tokens: limits.tokens })

export const isOver = (spend: Spend, marks: Marks): boolean =>
  (spend.points !== undefined && spend.points >= marks.points) || spend.tokens >= marks.tokens

/** Which limit the turn crossed: the one to name when asking and in the note. Points first when both are. */
export type Crossed = 'points' | 'tokens'

export const crossed = (spend: Spend, marks: Marks): Crossed =>
  spend.points !== undefined && spend.points >= marks.points ? 'points' : 'tokens'

export const nextMarks = (spend: Spend, marks: Marks, limits: Limits): Marks => {
  let { points, tokens } = marks
  while (spend.points !== undefined && spend.points >= points) points += limits.points
  while (spend.tokens >= tokens) tokens += limits.tokens
  return { points, tokens }
}

export type ModelUsageLike = {
  input_tokens: number
  cache_creation_input_tokens?: number
}

/** Cache reads are left out: they cost a fraction of new input. */
export const uncached = (usage: ModelUsageLike) => usage.input_tokens + (usage.cache_creation_input_tokens ?? 0)

const n = (value: number) => value.toLocaleString('en-US')

export const question = (spend: Spend, marks: Marks, start: number | undefined, now: number | undefined) => {
  const used =
    crossed(spend, marks) === 'points' && start !== undefined && now !== undefined
      ? `${spend.points} ${spend.points === 1 ? 'point' : 'points'} of your session (${start}% → ${now}%, limit +${marks.points})`
      : `${n(spend.tokens)} uncached input tokens (limit ${n(marks.tokens)})`
  return `This turn has used ${used} over ${spend.requests} ${spend.requests === 1 ? 'request' : 'requests'}. Keep going?`
}

export const CONTINUE = 'Continue'
export const CONTINUE_QUIETLY = "Don't ask again"
export const STOP = 'Stop here'

export type Choice = 'continue' | 'quiet' | 'stop'

/** Anything but a Continue label stops: an answer that is not a clear yes protects the session. */
export const choiceOf = (answer: string): Choice =>
  answer === CONTINUE ? 'continue' : answer === CONTINUE_QUIETLY ? 'quiet' : 'stop'

export const stopNote = (spend: Spend, marks: Marks) =>
  `[turn-budget] The user stopped the previous turn at ${crossed(spend, marks) === 'points' ? `+${spend.points} session points` : `${n(spend.tokens)} uncached input tokens`}. Ask before continuing that work.`

export const status = (spend: Spend, marks: Marks) =>
  spend.points !== undefined ? `turn budget ${spend.points}/${marks.points} pts` : `turn budget ${n(spend.tokens)}/${n(marks.tokens)} tok`

/** `/turn-budget 8`, `/turn-budget tokens 1000000`, `/turn-budget off|on`; undefined for anything else. */
export const parse = (args: string, limits: Limits): Limits | undefined => {
  const [a, b] = args.trim().toLowerCase().split(/\s+/)
  if (a === 'off' || a === 'on') return { ...limits, isOff: a === 'off' }
  if (a === 'tokens' && b && /^\d+$/.test(b) && Number(b) > 0) return { ...limits, tokens: Number(b) }
  if (a && /^\d+(\.\d+)?$/.test(a) && Number(a) > 0) return { ...limits, points: Number(a) }
  return undefined
}

export const describeLimits = (limits: Limits) =>
  limits.isOff
    ? 'Turn budget is off. /turn-budget on to turn it back on.'
    : `Turn budget: asks at +${limits.points} session points or ${n(limits.tokens)} uncached input tokens per turn. /turn-budget <points> · /turn-budget tokens <n> · /turn-budget off`
