import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const FILE = 'C:/repo/src/api.ts'

// The engine's side: a file whose stat the test controls, and a Read tool that
// counts how often it really ran (or fails when asked to).
const engine = (on: On) => {
  const file = { size: 1200, mtimeMs: 1_000 }
  const runs = { count: 0, fail: false }
  on('fs.stat', () => ({
    value: { kind: 'file' as const, size: file.size, mtimeMs: file.mtimeMs, isLink: false, realPath: FILE },
  }))
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', { tool: 'Read' }, () => {
    runs.count += 1
    return runs.fail ? { isError: true as const, result: 'EACCES', text: 'EACCES' } : { result: { type: 'text', file: {} } as never }
  })
  return { file, runs }
}

const read = (extra: Record<string, unknown> = {}) => ({ tool: 'Read' as const, file_path: FILE, ...extra })

describe('reread-guard', () => {
  test('lets the first read through', async ($, on) => {
    const { runs } = engine(on)
    const first = await $.tool.call(read())

    expect(first.deny).toBeUndefined()
    expect(runs.count).toBe(1)
  })

  test('skips an identical read of an unchanged file', async ($, on) => {
    const { runs } = engine(on)
    await $.tool.call(read())
    const second = await $.tool.call(read())

    expect(second.deny).toContain('api.ts unchanged since you read it')
    expect(runs.count).toBe(1)
  })

  test('lets a retry straight after a skip through', async ($, on) => {
    const { runs } = engine(on)
    await $.tool.call(read())
    await $.tool.call(read())
    const third = await $.tool.call(read())

    expect(third.deny).toBeUndefined()
    expect(runs.count).toBe(2)
  })

  test('lets a read through once the file changed', async ($, on) => {
    const { file, runs } = engine(on)
    await $.tool.call(read())
    file.mtimeMs = 2_000
    const again = await $.tool.call(read())

    expect(again.deny).toBeUndefined()
    expect(runs.count).toBe(2)
  })

  test('lets a different range of the same file through', async ($, on) => {
    const { runs } = engine(on)
    await $.tool.call(read())
    const range = await $.tool.call(read({ offset: 100, limit: 50 }))

    expect(range.deny).toBeUndefined()
    expect(runs.count).toBe(2)
  })

  test('skips an identical read sent in the same batch', async ($, on) => {
    const { runs } = engine(on)
    const [a, b] = await Promise.all([$.tool.call(read()), $.tool.call(read())])

    expect([a.deny, b.deny].filter(d => d !== undefined)).toHaveLength(1)
    expect(runs.count).toBe(1)
  })

  test('does not count a read that failed', async ($, on) => {
    const { runs } = engine(on)
    runs.fail = true
    await $.tool.call(read())
    runs.fail = false
    const again = await $.tool.call(read())

    expect(again.deny).toBeUndefined()
    expect(runs.count).toBe(2)
  })
})
