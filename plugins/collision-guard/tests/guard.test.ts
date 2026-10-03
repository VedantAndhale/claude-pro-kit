import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { DEFAULTS, cancelNote, choiceOf, findCollision, keyOf, parse, question } from '../hooks/guard'
import type { Ledger } from '../hooks/guard'

const NOW = Date.parse('2026-10-03T12:00:00Z')
const MIN = 60_000
const FILE = 'D:\\mods\\claude-pro-kit\\README.md'
const KEY = 'd:/mods/claude-pro-kit/readme.md'

const other = (at: number, mtimeMs = at): Ledger => ({
  session: 'other-chat-1234',
  cwd: 'D:\\mods',
  files: { [KEY]: { at, mtimeMs, path: FILE } },
})

describe('collision arithmetic', () => {
  test('one key per file however it is spelled', () => {
    expect(keyOf('D:\\mods\\claude-pro-kit\\README.md')).toBe(KEY)
    expect(keyOf('d:/mods/claude-pro-kit/readme.md')).toBe(KEY)
    expect(keyOf('/home/dev/Repo/README.md')).toBe('/home/dev/Repo/README.md')
  })

  test('only edits inside the window count', () => {
    expect(findCollision([other(NOW - 4 * MIN)], KEY, NOW, DEFAULTS)?.at).toBe(NOW - 4 * MIN)
    expect(findCollision([other(NOW - 40 * MIN)], KEY, NOW, DEFAULTS)).toBeUndefined()
    expect(findCollision([other(NOW - 40 * MIN)], KEY, NOW, { ...DEFAULTS, windowMin: 60 })).toBeDefined()
  })

  test('says how long ago, and whether the file changed since', () => {
    const hit = findCollision([other(NOW - 4 * MIN)], KEY, NOW, DEFAULTS)!
    expect(question(FILE, hit, NOW, NOW - 4 * MIN)).toBe(
      'README.md was changed by another chat 4 min ago (chat other-ch in mods). Edit it anyway?',
    )
    expect(question(FILE, hit, NOW, NOW - MIN)).toBe(
      'README.md was last changed by another chat 4 min ago, and modified since (chat other-ch in mods). Edit it anyway?',
    )
    expect(cancelNote(FILE, hit, NOW)).toBe(
      'README.md was changed 4 min ago in another chat; the user chose not to edit it. Re-read it, then ask how to proceed.',
    )
  })

  test('anything but a Proceed answer cancels', () => {
    expect(choiceOf('Proceed')).toBe('proceed')
    expect(choiceOf('Proceed for this file')).toBe('file')
    expect(choiceOf('Cancel')).toBe('cancel')
    expect(choiceOf('')).toBe('cancel')
  })

  test('parses /collisions arguments', () => {
    expect(parse('15', DEFAULTS)?.windowMin).toBe(15)
    expect(parse('off', DEFAULTS)?.isOff).toBe(true)
    expect(parse('0', DEFAULTS)).toBeUndefined()
    expect(parse('soon', DEFAULTS)).toBeUndefined()
  })
})

