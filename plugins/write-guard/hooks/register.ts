import type { Register } from 'claude-code'

// A Write over an existing file sends the whole file as output tokens, where an
// Edit sends only the changed lines. A hook runs after the model has written
// the content, so the first rewrite in a loop goes through with a note; a later
// one is held back once so the model switches to Edit. Retrying the same path
// right after a hold always goes through, for a deliberate full rewrite.

// Files under this size cost little to rewrite; they are left alone.
const MIN_BYTES = 2048

const baseName = (path: string) => path.split(/[\/]/).pop() ?? path

export const register: Register = on => {
  const noted = new Set<string>()
  const heldOnce = new Set<string>()
  let held = 0

  const loopOf = (agentId: string | undefined) => agentId ?? 'main'

  const forget = (loop?: string) => {
    if (loop === undefined) noted.clear()
    else noted.delete(loop)
    for (const key of [...heldOnce]) {
      if (loop === undefined || key.startsWith(`${loop}|`)) heldOnce.delete(key)
    }
  }

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const stat = await $.fs.stat(e.file_path, { resolve: true }).catch(() => undefined)
    if (!stat || stat.kind !== 'file' || stat.size < MIN_BYTES) return next(e)

    const loop = loopOf(e.agentId)
    const key = `${loop}|${(stat.realPath ?? e.file_path).toLowerCase()}`
    const name = baseName(e.file_path)

    if (!noted.has(loop)) {
      noted.add(loop)
      const ran = await next(e)
      if (ran.deny !== undefined || ran.isError === true) return ran

      // Short on purpose: the model reads it.
      return { ...ran, context: [...(ran.context ?? []), `You rewrote all of ${name}. For changes to an existing file use Edit: it sends only the changed lines.`] }
    }

    if (!heldOnce.has(key)) {
      heldOnce.add(key)
      held += 1
      $.ui.status(`${held} full ${held === 1 ? 'rewrite' : 'rewrites'} held back`)
      return { deny: `${name} exists; change it with Edit, not a full Write. If a full rewrite is intended, retry the same Write.` }
    }

    heldOnce.delete(key)
    return next(e)
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
