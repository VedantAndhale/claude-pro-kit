import { describe, expect, test } from 'claude-code/testing'
import type { ModelCompleteResult, On, PromptEditInput } from 'claude-code'

import { cleanReply, usageText, wordCount } from '../hooks/register'

const DRAFT = 'fix the login bug in src/auth.ts please'
const BETTER = 'Fix the login bug in `src/auth.ts`. Done when the existing tests pass.'
const USAGE = { input_tokens: 3_412, output_tokens: 186, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const BAND = (extra: { hasSurvey?: boolean; isWorking?: boolean } = {}) => ({
  component: 'AbovePrompt' as const,
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
    ...extra,
  },
})

// The engine's side: a prompt box, the model answering as the test says, the
// rules file, and the toasts. The band's own drawing beneath is a marker.
const engine = (on: On, reply: ModelCompleteResult = { isAnswered: true, text: BETTER, usage: USAGE }) => {
  const box = { text: '' }
  const calls: { model: string; effort?: string; system?: string; prompt: string }[] = []
  const toasts: string[] = []
  const store = new Map<string, unknown>()
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('fs.read', () => ({ value: '# RULES' }))
  on('prompt.read', () => ({ value: { text: box.text, cursor: box.text.length } }))
  on('prompt.fill', ($, e) => {
    box.text = e.text
    return { isFilled: true }
  })
  on('prompt.edit', ($, e) => {
    const text = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)
    box.text = text
    return { text, cursor: e.start + e.inputText.length }
  })
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('model.complete', ($, e) => {
    calls.push({ model: e.model, effort: e.effort, system: e.system, prompt: e.prompt })
    return { value: reply }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }) as never)
  return { box, calls, toasts }
}

// The person typing a draft into the empty box: one paste. The kit raises
// prompt.edit as the composer does; `$.prompt` types only the plugin calls.
const type = (text: string): PromptEditInput => ({ origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText: text })
const edit = ($: unknown, e: PromptEditInput) =>
  ($ as { prompt: { edit: (e: PromptEditInput) => Promise<unknown> } }).prompt.edit(e)

const buttons = async (ui: { findAll: (q: { type?: string }) => Promise<{ key?: string }[]> }) =>
  (await ui.findAll({ type: 'Button' })).map(b => b.key)

describe('prompt-polish helpers', () => {
  test('counts words', async () => {
    expect(wordCount('  fix   the\nbug ')).toBe(3)
    expect(wordCount('')).toBe(0)
  })

  test('writes exact usage with thousands separators', async () => {
    expect(usageText(USAGE)).toBe('3,412 in, 186 out (Opus)')
    expect(usageText({ ...USAGE, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 9_050 })).toBe(
      '4,412 in, 9,050 cached, 186 out (Opus)',
    )
  })

  test('takes off one fence around the whole reply, and only that', async () => {
    expect(cleanReply('```\nDo the thing.\n```')).toBe('Do the thing.')
    expect(cleanReply('  Do the thing.\n')).toBe('Do the thing.')
    const inner = '```ts\na()\n```\ntext\n```ts\nb()\n```'
    expect(cleanReply(inner)).toBe(inner)
  })
})