// The engine's side: a folder of ledgers, a file with a modification time, an
// edit tool that counts its runs, and a person who answers the question.
const engine = (on: On, opts: { answer?: string; otherAt?: number; fileMtime?: number }) => {
  // Ledgers are kept by file name: the engine resolves the folder per OS (a
  // Windows path is not absolute on Linux), so only names are compared.
  const files = new Map<string, string>()
  const norm = (p: string) => p.split('\\').join('/')
  const name = (p: string) => norm(p).split('/').pop()!
  const inLedgerDir = (p: string) => norm(p).endsWith('/collision-guard')
  const sent = { edits: 0, asked: 0, toasts: [] as string[] }
  if (opts.otherAt !== undefined) files.set('other-chat-1234.json', JSON.stringify(other(opts.otherAt, opts.otherAt)))
  const store = new Map<string, unknown>()

  on('env.get', () => ({ value: 'C:/Users/dev/.claude' }))
  on('session.id', () => ({ value: 'this-chat-5678' }))
  on('session.cwd', () => ({ value: 'D:\\mods' }))
  on('clock.now', () => ({ value: NOW }))
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('command.register', () => ({ value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    sent.toasts.push(e.text)
    return { value: undefined }
  })
  on('fs.list', ($, e) => ({
    value: [...files.keys()]
      .filter(() => inLedgerDir(e.path))
      .map(p => ({ name: p, kind: 'file' as const, size: 1, mtimeMs: NOW - MIN, isLink: false })),
  }))
  on('fs.read', ($, e) => {
    const text = files.get(name((e as { path: string }).path))
    if (text === undefined) throw new Error('ENOENT')
    return { value: text } as never
  })
  on('fs.write', ($, e) => {
    files.set(name(e.path), e.text)
    return { value: undefined }
  })
  on('fs.stat', () => ({
    value: { kind: 'file' as const, size: 10, mtimeMs: opts.fileMtime ?? opts.otherAt ?? NOW, isLink: false, realPath: FILE },
  }))
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    sent.asked += 1
    if (opts.answer === undefined) return { isError: true as const, result: 'dismissed', text: 'dismissed' }
    const q = (e as unknown as { questions: { question: string }[] }).questions[0]!.question
    return { result: { questions: (e as never as { questions: unknown[] }).questions, answers: { [q]: opts.answer } } as never }
  })
  on('tool.call', { tool: 'Edit' }, () => {
    sent.edits += 1
    return { result: {} as never }
  })
  return { sent, files }
}

const edit = { tool: 'Edit' as const, file_path: FILE, old_string: 'a', new_string: 'b' }

describe('collision-guard', () => {
  test('no other chat: edits without asking, and records the edit', async ($, on) => {
    const { sent, files } = engine(on, { answer: 'Proceed' })
    await $.session.start({ source: 'startup', cwd: 'D:\\mods' } as never)
    await $.tool.call(edit as never)

    expect(sent.asked).toBe(0)
    expect(sent.edits).toBe(1)
    expect(JSON.parse(files.get('this-chat-5678.json')!).files[KEY].at).toBe(NOW)
  })

  test('another chat edited it 4 min ago: asks, and Cancel refuses the edit', async ($, on) => {
    const { sent } = engine(on, { answer: 'Cancel', otherAt: NOW - 4 * MIN })
    const ran = await $.tool.call(edit as never)

    expect(sent.asked).toBe(1)
    expect(sent.edits).toBe(0)
    expect(String(ran.deny ?? ran.text)).toContain('the user chose not to edit it')
  })

  test('outside the window: no question', async ($, on) => {
    const { sent } = engine(on, { answer: 'Cancel', otherAt: NOW - 40 * MIN })
    await $.tool.call(edit as never)

    expect(sent.asked).toBe(0)
    expect(sent.edits).toBe(1)
  })

  test('Proceed for this file: no second question for the same edit by the other chat', async ($, on) => {
    const { sent } = engine(on, { answer: 'Proceed for this file', otherAt: NOW - 4 * MIN })
    await $.tool.call(edit as never)
    await $.tool.call(edit as never)

    expect(sent.asked).toBe(1)
    expect(sent.edits).toBe(2)
  })

  test('a question nobody answers lets the edit through', async ($, on) => {
    const { sent } = engine(on, { otherAt: NOW - 4 * MIN })
    await $.tool.call(edit as never)

    expect(sent.asked).toBe(1)
    expect(sent.edits).toBe(1)
  })

  test('/collisions lists recent edits from other chats with a toast and no transcript text', async ($, on) => {
    const { sent } = engine(on, { otherAt: NOW - 4 * MIN })
    const ran = await $.command.run({ command: 'collisions', args: '' } as never)

    expect(ran.text).toBeUndefined()
    expect(sent.toasts.at(-1)).toBe('Changed by other chats in the last 30 min: README.md 4 min ago')
  })
})
