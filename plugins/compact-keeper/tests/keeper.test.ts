import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { EARLIER_CHARS, MAX_CHARS, TITLE, exitCodeOf, keptNote, mergePrompts, promptsIn, toastOf } from '../hooks/keep'

const user = (text: string, extra: object = {}) => ({ role: 'user' as const, text, toolUses: [], ...extra })
const assistant = (text: string) => ({ role: 'assistant' as const, text, toolUses: [] })

describe('which prompts are kept', () => {
  test('only what the user typed: no tool results, reminders, notifications or injected text', () => {
    const got = promptsIn([
      user('fix the parser'),
      assistant('on it'),
      user('', { toolResults: [{ tool_use_id: 't', text: 'ok', isError: false }] }),
      user('tool output', { toolResults: [{ tool_use_id: 't', text: 'ok', isError: false }] }),
      user('<system-reminder>todo list is empty</system-reminder>'),
      user('<task-notification>task 3 done</task-notification>'),
      user('<command-name>/model</command-name>'),
      user('The turn-budget plugin sent a message: hello'),
      user('This session is being continued from a previous conversation that ran out of context.'),
      user(`${TITLE}\nold note`),
      user('[Request interrupted by user]'),
      user('/compact'),
      user('and add tests<system-reminder>a file changed</system-reminder>'),
    ])
    expect(got).toEqual(['fix the parser', 'and add tests'])
  })

  test('tracked prompts lead; the transcript fills in the ones before them', () => {
    expect(mergePrompts(['c', 'd'], ['a', 'b', 'c', 'd'])).toEqual(['a', 'b', 'c', 'd'])
    expect(mergePrompts(['c', 'd'], ['x', 'y'])).toEqual(['c', 'd'])
    expect(mergePrompts([], ['a', 'b'])).toEqual(['a', 'b'])
  })

  test('reads the exit code from the error text', () => {
    expect(exitCodeOf('Exit code 2\nnpm ERR!')).toBe(2)
    expect(exitCodeOf('exit 1')).toBe(1)
    expect(exitCodeOf('Interrupted')).toBeUndefined()
  })
})

describe('the note', () => {
  test('latest prompt in full, up to 4 earlier ones cut at 600 characters', () => {
    const long = 'x'.repeat(2_000)
    const k = keptNote({ prompts: ['p1', 'p2', 'y'.repeat(900), 'p4', 'p5', long], files: {}, todos: [] })!
    expect(k.text).toContain(`## Latest user prompt (in full)\n${long}`)
    expect(k.text).not.toContain('p1')
    expect(k.text).toContain('1. p2')
    expect(k.text).toContain(`2. ${'y'.repeat(EARLIER_CHARS - 1)}…`)
    expect(k.text).not.toContain('y'.repeat(EARLIER_CHARS))
    expect(k.text).toContain('4. p5')
    expect(k.prompts).toBe(5)
    expect(k.text.length).toBeLessThanOrEqual(MAX_CHARS)
  })

  test('over 4,000 characters, the oldest prompts go first and the latest stays whole', () => {
    const k = keptNote({ prompts: ['a'.repeat(600), 'b'.repeat(600), 'c'.repeat(600), 'd'.repeat(600), 'e'.repeat(2_000)], files: {}, todos: [] })!
    expect(k.text.length).toBeLessThanOrEqual(MAX_CHARS)
    expect(k.text).not.toContain('aaa')
    expect(k.text).not.toContain('bbb')
    expect(k.text).toContain('c'.repeat(599))
    expect(k.text).toContain('d'.repeat(599))
    expect(k.text).toContain('e'.repeat(2_000))
    expect(k.prompts).toBe(3)
  })

  test('a latest prompt over the cap alone is cut, and the cut is marked', () => {
    const k = keptNote({ prompts: ['older', 'z'.repeat(9_000)], files: { '/a.ts': 1 }, todos: [] })!
    expect(k.text.length).toBeLessThanOrEqual(MAX_CHARS)
    expect(k.text).toContain('… [cut by compact-keeper: the prompt is 9,000 characters]')
    expect(k.text).not.toContain('older')
    expect(k.prompts).toBe(1)
  })

  test('sections with nothing in them are left out', () => {
    const k = keptNote({ prompts: ['only this'], files: {}, todos: [] })!
    expect(k.text).toContain('verbatim facts from before the compaction')
    expect(k.text).not.toContain('## Earlier')
    expect(k.text).not.toContain('## Todo')
    expect(k.text).not.toContain('## Files')
    expect(k.text).not.toContain('## Last failed')
    expect(keptNote({ prompts: [], files: {}, todos: [] })).toBeUndefined()
  })

  test('todos, files and the failed command with exact figures; the toast counts them', () => {
    const k = keptNote({
      prompts: ['one', 'two'],
      files: { '/r/a.ts': 1, '/r/b.ts': 3 },
      todos: [
        { content: 'Write tests', status: 'in_progress' },
        { content: 'Ship', status: 'pending' },
        { content: 'Plan', status: 'completed' },
      ],
      failure: { tool: 'Bash', command: 'npm test', exitCode: 1 },
    })!
    expect(k.text).toContain('- [~] Write tests\n- [ ] Ship\n- [x] Plan')
    expect(k.text).toContain('- `/r/b.ts` (3 edits)\n- `/r/a.ts` (1 edit)')
    expect(k.text).toContain('`npm test` (Bash, exit code 1)')
    expect(toastOf(k)).toBe(`compact-keeper kept 2 prompts, 2 files, 3 todos, the last failed command (${k.text.length.toLocaleString('en-US')} chars)`)
  })
})

