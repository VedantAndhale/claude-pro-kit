import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const FILE = 'C:/repo/src/api.ts'
const OTHER = 'C:/repo/src/db.ts'

// The engine's side: files whose stat the test controls, and a Write tool that
// counts how often it really ran.
const engine = (on: On) => {
  const sizes: Record<string, number | undefined> = { [FILE]: 6000, [OTHER]: 6000 }
  const runs = { count: 0 }
  on('fs.stat', ($, e) => {
    const path = e.path.split('\\').join('/')
    const size = sizes[path]
    return size === undefined
      ? { deny: 'ENOENT' }
      : { value: { kind: 'file' as const, size, mtimeMs: 1_000, isLink: false, realPath: path } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', { tool: 'Write' }, () => {
    runs.count += 1
    return { result: { type: 'update' } as never }
  })
  return { sizes, runs }
}

const write = (file_path = FILE) => ({ tool: 'Write' as const, file_path, content: 'x' })

describe('write-guard', () => {
  test('lets a new file through untouched', async ($, on) => {
    const { sizes, runs } = engine(on)
    sizes[FILE] = undefined
    const made = await $.tool.call(write())

    expect(made.deny).toBeUndefined()
    expect(made.context).toBeUndefined()
    expect(runs.count).toBe(1)
  })

  test('lets a small file through untouched', async ($, on) => {
    const { sizes, runs } = engine(on)
    sizes[FILE] = 500
    await $.tool.call(write())
    const again = await $.tool.call(write())

    expect(again.deny).toBeUndefined()
    expect(runs.count).toBe(2)
  })

  test('lets the first rewrite through with a note', async ($, on) => {
    const { runs } = engine(on)
    const first = await $.tool.call(write())

    expect(first.deny).toBeUndefined()
    expect(first.context?.[0]).toContain('use Edit')
    expect(runs.count).toBe(1)
  })

  test('holds back a later rewrite once, then lets the retry through', async ($, on) => {
    const { runs } = engine(on)
    await $.tool.call(write())
    const held = await $.tool.call(write(OTHER))
    const retry = await $.tool.call(write(OTHER))

    expect(held.deny).toContain('Edit')
    expect(retry.deny).toBeUndefined()
    expect(runs.count).toBe(2)
  })
})