describe('Improve', () => {
  test('a draft under 5 words is not sent', async ($, on) => {
    const eng = engine(on)
    await edit($, type('fix the bug'))
    const ui = await $.ui.mount({ plugin: 'prompt-polish', surface: 'terminal', ...BAND() })
    await ui.press({ key: 'improve' })

    expect(eng.calls).toHaveLength(0)
    expect(eng.toasts).toEqual(['prompt-polish: draft under 5 words, nothing sent'])
    expect(eng.box.text).toBe('fix the bug')
  })

  test('rewrites the draft with Opus at low effort, shows the exact usage, and Undo puts it back', async ($, on) => {
    const eng = engine(on)
    await edit($, type(DRAFT))
    const ui = await $.ui.mount({ plugin: 'prompt-polish', surface: 'terminal', ...BAND() })
    expect(await buttons(ui)).toEqual(['improve'])

    await ui.press({ key: 'improve' })

    expect(eng.calls).toHaveLength(1)
    expect(eng.calls[0]?.model).toBe('opus')
    expect(eng.calls[0]?.effort).toBe('low')
    expect(eng.calls[0]?.system).toContain('# RULES')
    expect(eng.calls[0]?.system).toContain('Do NOT ask clarifying questions')
    expect(eng.calls[0]?.prompt).toContain(DRAFT)
    expect(eng.box.text).toBe(BETTER)
    expect(eng.toasts).toEqual(['prompt-polish: 3,412 in, 186 out (Opus)'])
    expect(await buttons(ui)).toEqual(['improve', 'undo'])

    await ui.press({ key: 'undo' })

    expect(eng.box.text).toBe(DRAFT)
    expect(await buttons(ui)).toEqual(['improve'])
  })

  test('/polish <prompt> does the same with its own text', async ($, on) => {
    const eng = engine(on)
    await $.command.run({ command: 'polish', args: DRAFT } as never)

    expect(eng.calls).toHaveLength(1)
    expect(eng.box.text).toBe(BETTER)
    expect(eng.toasts).toEqual(['prompt-polish: 3,412 in, 186 out (Opus)'])
  })

  test('/polish model haiku switches the model, and the toast names it', async ($, on) => {
    const eng = engine(on)
    await $.command.run({ command: 'polish', args: 'model haiku' } as never)
    expect(eng.toasts).toEqual(['prompt-polish: rewrites use Haiku'])
    expect(eng.calls).toHaveLength(0)

    await $.command.run({ command: 'polish', args: DRAFT } as never)
    expect(eng.calls[0]?.model).toBe('haiku')
    expect(eng.toasts[1]).toBe('prompt-polish: 3,412 in, 186 out (Haiku)')

    await $.command.run({ command: 'polish', args: 'model gpt' } as never)
    expect(eng.toasts[2]).toBe('prompt-polish: unknown model "gpt"; use haiku, sonnet or opus')
  })

  test('a failed call leaves the draft untouched and says why', async ($, on) => {
    const eng = engine(on, { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: { ...USAGE, input_tokens: 0, output_tokens: 0 } } as never)
    await edit($, type(DRAFT))
    const ui = await $.ui.mount({ plugin: 'prompt-polish', surface: 'terminal', ...BAND() })
    await ui.press({ key: 'improve' })

    expect(eng.box.text).toBe(DRAFT)
    expect(eng.toasts).toEqual(['prompt-polish: Opus call failed (overloaded, HTTP 529), draft unchanged'])
    expect(await buttons(ui)).toEqual(['improve'])
  })

  test('submitting the prompt drops the saved original', async ($, on) => {
    engine(on)
    await edit($, type(DRAFT))
    const ui = await $.ui.mount({ plugin: 'prompt-polish', surface: 'terminal', ...BAND() })
    await ui.press({ key: 'improve' })
    await $.prompt.submit({ text: BETTER, wait: false, origin: { kind: 'composer' } } as never)

    expect(await buttons(ui)).toEqual([])
  })
})

describe('the band', () => {
  test('is hidden while the prompt box is empty', async ($, on) => {
    engine(on)
    const ui = await $.ui.mount({ plugin: 'prompt-polish', surface: 'terminal', ...BAND() })

    expect(await buttons(ui)).toEqual([])
    expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  })

  test('stays up while a turn runs, and yields to a survey', async ($, on) => {
    engine(on)
    await edit($, type(DRAFT))
    const working = await $.ui.mount({ plugin: 'prompt-polish', surface: 'terminal', ...BAND({ isWorking: true }) })
    expect(await buttons(working)).toEqual(['improve'])
    await working.unmount()
    const survey = await $.ui.mount({ plugin: 'prompt-polish', surface: 'terminal', ...BAND({ hasSurvey: true }) })
    expect(await buttons(survey)).toEqual([])
  })

  test('shows Improve on the desktop even before any edit is seen', async ($, on) => {
    engine(on)
    for (const extra of [{}, { isWorking: true }]) {
      const ui = await $.ui.mount({ plugin: 'prompt-polish', surface: 'desktop', ...BAND(extra) })
      expect(await buttons(ui)).toEqual(['improve'])
      await ui.unmount()
    }
  })
})
