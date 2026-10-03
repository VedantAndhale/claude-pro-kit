import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const NOW = Date.parse('2026-10-03T12:00:00Z')

const band = (bodyColumns = 140, isWorking = false) => ({
  hasSurvey: false,
  isWorking,
  maxRows: 12,
  bodyColumns,
  scroll: { offset: 0, bodyRows: 12 },
  view: {},
})

const measure = (five: number, week: number, contextPct = 24) => ({
  rateLimits: [
    { kind: 'five_hour', percentUsed: five, resetsAt: '2026-10-03T15:20:00Z' },
    { kind: 'seven_day', percentUsed: week, resetsAt: '2026-10-08T07:00:00Z' },
  ],
  context: { tokens: contextPct * 10_000, window: 1_000_000, percent: contextPct },
  changed: ['context' as const, 'rateLimits' as const],
})

// The engine's side of what pro-hud calls. The surfaces' own drawings beneath
// the band are a marker, so a test can tell "pro-hud passed" from "pro-hud drew".
const engine = (on: On) => {
  const toasts: string[] = []
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }) as never)
  on('ui.render', ($, e) => ({ type: 'Text', props: {}, children: ['engine'] }) as never)
  return { toasts }
}

const texts = async (ui: { findAll: (q: { type?: string }) => Promise<{ text: string }[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(t => t.text)

describe('pro-hud band', () => {
  test('draws exact session, week and context readings on the desktop', async ($, on) => {
    engine(on)
    await $.session.measure(measure(20, 66))
    const ui = await $.ui.mount({ plugin: 'pro-hud', surface: 'desktop', component: 'AbovePrompt', props: band() })
    const shown = await texts(ui)

    expect(shown).toContain('Session')
    expect(shown).toContain('20%')
    expect(shown).toContain('Week')
    expect(shown).toContain('66%')
    expect(shown).toContain('Context')
    expect(shown).toContain('24%')
    expect(shown).toContain('  240,000 tokens')
    expect(shown).toContain('  3h 20m')
    expect(await ui.findAll({ type: 'Svg' })).toHaveLength(3)
  })

  test('leaves the terminal alone', async ($, on) => {
    engine(on)
    await $.session.measure(measure(20, 66))
    const ui = await $.ui.mount({ plugin: 'pro-hud', surface: 'terminal', component: 'AbovePrompt', props: band() })

    expect(await texts(ui)).toEqual(['engine'])
  })

  test('shows the running turn live, then its final figures', async ($, on) => {
    engine(on)
    on('tool.call', { tool: 'Edit' }, () => ({ result: {} as never }))
    await $.session.measure(measure(20, 66))
    await $.turn.start({ text: 'fix it', turnId: 't1' })
    await $.tool.call({ tool: 'Edit', file_path: 'C:/repo/a.ts', old_string: 'a', new_string: 'b' })

    const ui = await $.ui.mount({ plugin: 'pro-hud', surface: 'desktop', component: 'AbovePrompt', props: band(140, true) })
    const live = await texts(ui)
    expect(live).toContain('This turn')
    expect(live.join('')).toContain('1 tool  ·  1 file edited')

    await $.turn.complete({
      turnId: 't1',
      answer: 'done',
      durationMs: 17_200,
      isAborted: false,
      reason: 'answer',
      usage: { input_tokens: 1_233, output_tokens: 686, cache_read_input_tokens: 395_101, cache_creation_input_tokens: 0, model: 'claude' },
    } as never)
    await $.session.measure(measure(21, 66))

    const done = (await texts(ui)).join('')
    expect(done).toContain('Last turn')
    expect(done).toContain('17.2s  ·  1 tool  ·  1 file edited  ·  396,334 in  ·  395,101 cached  ·  686 out')
    expect(done).toContain('+1% session')

    // A narrow band keeps every figure whole.
    const narrow = await $.ui.mount({ plugin: 'pro-hud', surface: 'desktop', component: 'AbovePrompt', props: band(60) })
    const parts = await texts(narrow)
    for (const figure of ['396,334 in', '395,101 cached', '686 out', '+1% session']) {
      expect(parts.some(t => t.endsWith(figure))).toBe(true)
    }
  })

  test('shows the session points a turn used when the reading lands before the turn ends', async ($, on) => {
    engine(on)
    await $.session.measure(measure(20, 66))
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.session.measure(measure(23, 66))
    await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 4_000, isAborted: false, reason: 'answer' } as never)

    const ui = await $.ui.mount({ plugin: 'pro-hud', surface: 'desktop', component: 'AbovePrompt', props: band() })
    expect((await texts(ui)).join(' ')).toContain('+3% session')
  })

  test('toasts once when the session crosses 80%', async ($, on) => {
    const { toasts } = engine(on)
    await $.session.measure(measure(79, 66))
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.session.measure(measure(81, 66))
    await $.session.measure(measure(82, 66))

    expect(toasts).toEqual(['Session usage at 81% — plan your last few turns'])
  })
})

describe('/hud', () => {
  test('turns everything off and on with a toast, adding nothing to the transcript', async ($, on) => {
    const { toasts } = engine(on)
    await $.session.measure(measure(20, 66))

    const off = await $.command.run({ command: 'hud', args: 'all off' } as never)
    expect(off.text).toBeUndefined()
    expect(toasts.at(-1)).toBe('HUD: band off · spinner off · cards off')

    const ui = await $.ui.mount({ plugin: 'pro-hud', surface: 'desktop', component: 'AbovePrompt', props: band() })
    expect(await texts(ui)).toEqual(['engine'])

    await $.command.run({ command: 'hud', args: 'all on' } as never)
    expect(toasts.at(-1)).toBe('HUD: band on · spinner on · cards on')
  })
})
