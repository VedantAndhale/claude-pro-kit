import type { EngineInterface, Register } from 'claude-code'

import {
  CONTINUE,
  CONTINUE_QUIETLY,
  DEFAULTS,
  STOP,
  choiceOf,
  describeLimits,
  firstMarks,
  isOver,
  nextMarks,
  parse,
  question,
  status,
  stopNote,
  uncached,
} from './budget'
import type { Limits, Marks, Spend } from './budget'

// Before each model request of a turn (subagents' included), checks what the
// turn has spent; past the limit it asks, before the request is sent, whether
// to go on. Only between requests, so a running command is never cut.

async function limitsOf($: EngineInterface): Promise<Limits> {
  return { ...DEFAULTS, ...((await $.store.get('limits')) as Partial<Limits> | undefined) }
}

type Turn = {
  id: string
  start?: number
  spend: Spend
  marks: Marks
  isQuiet: boolean
  isStopped: boolean
  /** One question at a time, however many subagents step at once. */
  asking?: Promise<boolean>
}

// Resolves true to go on, false when the person chose to stop.
async function check($: EngineInterface, t: Turn, latest: number | undefined): Promise<boolean> {
  if (t.isStopped) return false
  if (t.isQuiet || !isOver(t.spend, t.marks)) return true
  if (t.asking) return t.asking

  t.asking = (async () => {
    let answer: string
    try {
      answer = await $.ui.ask(question(t.spend, t.start, latest), {
        options: [CONTINUE, CONTINUE_QUIETLY, STOP],
        header: 'Turn budget',
      })
    } catch {
      // Nobody to ask (a -p run, or the dialog was dismissed): never stop a
      // turn on a question nobody saw; note it and go on.
      $.ui.status(`${status(t.spend, t.marks)} · over, not asked`)
      t.isQuiet = true
      return true
    }
    const choice = choiceOf(answer)
    if (choice === 'stop') {
      t.isStopped = true
      await $.session
        .append({ message: { type: 'user', content: [{ type: 'text', text: stopNote(t.spend) }] } })
        .catch(() => undefined)
      await $.turn.abort({ turnId: t.id }).catch(() => undefined)
      $.ui.status(undefined)
      return false
    }
    if (choice === 'quiet') t.isQuiet = true
    else t.marks = nextMarks(t.spend, t.marks, await limitsOf($))
    return true
  })()

  try {
    return await t.asking
  } finally {
    t.asking = undefined
  }
}

export const register: Register = on => {
  let latest: number | undefined
  let turn: Turn | undefined

  const fivePoints = (start: number | undefined) =>
    start !== undefined && latest !== undefined ? Math.max(0, Math.round((latest - start) * 10) / 10) : undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'budget', description: 'Turn budget: /budget · /budget <points> · /budget tokens <n> · /budget off|on' })
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const five = e.rateLimits.find(l => l.kind === 'five_hour')
    if (five) {
      // The window reset mid-turn: the new reading is the new baseline.
      if (turn?.start !== undefined && five.percentUsed < turn.start) turn.start = five.percentUsed
      latest = five.percentUsed
      if (turn && !turn.isStopped) {
        turn.spend.points = fivePoints(turn.start)
        $.ui.status(status(turn.spend, turn.marks))
      }
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const limits = await limitsOf($)
    turn = limits.isOff
      ? undefined
      : {
          id: e.turnId,
          start: latest,
          spend: { points: latest === undefined ? undefined : 0, tokens: 0, requests: 0 },
          marks: firstMarks(limits),
          isQuiet: false,
          isStopped: false,
        }
    $.ui.status(undefined)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      turn = undefined
      $.ui.status(undefined)
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const t = turn
    if (!t) return yield* next(e)

    if (!(await check($, t, latest))) {
      // Stopped: answer the step without sending the request.
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
    }

    const step = yield* next(e)
    if (step.usage) {
      t.spend.tokens += uncached(step.usage)
      t.spend.requests += 1
      t.spend.points = fivePoints(t.start)
      $.ui.status(status(t.spend, t.marks))
    }
    return step
  })

  // Answered with a toast and no text, so the command adds nothing to the conversation.
  on('command.run', { command: 'budget' }, async ($, e) => {
    const current = await limitsOf($)
    const changed = parse(e.args, current)
    if (changed) await $.store.set('limits', changed)
    $.ui.toast(describeLimits(changed ?? current), { timeoutMs: 10_000 })
    return {}
  })
}
