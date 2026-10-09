import type { EngineInterface, Register } from 'claude-code'

// /nudge hands Claude the behavioral design guide (hooks/guide.md) as a note
// beside the command, so it costs nothing in sessions that never run it.
// With text after the command, that text is then sent as the person's prompt.

let guide: string | undefined
const loadGuide = async ($: EngineInterface) => (guide ??= String(await $.fs.read(`${$.plugin.root}/hooks/guide.md`)))

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'nudge',
      description: 'Behavioral design: /nudge <what users are not doing> diagnoses the barriers and designs ethical interventions to test',
      argumentHint: '[goal or flow]',
    })
    return next(e)
  })

  on('command.run', { command: 'nudge' }, async ($, e) => {
    const text = await loadGuide($)
    const ask = (e.args ?? '').trim()
    if (ask === '') return { text: 'nudge: guide loaded. Describe the behavior or flow in your next message.', context: [text] }

    // After this hook returns: a prompt cannot start inside it.
    $.clock.after(0, () => $.prompt.submit({ text: ask, asUser: true }))
    return { text: 'nudge: guide loaded.', context: [text] }
  })
}
