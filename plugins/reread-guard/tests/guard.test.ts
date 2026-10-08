import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { absolute, shellRead } from '../hooks/register'

const FILE = 'C:/repo/src/api.ts'

// The engine's side: a file whose stat the test controls, and a Read tool that
// counts how often it really ran (or fails when asked to).
const engine = (on: On) => {
  const file = { size: 1200, mtimeMs: 1_000 }
  const runs = { count: 0, fail: false }
  on('fs.stat', () => ({
    value: { kind: 'file' as const, size: file.size, mtimeMs: file.mtimeMs, isLink: false, realPath: FILE },
  }))
  const shell = { count: 0 }
  on('fs.read', () => ({ value: 'const a = 1\n' }))
  on('session.cwd', () => ({ value: 'C:/repo' }))
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', { tool: 'Read' }, () => {
    runs.count += 1
    return runs.fail ? { isError: true as const, result: 'EACCES', text: 'EACCES' } : { result: { type: 'text', file: {} } as never }
  })
  on('tool.call', { tool: 'Bash' }, () => {
    shell.count += 1
    return { result: { stdout: 'const a = 1\n', stderr: '' } as never }
  })
  return { file, runs, shell }
}

const read = (extra: Record<string, unknown> = {}) => ({ tool: 'Read' as const, file_path: FILE, ...extra })
const bash = (command: string) => ({ tool: 'Bash', command }) as never

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

  test('understands only plain one-file reads', async () => {
    expect(shellRead("sed -n '10,40p' src/api.ts", 'Bash')).toEqual({ path: 'src/api.ts', range: '10-40' })
    expect(shellRead('head -n 40 src/api.ts', 'Bash')).toEqual({ path: 'src/api.ts', range: '1-40' })
    expect(shellRead('tail -20 "src/my api.ts"', 'Bash')).toEqual({ path: 'src/my api.ts', range: 'last 20' })
    expect(shellRead("Get-Content -Path 'C:\\repo\\a.ts' -TotalCount 5", 'PowerShell')).toEqual({ path: 'C:\\repo\\a.ts', range: '1-5' })
    expect(shellRead('cat a.ts | grep x', 'Bash')).toBeUndefined()
    expect(shellRead('cat a.ts b.ts', 'Bash')).toBeUndefined()
    expect(shellRead('cat $FILE', 'Bash')).toBeUndefined()
    expect(shellRead('cat -n a.ts', 'Bash')).toBeUndefined()
    expect(shellRead("sed -n '1,5p;9p' a.ts", 'Bash')).toBeUndefined()
    expect(shellRead('Get-Content a.ts,b.ts', 'PowerShell')).toBeUndefined()
    expect(absolute('/d/mods/a.ts', 'C:/repo')).toBe('d:/mods/a.ts')
    expect(absolute('/tmp/a.ts', 'C:/repo')).toBeUndefined()
    expect(absolute('src/a.ts', 'C:/repo/')).toBe('C:/repo/src/a.ts')
  })

  test('skips a sed -n re-read of an unchanged file', async ($, on) => {
    const { shell } = engine(on)
    await $.tool.call(bash("sed -n '1,80p' src/api.ts"))
    const second = await $.tool.call(bash("sed -n '1,80p' src/api.ts"))

    expect(second.deny).toContain('api.ts unchanged since you read it')
    expect(shell.count).toBe(1)
  })

  test('lets a sed -n re-read through once the file changed', async ($, on) => {
    const { file, shell } = engine(on)
    await $.tool.call(bash("sed -n '1,80p' src/api.ts"))
    file.mtimeMs = 2_000
    const again = await $.tool.call(bash("sed -n '1,80p' src/api.ts"))

    expect(again.deny).toBeUndefined()
    expect(shell.count).toBe(2)
  })

  test('lets a retried shell read through', async ($, on) => {
    const { shell } = engine(on)
    await $.tool.call(bash("sed -n '1,80p' src/api.ts"))
    await $.tool.call(bash("sed -n '1,80p' src/api.ts"))
    const third = await $.tool.call(bash("sed -n '1,80p' src/api.ts"))

    expect(third.deny).toBeUndefined()
    expect(shell.count).toBe(2)
  })

  test('leaves a piped command alone', async ($, on) => {
    const { shell } = engine(on)
    await $.tool.call(bash('cat src/api.ts | grep load'))
    const again = await $.tool.call(bash('cat src/api.ts | grep load'))

    expect(again.deny).toBeUndefined()
    expect(shell.count).toBe(2)
  })

  test('skips a cat of a file a whole Read already showed', async ($, on) => {
    const { shell } = engine(on)
    await $.tool.call(read())
    const cat = await $.tool.call(bash('cat src/api.ts'))

    expect(cat.deny).toContain('retry the same command')
    expect(shell.count).toBe(0)
  })

  test('lets a Read through after a cat, since Edit needs a Read', async ($, on) => {
    const { runs } = engine(on)
    await $.tool.call(bash('cat src/api.ts'))
    const done = await $.tool.call(read())

    expect(done.deny).toBeUndefined()
    expect(runs.count).toBe(1)
  })
})
