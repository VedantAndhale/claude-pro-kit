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
  HANDOFF,
} from './budget'
import type { Limits, Marks, Spend } from './budget'
import { continueMessage, handoffDoc } from './handoff'
import type { Todo } from './handoff'

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

const EDITS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

// What this session has done, for the handoff: kept for the whole session.
const tracked = { files: {} as Record<string, number>, todos: [] as Todo[] }

const join = (...parts: string[]) => parts.map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p)).join('/')

async function gitOut($: EngineInterface, cwd: string, args: string[]) {
  const ran = await $.process.run(['git', ...args], { cwd, timeoutMs: 10_000 }).catch(() => undefined)
  return ran && ran.exitCode === 0 ? ran.stdout : undefined
}

/**
 * Writes the handoff from exact session data (no model call), stops the turn,
 * clears the conversation and starts the fresh one with the handoff as its
 * first message. If the clear is refused, the handoff waits in the prompt box.
 */
async function handOff($: EngineInterface, turnId: string | undefined, reason: string) {
  const cwd = await $.session.cwd()
  const messages = await $.session.messages().catch(() => [])
  const prompts = messages.filter(m => m.role === 'user' && m.text.trim() && !m.text.trimStart().startsWith('<')).map(m => m.text)
  const lastAnswer = [...messages].reverse().find(m => m.role === 'assistant' && m.text.trim())?.text
  const now = await $.clock.now()
  const doc = handoffDoc({
    reason,
    cwd,
    prompts,
    lastAnswer,
    files: tracked.files,
    todos: tracked.todos,
    gitStatus: await gitOut($, cwd, ['status', '--short']),
    gitDiffStat: await gitOut($, cwd, ['diff', '--stat']),
    at: new Date(now).toISOString().replace('T', ' ').slice(0, 16),
  })

  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  const base = config ?? (home === undefined ? undefined : join(home, '.claude'))
  const path = base === undefined ? 'not saved' : join(base, 'handoffs', `${new Date(now).toISOString().replace(/[:.]/g, '-')}.md`)
  if (base !== undefined) await $.fs.write(path, doc).catch(() => undefined)

  if (turnId) await $.turn.abort({ turnId }).catch(() => undefined)
  $.ui.status(undefined)

  // After this hook returns: a clear and a new prompt cannot start inside it.
  $.clock.after(300, async () => {
    const message = continueMessage(doc, path)
    const cleared = await $.command
      .run({ command: 'clear' })
      .then(() => true)
      .catch(() => false)
    if (cleared) {
      tracked.files = {}
      tracked.todos = []
      await $.prompt.submit({ text: message })
      $.ui.toast(`Fresh session started from a handoff. The old conversation is in /resume. Handoff: ${path}`, { timeoutMs: 15_000 })
    } else {
      await $.prompt.fill({ text: message, mode: 'replace' }).catch(() => undefined)
      $.ui.toast(`Handoff written (${path}) and placed in the prompt box. Run /clear, then send it.`, { timeoutMs: 15_000 })
    }
  })
}

// Resolves true to go on, false when the person chose to stop.
async function check($: EngineInterface, t: Turn, latest: number | undefined): Promise<boolean> {
  if (t.isStopped) return false
  if (t.isQuiet || !isOver(t.spend, t.marks)) return true
  if (t.asking) return t.asking

  if ((await limitsOf($)).onLimit === 'handoff') {
    t.isStopped = true
    const used = question(t.spend, t.marks, t.start, latest).replace(/^This turn has used /, '').replace(/ Keep going\?$/, '')
    await handOff($, t.id, `The previous session was handed off by turn-budget: one turn used ${used}`)
    return false
  }

  t.asking = (async () => {
    let answer: string
    try {
      answer = await $.ui.ask(question(t.spend, t.marks, t.start, latest), {
        options: [HANDOFF, CONTINUE, CONTINUE_QUIETLY, STOP],
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
    if (choice === 'handoff') {
      t.isStopped = true
      await handOff($, t.id, "The previous session was handed off at the user's request when a turn crossed its budget.")
      return false
    }
    if (choice === 'stop') {
      t.isStopped = true
      await $.session
        .append({ message: { type: 'user', content: [{ type: 'text', text: stopNote(t.spend, t.marks) }] } })
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
    await $.command.register({ name: 'turn-budget', description: 'Turn budget: /turn-budget · <points> · tokens <n> · handoff|ask · off|on' })
    await $.command.register({ name: 'handoff', description: 'Write a handoff from this session (no model call) and continue in a fresh session' })
    return next(e)
  })

  // What the handoff needs: the files edited and the latest todo list.
  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined) {
      const path = (e as { file_path?: unknown }).file_path ?? (e as { notebook_path?: unknown }).notebook_path
      if (EDITS.has(e.tool) && typeof path === 'string') tracked.files[path] = (tracked.files[path] ?? 0) + 1
      const todos = (e as { todos?: unknown }).todos
      if (e.tool === 'TodoWrite' && Array.isArray(todos)) tracked.todos = todos as Todo[]
    }
    return next(e)
  })

  on('command.run', { command: 'handoff' }, async $ => {
    await handOff($, turn?.id, 'The previous session was handed off with /handoff.')
    return {}
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
  on('command.run', { command: 'turn-budget' }, async ($, e) => {
    const current = await limitsOf($)
    const changed = parse(e.args, current)
    if (changed) await $.store.set('limits', changed)
    $.ui.toast(describeLimits(changed ?? current), { timeoutMs: 10_000 })
    return {}
  })
}
