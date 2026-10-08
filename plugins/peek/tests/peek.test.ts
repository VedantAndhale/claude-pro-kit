import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { bar, clip, elapsed, isStatus, lastPercent, parseBackground, parseNotifications, tail } from '../hooks/register'

const OUT = 'C:\\Users\\dev\\AppData\\Local\\Temp\\claude\\proj\\sess\\tasks\\bicjfg37d.output'
const LAUNCH =
  `Command running in background with ID: bicjfg37d. Output is being written to: ${OUT}. ` +
  'You will be notified when it completes. To check interim output, use Read on that file path.'

const notification = (id: string, status = 'completed') =>
  `<task-notification>\n<task-id>${id}</task-id>\n<output-file>${OUT}</output-file>\n<status>${status}</status>\n` +
  `<summary>Background command "npm run build" ${status} (exit code 0)</summary>\n</task-notification>`

const pane = { title: 'peek', isFocused: false, bodyColumns: 100, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }

// The engine's side: a clock the test moves, a background Bash launch, an
// output file, and a prompt that reaches the model only through the bottom.
const engine = (on: On) => {
  const world = { now: Date.parse('2026-10-08T12:00:00Z'), output: 'compiling\n', sent: [] as string[], opened: 0 }
  on('clock.now', () => ({ value: world.now }))
  on('clock.every', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: undefined }))
  on('agent.list', () => ({ value: [] }))
  on('ui.open', () => {
    world.opened += 1
    return { value: { isPlaced: true } } as never
  })
  on('fs.stat', () => ({ value: { kind: 'file', size: world.output.length, mtimeMs: world.now, isLink: false } }) as never)
  on('fs.read', () => ({ value: world.output }))
  on('tool.call', { tool: 'Bash' }, () => ({
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bicjfg37d' } as never,
    text: LAUNCH,
  }) as never)
  on('prompt.submit', ($, e) => {
    world.sent.push(e.text)
    return { text: e.text }
  })
  return world
}

const launch = ($: { tool: { call: (i: never) => Promise<unknown> } }) =>
  $.tool.call({ tool: 'Bash', command: 'npm run build', run_in_background: true } as never)

const submit = (text: string, kind = 'composer') => ({ text, wait: false, origin: { kind } }) as never

const texts = async (ui: { findAll: (q: { type?: string }) => Promise<{ text: string }[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(t => t.text)

describe('status prompt', () => {
  test('is dropped and opens the pane while a background task runs', async ($, on) => {
    const world = engine(on)
    await launch($ as never)
    const ran = await $.prompt.submit(submit('  Status '))

    expect(ran.drop).toBe('peek: 1 running, opened in the pane')
    expect(world.sent).toEqual([])
    expect(world.opened).toBe(1)
  })

  test('goes to Claude unchanged when nothing runs', async ($, on) => {
    const world = engine(on)
    const ran = await $.prompt.submit(submit('status'))

    expect(ran.drop).toBeUndefined()
    expect(world.sent).toEqual(['status'])
    expect(world.opened).toBe(0)
  })

  test('leaves every other prompt alone', async ($, on) => {
    const world = engine(on)
    await launch($ as never)
    await $.prompt.submit(submit('status of the build?'))
    await $.prompt.submit(submit('fix the parser'))

    expect(world.sent).toEqual(['status of the build?', 'fix the parser'])
  })

  test('a task-notification marks the task done, so status goes to Claude again', async ($, on) => {
    const world = engine(on)
    await launch($ as never)
    world.now += 90_000
    await $.prompt.submit(submit(notification('bicjfg37d'), 'task-notification'))
    const ran = await $.prompt.submit(submit('status'))

    expect(ran.drop).toBeUndefined()
    expect(world.sent.at(-1)).toBe('status')
  })
})

describe('the pane', () => {
  test('shows the elapsed time, the output tail and the percent the task printed', async ($, on) => {
    const world = engine(on)
    await launch($ as never)
    world.now += 252_000
    world.output = 'step 1\n\nstep 2\r[====>   ] 45%\r[======> ] 89%\nwriting bundle\n'
    await $.command.run({ command: 'peek', args: '' } as never)

    const ui = await $.ui.mount({ plugin: 'peek', surface: 'desktop', component: 'Pane', requestId: 'peek', props: pane })
    const shown = (await texts(ui)).join('\n')

    expect(shown).toContain('1 running')
    expect(shown).toContain('npm run build  ·  4m 12s')
    expect(shown).toContain("[#################---] 89%  as reported by the task's output")
    expect(shown).toContain('  writing bundle')
    expect(shown).not.toContain('step 2')
    await ui.unmount()
  })

  test('draws no bar when the output has no percent, and lists finished tasks dimmed', async ($, on) => {
    const world = engine(on)
    await launch($ as never)
    const ui = await $.ui.mount({ plugin: 'peek', surface: 'desktop', component: 'Pane', requestId: 'peek', props: pane })
    expect((await texts(ui)).join('\n')).not.toContain('%')

    world.now += 61_000
    await $.prompt.submit(submit(notification('bicjfg37d', 'failed'), 'task-notification'))
    // The same pane redraws on the change: no remount.
    const shown = (await texts(ui)).join('\n')
    expect(shown).toContain('Nothing running in the background.')
    expect(shown).toContain('npm run build  ·  failed, notified after 1m 1s')
    await ui.unmount()
  })

  test('/peek answers with no text', async ($, on) => {
    engine(on)
    const ran = await $.command.run({ command: 'peek', args: '' } as never)
    expect(ran.text).toBeUndefined()
  })
})

describe('helpers', () => {
  test('parses the background launch Claude Code reports', () => {
    expect(parseBackground(LAUNCH)).toEqual({ id: 'bicjfg37d', path: OUT })
  })

  test('parses task notifications', () => {
    expect(parseNotifications(notification('a1') + notification('b2', 'killed'))).toEqual([
      { id: 'a1', status: 'completed' },
      { id: 'b2', status: 'killed' },
    ])
  })

  test('takes the latest percent from the tail, never one over 100', () => {
    expect(lastPercent(['10%', 'downloading 52.5 % done', 'eta soon'])).toBe(52.5)
    expect(lastPercent(['no figures here'])).toBeUndefined()
    expect(lastPercent(['250% faster'])).toBeUndefined()
    expect(bar(0)).toBe('[--------------------] 0%')
    expect(bar(100)).toBe('[####################] 100%')
  })

  test('formats exact timers, tails and clips', () => {
    expect(elapsed(9_400)).toBe('9s')
    expect(elapsed(252_000)).toBe('4m 12s')
    expect(elapsed(3_787_000)).toBe('1h 3m 7s')
    expect(tail('a\n\n\x1b[32mb\x1b[0m\nc\r\nd\n')).toEqual(['b', 'c', 'd'])
    expect(clip('x'.repeat(100))).toHaveLength(70)
    expect(isStatus(' STATUS\n')).toBe(true)
    expect(isStatus('status?')).toBe(false)
  })
})
