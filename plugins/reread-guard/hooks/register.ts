import type { Register } from 'claude-code'

// A Read is skipped when the same loop already read the same range of the same
// file and the file's size and modification time have not moved since. The
// engine can clear old tool results from context, so a second attempt at the
// exact same Read right after a skip always goes through.
//
// A shell command that only prints one file (`cat`, `sed -n 'A,Bp'`, `head`,
// `tail`, `Get-Content`) is treated the same way. Anything else, a pipe, a
// chain, a variable or a flag not listed here, runs untouched.

const MAX_TRACKED = 500

// What a Read with no range shows of a file: past this it cuts lines.
const READ_LINES = 2000
const READ_LINE_CHARS = 2000

// Reads Claude Code turns into something other than text lines.
const NOT_TEXT = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|ipynb)$/i

type Seen = { size: number; mtimeMs: number }

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path

// Characters a word may hold outside quotes; anything else (a pipe, redirect,
// chain, variable, glob, escape, `~`) could make the shell do more than read.
const BASH_PLAIN = /[\p{L}\p{N}_.\-/:+,@%=]/u
const PWSH_PLAIN = /[\p{L}\p{N}_.\-/:\\]/u

// Splits a command into words with their quotes removed; undefined when any
// part is not plain.
export function words(command: string, shell: string): string[] | undefined {
  const out: string[] = []
  const text = command.trim()
  let cur: string | undefined
  let quote: string | undefined
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote !== undefined) {
      // PowerShell also closes a string on a typographic quote.
      if (shell !== 'Bash' && /[‘-„]/.test(c)) return undefined
      if (c === quote) {
        // PowerShell spells a quote inside quotes by doubling it.
        if (shell !== 'Bash' && text[i + 1] === quote) return undefined
        quote = undefined
      } else if (quote === '"' && /[$`]/.test(c)) return undefined
      else if (quote === '"' && shell === 'Bash' && /[\\!]/.test(c)) return undefined
      else cur += c
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      cur ??= ''
      continue
    }
    if (c === ' ' || c === '\t') {
      if (cur !== undefined) out.push(cur)
      cur = undefined
      continue
    }
    if (!(shell === 'Bash' ? BASH_PLAIN : PWSH_PLAIN).test(c)) return undefined
    cur = (cur ?? '') + c
  }
  if (quote !== undefined) return undefined
  if (cur !== undefined) out.push(cur)
  return out
}

const count = (word: string | undefined) => (word !== undefined && /^[1-9]\d*$/.test(word) ? Number(word) : undefined)

// `-n N`, `-nN` or `-N`, the only flags head and tail take here.
const lineFlag = (flags: string[], isTail: boolean) => {
  const word =
    flags.length === 2 && flags[0] === '-n' ? flags[1]
    : flags.length === 1 && /^-n./.test(flags[0]) ? flags[0].slice(2)
    : flags.length === 1 && /^-\d/.test(flags[0]) ? flags[0].slice(1)
    : undefined
  if (isTail && word?.startsWith('+') === true) {
    const from = count(word.slice(1))
    return from === undefined ? undefined : `${from}-end`
  }
  const n = count(word)
  return n === undefined ? undefined : isTail ? `last ${n}` : `1-${n}`
}

// One plain read of one file: its path as typed and the lines it prints, ''
// for the whole file. Undefined for any command it does not fully understand.
export function shellRead(command: string, shell: string): { path: string; range: string } | undefined {
  const all = words(command, shell)
  if (all === undefined || all.length < 2) return undefined
  const [name, ...args] = all

  if (shell === 'Bash') {
    const path = args[args.length - 1]
    const flags = args.slice(0, -1)
    if (path.startsWith('-')) return undefined
    if (name === 'cat' && flags.length === 0) return { path, range: '' }
    if (name === 'sed' && flags.length === 2 && flags[0] === '-n') {
      const hit = flags[1].match(/^(\d+)(?:,(\d+))?p$/)
      const from = count(hit?.[1])
      const to = hit?.[2] === undefined ? from : count(hit[2])
      return from === undefined || to === undefined || to < from ? undefined : { path, range: `${from}-${to}` }
    }
    if (name === 'head' || name === 'tail') {
      const range = lineFlag(flags, name === 'tail')
      return range === undefined ? undefined : { path, range }
    }
    return undefined
  }

  if (!['get-content', 'gc', 'cat', 'type'].includes(name.toLowerCase())) return undefined
  let path: string | undefined
  let range = ''
  for (let i = 0; i < args.length; i++) {
    const arg = args[i].toLowerCase()
    if (arg === '-raw') continue
    if (arg === '-path' || arg === '-literalpath') {
      if (path !== undefined || args[i + 1] === undefined) return undefined
      path = args[++i]
      continue
    }
    if (/^-(totalcount|head|first|tail|last)$/.test(arg)) {
      const n = count(args[++i])
      if (range !== '' || n === undefined) return undefined
      range = /^-(tail|last)$/.test(arg) ? `last ${n}` : `1-${n}`
      continue
    }
    if (arg.startsWith('-') || path !== undefined) return undefined
    path = args[i]
  }
  return path === undefined || path.startsWith('-') ? undefined : { path, range }
}

// The path a shell resolves, given its working directory; undefined when it
// cannot be placed with certainty (Git Bash's own `/tmp`, `\x`, `D:x`).
export function absolute(path: string, cwd: string): string | undefined {
  const isWindows = /^[A-Za-z]:[\\/]/.test(cwd)
  // Git Bash spells D:\x as /d/x.
  const drive = isWindows ? path.match(/^\/([A-Za-z])(\/.*)?$/) : null
  if (drive !== null) return `${drive[1]}:${drive[2] ?? '/'}`
  if (/^[A-Za-z]:[\\/]/.test(path)) return isWindows ? path : undefined
  if (path.startsWith('/')) return isWindows ? undefined : path
  if (path.startsWith('\\') || /^[A-Za-z]:/.test(path)) return undefined
  return `${cwd.replace(/[\\/]+$/, '')}/${path}`
}

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

  const isUnchanged = (before: Seen | undefined, stat: Seen) =>
    before !== undefined && before.size === stat.size && before.mtimeMs === stat.mtimeMs

  // Claimed before the read runs, so an identical read sent in the same
  // batch is skipped too; given back if this one fails.
  const claim = (key: string, stat: Seen) => {
    skippedOnce.delete(key)
    seen.set(key, { size: stat.size, mtimeMs: stat.mtimeMs })
    if (seen.size > MAX_TRACKED) seen.delete(seen.keys().next().value as string)
  }

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const stat = await $.fs.stat(e.file_path, { resolve: true }).catch(() => undefined)
    if (!stat || stat.kind !== 'file') return next(e)

    const where = (stat.realPath ?? e.file_path).toLowerCase()
    const key = [loopOf(e.agentId), where, e.offset ?? '', e.limit ?? '', e.pages ?? ''].join('|')

    if (isUnchanged(seen.get(key), stat) && !skippedOnce.has(key)) {
      skippedOnce.add(key)
      skips += 1
      $.ui.status(`${skips} re-${skips === 1 ? 'read' : 'reads'} skipped`)
      return {
        // Short on purpose: the model reads it.
        deny: `${baseName(e.file_path)} unchanged since you read it; use that copy. If it's gone from context, retry the same Read.`,
      }
    }

    claim(key, stat)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) seen.delete(key)

    return ran
  })

  // A shell read is only recorded under its own key, never as a Read: the
  // Edit tool needs a real Read of the file first.
  on('tool.call', async ($, e, next) => {
    if ((e.tool !== 'Bash' && e.tool !== 'PowerShell') || typeof e.command !== 'string') return next(e)
    const read = shellRead(e.command, e.tool)
    if (read === undefined) return next(e)
    const cwd = await $.session.cwd().catch(() => undefined)
    const path = cwd === undefined ? undefined : absolute(read.path, cwd)
    if (path === undefined) return next(e)
    const stat = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
    if (!stat || stat.kind !== 'file' || stat.realPath === undefined) return next(e)

    const where = stat.realPath.toLowerCase()
    const loop = loopOf(e.agentId)
    const key = [loop, where, 'shell', read.range].join('|')

    // A whole Read before a whole `cat` counts when that Read showed every line.
    const sawAll = async () => {
      if (read.range !== '' || NOT_TEXT.test(where) || !isUnchanged(seen.get([loop, where, '', '', ''].join('|')), stat)) return false
      const text = await $.fs.read(stat.realPath as string).catch(() => undefined)
      if (typeof text !== 'string') return false
      const lines = text.split('\n')
      return lines.length - (text.endsWith('\n') ? 1 : 0) <= READ_LINES && lines.every(line => line.length <= READ_LINE_CHARS)
    }

    if (!skippedOnce.has(key) && (isUnchanged(seen.get(key), stat) || (await sawAll()))) {
      skippedOnce.add(key)
      skips += 1
      $.ui.status(`${skips} re-${skips === 1 ? 'read' : 'reads'} skipped`)
      return {
        deny: `${baseName(path)} unchanged since you read it; use that copy. If it's gone from context, retry the same command.`,
      }
    }

    claim(key, stat)
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
