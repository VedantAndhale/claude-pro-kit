// The trimming itself: pure, so the tests exercise it directly.

export const TOOLS = new Set(['Bash', 'PowerShell', 'BashOutput'])

// Claude Code itself cuts the middle out of a long shell result before any
// mod sees it; this trims what is left to its head, tail and error lines.
const MAX_LINES = 120
const MAX_CHARS = 8_000

const HEAD = 30
const TAIL = 50
const MAX_SIGNAL = 40
const MAX_LINE_CHARS = 400

const SIGNAL = /\b(error|errors|fail|failed|failure|exception|panic|traceback|fatal|assert|warning|denied|not found|undefined)\b|ERR!|✗|✘|×/i

export type Block = { type: string; [field: string]: unknown }

export const textOf = (content: unknown): string | undefined => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const blocks = content as Block[]
  if (!blocks.every(b => b.type === 'text' && typeof b.text === 'string')) return undefined
  return blocks.map(b => b.text as string).join('\n')
}

const clip = (line: string) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)} [… line cut]` : line)

export const diet = (text: string, savedAt: string): string | undefined => {
  const lines = text.split('\n')
  if (lines.length <= MAX_LINES && text.length <= MAX_CHARS) return undefined

  const head = lines.slice(0, HEAD)
  const tailStart = Math.max(HEAD, lines.length - TAIL)
  const tail = lines.slice(tailStart)
  const signal: string[] = []
  for (let i = HEAD; i < tailStart && signal.length < MAX_SIGNAL; i++) {
    if (SIGNAL.test(lines[i])) signal.push(`${String(i + 1).padStart(6)}│ ${clip(lines[i])}`)
  }

  const shown = head.length + signal.length + tail.length
  const body = [
    ...head.map(clip),
    ...(tailStart > HEAD ? [`… [lines ${HEAD + 1}–${tailStart} omitted${signal.length ? '; error/warning lines from them:' : ''}]`] : []),
    ...signal,
    ...(signal.length ? ['…'] : []),
    ...tail.map(clip),
  ].join('\n')

  // Short on purpose: the model reads it.
  const note = `[output-diet: ${shown}/${lines.length} lines shown; all ${lines.length} in ${savedAt}]`

  return `${note}\n\n${body}`
}
