import type { Register } from 'claude-code'

// A Read is skipped when the same loop already read the same range of the same
// file and the file's size and modification time have not moved since. The
// engine can clear old tool results from context, so a second attempt at the
// exact same Read right after a skip always goes through.

const MAX_TRACKED = 500

type Seen = { size: number; mtimeMs: number }

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path

export const register: Register = on => {
  const seen = new Map<string, Seen>()
  const skippedOnce = new Set<string>()
  let skips = 0

  const loopOf = (agentId: string | undefined) => agentId ?? 'main'

  const forget = (loop?: string) => {
    for (const key of [...seen.keys()]) {
      if (loop === undefined || key.startsWith(`${loop}|`)) seen.delete(key)
    }
    for (const key of [...skippedOnce]) {
      if (loop === undefined || key.startsWith(`${loop}|`)) skippedOnce.delete(key)
    }
  }

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const stat = await $.fs.stat(e.file_path, { resolve: true }).catch(() => undefined)
    if (!stat || stat.kind !== 'file') return next(e)

    const where = (stat.realPath ?? e.file_path).toLowerCase()
    const key = [loopOf(e.agentId), where, e.offset ?? '', e.limit ?? '', e.pages ?? ''].join('|')
    const before = seen.get(key)
    const isUnchanged = before !== undefined && before.size === stat.size && before.mtimeMs === stat.mtimeMs

    if (isUnchanged && !skippedOnce.has(key)) {
      skippedOnce.add(key)
      skips += 1
      $.ui.status(`${skips} re-${skips === 1 ? 'read' : 'reads'} skipped`)
      return {
        // Short on purpose: the model reads it.
        deny: `${baseName(e.file_path)} unchanged since you read it; use that copy. If it's gone from context, retry the same Read.`,
      }
    }

    // Claimed before the read runs, so an identical read sent in the same
    // batch is skipped too; given back if this one fails.
    skippedOnce.delete(key)
    seen.set(key, { size: stat.size, mtimeMs: stat.mtimeMs })
    if (seen.size > MAX_TRACKED) seen.delete(seen.keys().next().value as string)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) seen.delete(key)

    return ran
  })

  // A compaction replaces what that loop had read with a summary.
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
