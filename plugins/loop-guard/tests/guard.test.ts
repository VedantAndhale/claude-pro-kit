import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// The engine's side: a Bash tool that fails while the test says so, and
// counts how often it really ran.
const engine = (on: On) => {
  const shell = { fail: true, count: 0 }
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', { tool: 'Bash' }, () => {
    shell.count += 1
    return shell.fail ? { isError: true as const, result: 'exit 1', text: 'exit 1' } : { result: { stdout: 'ok' } as never }
  })
  return shell
}

const bash = (command = 'npm test') => ({ tool: 'Bash' as const, command })

describe('loop-guard', () => {
  test('lets the first two failures through', async ($, on) => {
    const shell = engine(on)
    const a = await $.tool.call(bash())
    const b = await $.tool.call(bash())

    expect(a.deny).toBeUndefined()
    expect(b.deny).toBeUndefined()
    expect(shell.count).toBe(2)
  })

  test('holds back the third try once, then lets the retry through', async ($, on) => {
    const shell = engine(on)
    await $.tool.call(bash())
    await $.tool.call(bash())
    const held = await $.tool.call(bash())
    const retry = await $.tool.call(bash())

    expect(held.deny).toContain('failed 2 times in a row')
    expect(retry.deny).toBeUndefined()
    expect(shell.count).toBe(3)
  })

  test('a success clears the count', async ($, on) => {
    const shell = engine(on)
    await $.tool.call(bash())
    shell.fail = false
    await $.tool.call(bash())
    shell.fail = true
    await $.tool.call(bash())
    const next = await $.tool.call(bash())

    expect(next.deny).toBeUndefined()
  })

  test('counts each command apart', async ($, on) => {
    engine(on)
    await $.tool.call(bash('npm test'))
    await $.tool.call(bash('npm test'))
    const other = await $.tool.call(bash('npm run lint'))

    expect(other.deny).toBeUndefined()
  })
})
