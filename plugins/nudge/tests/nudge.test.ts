import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const GUIDE = '# Behavioral design guide'

const engine = (on: On) => {
  const sent: { text: string; asUser?: boolean }[] = []
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.read', () => ({ value: GUIDE }))
  on('prompt.submit', ($, e) => {
    sent.push({ text: e.text, asUser: e.origin.kind === 'plugin' ? e.origin.asUser : undefined })
    return { text: e.text }
  })
  return { sent, clock: mock.clock(on) }
}

describe('nudge', () => {
  test('/nudge alone loads the guide for the next message and sends nothing', async ($, on) => {
    const eng = engine(on)
    const ran = await $.command.run({ command: 'nudge' } as never)
    expect(ran.context).toEqual([GUIDE])
    expect(ran.text).toContain('next message')
    await eng.clock.advance(10)
    expect(eng.sent).toEqual([])
  })

  test('/nudge <goal> loads the guide, then sends the goal as your own prompt', async ($, on) => {
    const eng = engine(on)
    const goal = 'new admins do not invite teammates in their first session'
    const ran = await $.command.run({ command: 'nudge', args: goal } as never)
    expect(ran.context).toEqual([GUIDE])
    await eng.clock.advance(10)
    expect(eng.sent).toEqual([{ text: goal, asUser: true }])
  })
})
