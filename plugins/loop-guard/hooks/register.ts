import type { Register } from 'claude-code'

// Every retry of a failing command re-sends the whole conversation. Once the
// exact same command has failed twice in a row in a loop, the next try is held
// back once and the model is told to change approach. Retrying it right after
// the hold always goes through, for a command that is flaky on purpose.

const FAILS_BEFORE_HOLD = 2
const MAX_TRACKED = 200

const SHELLS = new Set(['Bash', 'PowerShell'])

export const register: Register = on => {
  const fails = new Map<string, number>()
  const heldOnce = new Set<string>()
  let held = 0

  const loopOf = (agentId: string | undefined) => agentId ?? 'main'

  const forget = (loop?: string) => {
    for (const key of [...fails.keys()]) {
      if (loop === undefined || key.startsWith(`${loop}|`)) fails.delete(key)
    }
    for (const key of [...heldOnce]) {
      if (loop === undefined || key.startsWith(`${loop}|`)) heldOnce.delete(key)
    }
  }

  on('tool.call', async ($, e, next) => {
    if (!SHELLS.has(e.tool) || typeof e.command !== 'string') return next(e)

    const key = `${loopOf(e.agentId)}|${e.command.trim()}`
    if ((fails.get(key) ?? 0) >= FAILS_BEFORE_HOLD && !heldOnce.has(key)) {
      heldOnce.add(key)
      held += 1
      $.ui.status(`${held} failing ${held === 1 ? 'retry' : 'retries'} held back`)
      // Short on purpose: the model reads it.
      return { deny: `This exact command failed ${fails.get(key)} times in a row. Change the approach instead of rerunning it. If a rerun is intended, retry the same command.` }
    }

    heldOnce.delete(key)
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    if (ran.isError === true) {
      fails.set(key, (fails.get(key) ?? 0) + 1)
      if (fails.size > MAX_TRACKED) fails.delete(fails.keys().next().value as string)
    } else {
      fails.delete(key)
    }

    return ran
  })

  // A compaction replaces that loop's history with a summary.
  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (e.trigger !== 'precompute' && done.skip === undefined) forget(loopOf(e.agentId))

    return done
  })

  // /clear starts a fresh conversation.
  on('session.end', async ($, e, next) => {
    forget()

    return next(e)
  })
}
