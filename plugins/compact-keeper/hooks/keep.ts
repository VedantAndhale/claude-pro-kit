// The note compact-keeper adds after a compaction: facts copied from the
// session as they were, with no model call, so the summary cannot lose them.

export type Todo = { content: string; status: string }

export type Failure = { tool: string; command: string; exitCode?: number }

export type KeepInput = {
  /** The user's typed prompts, oldest first. */
  prompts: string[]
  /** Files edited this session, with how many edits each. */
  files: Record<string, number>
  todos: Todo[]
  failure?: Failure
}

export type Kept = { text: string; prompts: number; files: number; todos: number; failure: boolean }

export const TITLE = 'Kept exactly (compact-keeper)'
export const EARLIER = 4
export const EARLIER_CHARS = 600
export const MAX_CHARS = 4_000
const COMMAND_CHARS = 600

const MARK: Record<string, string> = { completed: '[x]', in_progress: '[~]', pending: '[ ]' }

const clip = (text: string, n: number) => {
  const t = text.trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

// Text the engine or a plugin put in a user message: never something typed.
const INJECTED = [
  TITLE,
  'This session is being continued from a previous conversation',
  'Caveat: The messages below were generated',
  '[Request interrupted',
  '[turn-budget]',
]

const stripReminders = (text: string) => text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()

/** A prompt worth keeping: not empty, not a bare slash command, not /compact or /clear. */
export const isKeepable = (text: string) => {
  const t = text.trim()
  return t !== '' && !/^\/[\w:-]+$/.test(t) && !/^\/(compact|clear)(\s|$)/.test(t)
}

type Row = { role: string; text: string; toolResults?: readonly unknown[] }

/**
 * The user's own prompts in a transcript, oldest first. Messages carry no
 * origin, so this leaves out what is known not to be typed: tool results,
 * <tags> (reminders, task notifications, command output), a plugin's framed
 * message, a compaction summary, and this plugin's own note.
 */
export const promptsIn = (messages: readonly Row[]) =>
  messages
    .filter(m => m.role === 'user' && !(m.toolResults?.length ?? 0))
    .map(m => stripReminders(m.text))
    .filter(t => isKeepable(t) && !t.startsWith('<') && !/^The [\w@./-]+ plugin sent a message/.test(t))
    .filter(t => !INJECTED.some(p => t.startsWith(p)))

/**
 * Prompts recorded as typed are the source; the transcript fills in the ones
 * before the first recorded one (a resumed session, a plugin loaded late).
 */
export const mergePrompts = (tracked: string[], inMessages: string[]) => {
  if (tracked.length === 0) return inMessages
  const first = tracked[0]!.trim()
  const at = inMessages.findIndex(t => t.startsWith(first))
  return at > 0 ? [...inMessages.slice(0, at), ...tracked] : tracked
}

/** The exit code a shell tool's error text names, e.g. "Exit code 2". */
export const exitCodeOf = (text: string | undefined) => {
  const m = /exit(?:\s+code)?[:\s]+(-?\d+)/i.exec(text ?? '')
  return m ? Number(m[1]) : undefined
}

const section = (title: string, body: string[]) => ['', '', `## ${title}`, ...body].join('\n')

const cutTo = (title: string, body: string[], room: number) => {
  // Whole lines only, with a count of what was left out.
  for (let n = body.length; n > 0; n--) {
    const s = section(title, n === body.length ? body : [...body.slice(0, n), `… ${body.length - n} more`])
    if (s.length <= room) return { s, n }
  }
  return { s: '', n: 0 }
}

/** Builds the note, or undefined when there is nothing to keep. */
export const keptNote = (k: KeepInput): Kept | undefined => {
  const prompts = k.prompts.filter(isKeepable)
  const files = Object.entries(k.files).sort((a, b) => b[1] - a[1])
  if (!prompts.length && !files.length && !k.todos.length && !k.failure) return undefined

  const head = [
    TITLE,
    'These are verbatim facts from before the compaction, copied from the session without a model call. Where the summary differs, trust these.',
  ].join('\n')

  // The latest prompt is never dropped: cut only when it alone is over the cap.
  const latest = prompts.at(-1)
  let latestPart = ''
  if (latest !== undefined) {
    const title = 'Latest user prompt (in full)'
    latestPart = section(title, [latest.trim()])
    if (head.length + latestPart.length > MAX_CHARS) {
      const mark = `\n… [cut by compact-keeper: the prompt is ${latest.trim().length.toLocaleString('en-US')} characters]`
      const room = MAX_CHARS - head.length - section(title, ['']).length - mark.length
      latestPart = section(title, [latest.trim().slice(0, Math.max(0, room)) + mark])
    }
  }
  let room = MAX_CHARS - head.length - latestPart.length

  const fit = (title: string, body: string[]) => {
    if (!body.length || room <= 0) return { s: '', n: 0 }
    const got = cutTo(title, body, room)
    room -= got.s.length
    return got
  }
  const todos = fit('Todo list', k.todos.map(t => `- ${MARK[t.status] ?? '[ ]'} ${t.content}`))
  const failLine = k.failure
    ? `\`${clip(k.failure.command, COMMAND_CHARS)}\` (${k.failure.tool}, ${k.failure.exitCode === undefined ? 'no exit code reported' : `exit code ${k.failure.exitCode}`})`
    : undefined
  const failure = fit('Last failed shell command', failLine ? [failLine] : [])
  const edited = fit('Files edited this session', files.map(([f, n]) => `- \`${f}\` (${plural(n, 'edit', 'edits')})`))

  // Earlier prompts last into the budget, newest first, so the oldest go first.
  const earlier = prompts.slice(0, -1).slice(-EARLIER).map(p => clip(p, EARLIER_CHARS).replace(/\s*\n\s*/g, ' '))
  let kept = 0
  for (let n = earlier.length; n > 0; n--) {
    const s = section(`Earlier user prompts (oldest first, each cut at ${EARLIER_CHARS} characters)`, earlier.slice(-n).map((p, i) => `${i + 1}. ${p}`))
    if (s.length <= room) {
      kept = n
      break
    }
  }
  const earlierPart = kept
    ? section(`Earlier user prompts (oldest first, each cut at ${EARLIER_CHARS} characters)`, earlier.slice(-kept).map((p, i) => `${i + 1}. ${p}`))
    : ''

  const text = head + earlierPart + latestPart + todos.s + failure.s + edited.s
  return {
    text,
    prompts: kept + (latest === undefined ? 0 : 1),
    files: edited.n,
    todos: todos.n,
    failure: failure.n > 0,
  }
}

export const toastOf = (k: Kept) =>
  `compact-keeper kept ${plural(k.prompts, 'prompt', 'prompts')}, ${plural(k.files, 'file', 'files')}, ${plural(k.todos, 'todo', 'todos')}` +
  `${k.failure ? ', the last failed command' : ''} (${plural(k.text.length, 'char', 'chars')})`
