// The handoff document: built from exact session data, with no model call, so a
// fresh session can pick the work up without re-sending the old context.

export type Todo = { content: string; status: string }

export type HandoffInput = {
  /** Why the old session stopped, in one line. */
  reason: string
  cwd: string
  /** The person's prompts, oldest first. */
  prompts: string[]
  /** The last thing Claude said before the stop. */
  lastAnswer?: string
  /** Files Claude edited in the old session, with how many edits each. */
  files: Record<string, number>
  todos: Todo[]
  gitStatus?: string
  gitDiffStat?: string
  at: string
}

const PROMPTS = 5
const PROMPT_CHARS = 800
const ANSWER_CHARS = 1_200
const GIT_LINES = 40
const MAX_CHARS = 12_000

const clip = (text: string, n: number) => {
  const t = text.trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

const lines = (text: string | undefined, n: number) => {
  // Leading spaces matter: in `git status --short`, " M" is not "M ".
  const all = (text ?? '').split('\n').filter(l => l.trim() !== '')
  return all.length > n ? [...all.slice(0, n), `… ${all.length - n} more`] : all
}

const MARK: Record<string, string> = { completed: '[x]', in_progress: '[~]', pending: '[ ]' }

export const handoffDoc = (h: HandoffInput) => {
  const out: string[] = [
    `# Handoff from a previous session`,
    '',
    `${h.reason} Written ${h.at} in \`${h.cwd}\`, without a model call: everything below is taken from the session as it was.`,
    '',
    '## What the user asked (latest last, in full; earlier ones shortened)',
    // The latest prompt is what to continue: never cut, its newlines kept.
    ...h.prompts
      .slice(-PROMPTS)
      .map((p, i, all) => (i === all.length - 1 ? `${i + 1} (latest). ${p.trim()}` : `${i + 1}. ${clip(p, PROMPT_CHARS).replace(/\n+/g, ' ')}`)),
  ]
  if (h.todos.length) out.push('', '## Todo list when it stopped', ...h.todos.map(t => `- ${MARK[t.status] ?? '[ ]'} ${t.content}`))
  const files = Object.entries(h.files).sort((a, b) => b[1] - a[1])
  if (files.length) out.push('', '## Files edited', ...files.map(([f, n]) => `- \`${f}\` (${n} ${n === 1 ? 'edit' : 'edits'})`))
  const status = lines(h.gitStatus, GIT_LINES)
  if (status.length) out.push('', '## git status --short', '```', ...status, '```')
  const diff = lines(h.gitDiffStat, GIT_LINES)
  if (diff.length) out.push('', '## git diff --stat', '```', ...diff, '```')
  if (h.lastAnswer?.trim()) out.push('', '## Last thing Claude said', ...clip(h.lastAnswer, ANSWER_CHARS).split('\n').map(l => `> ${l}`))
  out.push(
    '',
    '## Next',
    'Continue the latest request. Read the files above as you need them rather than all at once, check the todo list, and ask the user if anything here is unclear.',
  )
  const doc = out.join('\n')
  // The cap leaves the latest prompt out of the count: it comes before the
  // rest, so the cut never reaches it.
  const max = MAX_CHARS + (h.prompts.at(-1)?.trim().length ?? 0)
  return doc.length > max ? `${doc.slice(0, max - 40)}\n\n… (handoff cut at ${max.toLocaleString('en-US')} characters)` : doc
}

/** The one message that starts the fresh session: the handoff itself, so nothing needs reading first. */
export const continueMessage = (doc: string, path: string) =>
  `Continue the work from my previous session. The handoff is below (also saved at ${path}).\n\n${doc}`
