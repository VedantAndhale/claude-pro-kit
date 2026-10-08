import type { Register } from 'claude-code'

// A Read with no line range on a long text file is refused once, with the
// file's exact line count, and Claude is pointed at the outline tool and a
// ranged Read instead. Retrying the same Read goes through, so nothing is ever
// out of reach. The outline is built here from the file on disk: no model call.
// A plain shell `cat FILE` or `Get-Content FILE` of such a file is held the same
// way; a ranged print (`sed -n`, `head`, `tail`) and anything else pass.

const MAX_LINES = 1000
const MAX_ENTRIES = 300
const MAX_BYTES = 4 * 1024 * 1024

// Reads Claude Code turns into something other than text lines.
const NOT_TEXT = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|ipynb)$/i

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path
const count = (n: number) => n.toLocaleString('en-US')

export const lineCount = (text: string) => (text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0))

const KEYWORD = /^(if|for|while|switch|catch|return|else|do|try|with|elif|except|match|when)\b/

const DEFINITIONS: RegExp[] = [
  // Markdown headings
  /^#{1,6}\s+\S/,
  // JavaScript and TypeScript declarations
  /^\s*(export\s+)?(default\s+)?(declare\s+)?(abstract\s+)?(async\s+)?(function\*?|class|interface|type|enum|namespace)\s+[\w$]/,
  /^(export\s+)?(const|let|var)\s+[\w$]+/,
  // Python
  /^\s*(async\s+)?(def|class)\s+\w/,
  // Go
  /^(func|type)\s+[\w(]/,
  // Rust
  /^\s*(pub(\([\w:]+\))?\s+)?(async\s+)?(unsafe\s+)?(fn|struct|enum|trait|impl|mod|macro_rules!)\s*[\w<]/,
  // Java, C#, Kotlin, Swift, PHP: a modifier-led declaration
  /^\s*((public|private|protected|internal|static|final|abstract|sealed|override|open|data|suspend)\s+)+[\w<>[\],.?\s]*[\w>]\s*[\w$]+\s*[({<]/,
  /^\s*(class|interface|struct|enum|record|object|fun|func|protocol|extension|trait)\s+\w/,
  // Methods in a class body: name(...) { or name(...): Type {
  /^\s+(static\s+|async\s+|get\s+|set\s+|override\s+)*[A-Za-z_$][\w$]*\s*(<[^>]*>)?\([^)]*\)\s*(:\s*[^={;]+)?\{\s*$/,
]

export const outline = (text: string) => {
  const lines = text.split('\n')
  const entries: string[] = []
  for (let i = 0; i < lines.length && entries.length < MAX_ENTRIES; i++) {
    const line = lines[i].replace(/\r$/, '')
    const trimmed = line.trim()
    if (trimmed.length === 0 || KEYWORD.test(trimmed)) continue
    if (DEFINITIONS.some(re => re.test(line))) {
      entries.push(`${i + 1}: ${trimmed.length > 120 ? `${trimmed.slice(0, 119)}…` : trimmed}`)
    }
  }
  return { entries, isCut: entries.length === MAX_ENTRIES }
}

export const describeOutline = (path: string, text: string) => {
  const { entries, isCut } = outline(text)
  const head = `${baseName(path)}: ${count(lineCount(text))} lines`
  if (entries.length === 0) return `${head}; no definitions found. Read a range with offset and limit.`
  return [head, ...entries, ...(isCut ? [`(first ${MAX_ENTRIES} definitions shown)`] : [])].join('\n')
}

export const refusal = (path: string, lines: number, tool: string, retry = 'Read') =>
  `${baseName(path)} has ${count(lines)} lines. Call ${tool} to see its definitions with line numbers, ` +
  `then Read only the range you need (offset, limit). Retry the same ${retry} to read it whole anyway.`

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
      if (shell !== 'Bash' && /[\u2018-\u201e]/.test(c)) return undefined
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

// The file a plain `cat FILE` or `Get-Content FILE` prints whole; undefined
// for a range (`sed -n`, `head`, `-Tail`) or anything it does not understand.
export function wholeRead(command: string, shell: string): string | undefined {
  const all = words(command, shell)
  if (all === undefined || all.length < 2) return undefined
  const [name, ...args] = all
  if (shell === 'Bash') return name === 'cat' && args.length === 1 && !args[0].startsWith('-') ? args[0] : undefined

  if (!['get-content', 'gc', 'cat', 'type'].includes(name.toLowerCase())) return undefined
  let path: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i].toLowerCase()
    if (arg === '-raw') continue
    if ((arg === '-path' || arg === '-literalpath') && path === undefined && args[i + 1] !== undefined) {
      path = args[++i]
      continue
    }
    if (arg.startsWith('-') || path !== undefined) return undefined
    path = args[i]
  }
  return path === undefined || path.startsWith('-') ? undefined : path
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
  const refusedOnce = new Set<string>()
  let outlineTool = 'mcp__read-cap__outline'
  let refusals = 0

  on('session.start', async ($, e, next) => {
    const { tool } = await $.tool.register({
      name: 'outline',
      description:
        "Lists a text file's definitions (functions, classes, types, headings) with line numbers, so you can Read only the lines you need. Use it before reading a long file.",
      inputSchema: {
        type: 'object',
        properties: { file_path: { type: 'string', description: 'Absolute path of the file' } },
        required: ['file_path'],
      },
    })
    outlineTool = tool
    return next(e)
  })

  on('tool.call', { tool: 'mcp__read-cap__outline' }, async ($, e) => {
    const path = (e as { file_path?: unknown }).file_path
    if (typeof path !== 'string') return { deny: 'outline needs file_path.' }
    const text = await $.fs.read(path).catch((err: unknown) => err)
    if (typeof text !== 'string') return { deny: `outline could not read ${baseName(path)}: ${String(text)}` }
    return { result: describeOutline(path, text) }
  })

  // The line count of a long text file read whole, once per loop and file;
  // undefined lets the read through. A Read and a shell read share the hold.
  type Fs = { stat: () => Promise<{ kind: string; size: number }>; read: () => Promise<unknown> }
  const longFile = async (fs: Fs, path: string, agentId: string | undefined) => {
    if (NOT_TEXT.test(path)) return undefined
    const stat = await fs.stat().catch(() => undefined)
    if (!stat || stat.kind !== 'file' || stat.size > MAX_BYTES) return undefined

    const key = `${agentId ?? 'main'}|${path.replace(/\\/g, '/').toLowerCase()}`
    if (refusedOnce.delete(key)) return undefined

    const text = await fs.read().catch(() => undefined)
    const lines = typeof text === 'string' ? lineCount(text) : 0
    if (lines <= MAX_LINES) return undefined

    refusedOnce.add(key)
    refusals += 1
    return lines
  }

  const capped = () => `${refusals} whole-file ${refusals === 1 ? 'read' : 'reads'} capped`

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    if (e.limit !== undefined || e.offset !== undefined || e.pages !== undefined) return next(e)
    const fs = { stat: () => $.fs.stat(e.file_path), read: () => $.fs.read(e.file_path) }
    const lines = await longFile(fs, e.file_path, e.agentId)
    if (lines === undefined) return next(e)

    $.ui.status(capped())
    return { deny: refusal(e.file_path, lines, outlineTool) }
  })

  // `cat FILE` or `Get-Content FILE` of a long file; a ranged print passes.
  on('tool.call', async ($, e, next) => {
    if ((e.tool !== 'Bash' && e.tool !== 'PowerShell') || typeof e.command !== 'string') return next(e)
    const typed = wholeRead(e.command, e.tool)
    const cwd = typed === undefined ? undefined : await $.session.cwd().catch(() => undefined)
    const path = typed === undefined || cwd === undefined ? undefined : absolute(typed, cwd)
    if (path === undefined) return next(e)
    const fs = { stat: () => $.fs.stat(path), read: () => $.fs.read(path) }
    const lines = await longFile(fs, path, e.agentId)
    if (lines === undefined) return next(e)

    $.ui.status(capped())
    return { deny: refusal(path, lines, outlineTool, 'command') }
  })
}