// The engine's side: a compaction that answers with a summary message.
const engine = (on: On, skip?: string) => {
  const sent = { toasts: [] as string[], opened: 0 }
  on('command.register', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    sent.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => {
    sent.opened += 1
    return { value: { isOpen: true } } as never
  })
  on('prompt.submit', ($, e) => ({ text: e.text }) as never)
  on('session.end', ($, e) => ({ sessionId: e.sessionId }) as never)
  on('tool.call', { tool: 'Bash' }, () => ({ isError: true as const, result: 'Exit code 2', text: 'Exit code 2\nfailed' }))
  on('tool.call', { tool: 'Edit' }, () => ({ result: {} as never }))
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: {} as never }))
  on('session.compact', () => (skip ? { skip } : { messages: [{ ...user('Summary of the conversation'), handle: 'h1' }] }))
  return sent
}

const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } }) as never

const compact = (messages: unknown[], extra: object = {}) => ({ trigger: 'manual', messages, ...extra }) as never

const pane = { title: 'compact-keeper', isFocused: false, bodyColumns: 90, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }

describe('compact-keeper', () => {
  test('after the main conversation compacts, one note is appended and a toast gives the counts', async ($, on) => {
    const sent = engine(on)
    await $.prompt.submit(typed('set up the repo'))
    await $.prompt.submit(typed('add retries to the mailer'))
    await $.tool.call({ tool: 'Edit', file_path: '/r/mailer.ts', old_string: 'a', new_string: 'b' } as never)
    await $.tool.call({ tool: 'Edit', file_path: '/r/mailer.ts', old_string: 'b', new_string: 'c' } as never)
    await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Add retry loop', status: 'in_progress', activeForm: 'Adding' }] } as never)
    await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)

    const done = await $.session.compact(compact([user('set up the repo'), user('add retries to the mailer')]))
    const messages = done.messages!
    expect(messages).toHaveLength(2)
    expect(messages[0]!.handle).toBe('h1')
    const note = messages[1]!
    expect(note.role).toBe('user')
    expect(note.handle).toBeUndefined()
    expect(note.text.startsWith(TITLE)).toBe(true)
    expect(note.text).toContain('## Latest user prompt (in full)\nadd retries to the mailer')
    expect(note.text).toContain('1. set up the repo')
    expect(note.text).toContain('- `/r/mailer.ts` (2 edits)')
    expect(note.text).toContain('- [~] Add retry loop')
    expect(note.text).toContain('`npm test` (Bash, exit code 2)')
    expect(sent.toasts).toEqual([`compact-keeper kept 2 prompts, 1 file, 1 todo, the last failed command (${note.text.length.toLocaleString('en-US')} chars)`])
  })

  test('only prompts the user sent are tracked, not notifications or a plugin framing its own', async ($, on) => {
    const sent = engine(on)
    await $.prompt.submit(typed('the real ask'))
    await $.prompt.submit({ text: 'task 3 finished', wait: false, origin: { kind: 'task-notification' } } as never)
    await $.prompt.submit({ text: 'a plugin note', wait: false, origin: { kind: 'plugin', name: 'x' } } as never)
    const done = await $.session.compact(compact([assistant('working')]))
    const note = done.messages!.at(-1)!.text
    expect(note).toContain('## Latest user prompt (in full)\nthe real ask')
    expect(note).not.toContain('task 3 finished')
    expect(note).not.toContain('a plugin note')
    expect(sent.toasts[0]).toContain('kept 1 prompt,')
  })

  test("a subagent's compaction and a precompute pass untouched", async ($, on) => {
    const sent = engine(on)
    await $.prompt.submit(typed('do the thing'))
    const sub = await $.session.compact(compact([user('do the thing')], { agentId: 'a1' }))
    const pre = await $.session.compact(compact([user('do the thing')], { trigger: 'precompute' }))
    expect(sub.messages).toHaveLength(1)
    expect(pre.messages).toHaveLength(1)
    expect(sent.toasts).toEqual([])
  })

  test('a skipped compaction is returned as it came', async ($, on) => {
    const sent = engine(on, 'blocked by a PreCompact hook')
    await $.prompt.submit(typed('do the thing'))
    const done = await $.session.compact(compact([user('do the thing')]))
    expect(done).toEqual({ skip: 'blocked by a PreCompact hook' })
    expect(sent.toasts).toEqual([])
  })

  test('/compact-keeper opens a pane with the last note, or says there is none yet', async ($, on) => {
    const sent = engine(on)
    const ran = await $.command.run({ command: 'compact-keeper', args: '' } as never)
    expect(ran.text).toBeUndefined()
    expect(sent.opened).toBe(1)
    const before = await $.ui.mount({ plugin: 'compact-keeper', surface: 'desktop', component: 'Pane', requestId: 'compact-keeper', props: pane })
    expect((await before.findAll({ type: 'Text' })).map(t => t.text)).toEqual(['No compaction yet this session'])
    await before.unmount()

    await $.prompt.submit(typed('keep this prompt'))
    await $.session.compact(compact([user('keep this prompt')]))
    const after = await $.ui.mount({ plugin: 'compact-keeper', surface: 'desktop', component: 'Pane', requestId: 'compact-keeper', props: pane })
    const shown = (await after.findAll({ type: 'Text' })).map(t => t.text)
    expect(shown[0]).toBe(TITLE)
    expect(shown).toContain('keep this prompt')
  })

  test('tracking survives a compaction and resets on /clear', async ($, on) => {
    const sent = engine(on)
    await $.prompt.submit(typed('first'))
    await $.tool.call({ tool: 'Edit', file_path: '/r/a.ts', old_string: 'a', new_string: 'b' } as never)
    await $.session.compact(compact([user('first')]))
    await $.session.compact(compact([user('Summary')]))
    expect(sent.toasts[1]).toContain('1 prompt, 1 file')

    await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} } as never)
    await $.session.compact(compact([assistant('Summary')]))
    expect(sent.toasts).toHaveLength(2)
  })
})
