import type { Register } from 'claude-code'

// A Read with no line range on a long text file is refused once, with the
// file's exact line count, and Claude is pointed at the outline tool and a
// ranged Read instead. Retrying the same Read goes through, so nothing is ever
// out of reach. The outline is built here from the file on disk: no model call.

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

export const refusal = (path: string, lines: number, tool: string) =>
  `${baseName(path)} has ${count(lines)} lines. Call ${tool} to see its definitions with line numbers, ` +
  `then Read only the range you need (offset, limit). Retry the same Read to read it whole anyway.`

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

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    if (e.limit !== undefined || e.offset !== undefined || e.pages !== undefined || NOT_TEXT.test(e.file_path)) return next(e)
    const stat = await $.fs.stat(e.file_path).catch(() => undefined)
    if (!stat || stat.kind !== 'file' || stat.size > MAX_BYTES) return next(e)

    const key = `${e.agentId ?? 'main'}|${e.file_path.toLowerCase()}`
    if (refusedOnce.delete(key)) return next(e)

    const text = await $.fs.read(e.file_path).catch(() => undefined)
    const lines = text === undefined ? 0 : lineCount(text)
    if (lines <= MAX_LINES) return next(e)

    refusedOnce.add(key)
    refusals += 1
    $.ui.status(`${refusals} whole-file ${refusals === 1 ? 'read' : 'reads'} capped`)
    return { deny: refusal(e.file_path, lines, outlineTool) }
  })
}
