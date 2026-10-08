import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { exitCodeOf, keptNote, mergePrompts, promptsIn, toastOf } from './keep'
import type { Failure, Todo } from './keep'

// A compaction replaces the conversation with a model-written summary, which
// can drop or paraphrase what matters most. After the main conversation's
// compaction this adds one message with exact facts from before it: the
// user's latest prompt in full, a few earlier ones, the files edited, the todo
// list and the last failed shell command. No model call.

const PANE = 'compact-keeper'
const EDITS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const SHELLS = new Set(['Bash', 'PowerShell'])
const PROMPTS = 5

const lastNote = atom({ plugin: 'compact-keeper', key: 'lastNote' } as const, null as string | null)

// Origins that are the person's own words (PromptOrigin): not a
// notification, a peer, a schedule or a plugin's framed message.
const isTyped = (o: { kind: string; asUser?: true } | undefined) =>
  o === undefined || ['composer', 'bridge', 'sdk', 'slack-ping'].includes(o.kind) || (o.kind === 'plugin' && o.asUser === true)

// What this session has done: kept across compactions, reset on /clear.
const tracked = { prompts: [] as string[], files: {} as Record<string, number>, todos: [] as Todo[], failure: undefined as Failure | undefined }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'compact-keeper', description: 'Show what compact-keeper kept at the last compaction' })
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const done = await next(e)
    if (done.drop === undefined && isTyped(e.origin) && done.text.trim()) {
      tracked.prompts = [...tracked.prompts, done.text].slice(-PROMPTS)
    }
    return done
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined || ran.deny !== undefined) return ran

    const path = (e as { file_path?: unknown }).file_path ?? (e as { notebook_path?: unknown }).notebook_path
    if (EDITS.has(e.tool) && typeof path === 'string' && ran.isError !== true) tracked.files[path] = (tracked.files[path] ?? 0) + 1

    const todos = (e as { todos?: unknown }).todos
    if (e.tool === 'TodoWrite' && Array.isArray(todos) && ran.isError !== true) tracked.todos = todos as Todo[]

    const command = (e as { command?: unknown }).command
    if (SHELLS.has(e.tool) && typeof command === 'string') {
      if (ran.isError === true) {
        const said = ran.text ?? (typeof ran.result === 'string' ? ran.result : undefined)
        tracked.failure = { tool: e.tool, command: command.trim(), exitCode: exitCodeOf(said) }
      } else if (tracked.failure?.command === command.trim()) {
        // The same command passed since: that failure is no longer a fact.
        tracked.failure = undefined
      }
    }
    return ran
  })

  on('session.compact', async ($, e, next) => {
    // A subagent's own compaction, and a precompute (nothing installed yet:
    // the compaction that uses it comes through here again), pass untouched.
    if (e.agentId !== undefined || e.trigger === 'precompute') return next(e)

    const prompts = mergePrompts(tracked.prompts, promptsIn(e.messages))
    const done = await next(e)
    if (done.skip !== undefined) return done

    const kept = keptNote({ prompts, files: tracked.files, todos: tracked.todos, failure: tracked.failure })
    if (!kept) return done

    await update($, lastNote, () => kept.text)
    $.ui.toast(toastOf(kept), { timeoutMs: 10_000 })
    return { ...done, messages: [...done.messages, { role: 'user' as const, text: kept.text, toolUses: [] }] }
  })

  // /clear starts a fresh conversation, with nothing kept from the old one.
  on('session.end', async ($, e, next) => {
    tracked.prompts = []
    tracked.files = {}
    tracked.todos = []
    tracked.failure = undefined
    await update($, lastNote, () => null)
    return next(e)
  })

  // Answered with no text: opening the pane adds nothing to the conversation.
  on('command.run', { command: 'compact-keeper' }, async $ => {
    await $.ui.open({ id: PANE, title: 'compact-keeper' })
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const note = await read($, lastNote)
    if (note === null) return <Text dimColor>No compaction yet this session</Text>
    return (
      <Box flexDirection="column">
        {note.split('\n').map(line => (
          <Text bold={line.startsWith('## ') || line === note.split('\n')[0]}>{line === '' ? ' ' : line}</Text>
        ))}
      </Box>
    )
  })
}
