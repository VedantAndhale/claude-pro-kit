import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { DEFAULTS, choiceOf, firstMarks, isOver, nextMarks, parse, question, stopNote, uncached } from '../hooks/budget'

describe('budget arithmetic', () => {
  test('asks at +5 points or 500,000 uncached tokens, whichever comes first', () => {
    const marks = firstMarks(DEFAULTS)
    expect(isOver({ points: 4.9, tokens: 499_999, requests: 3 }, marks)).toBe(false)
    expect(isOver({ points: 5, tokens: 0, requests: 3 }, marks)).toBe(true)
    expect(isOver({ points: 0, tokens: 500_000, requests: 3 }, marks)).toBe(true)
    expect(isOver({ points: undefined, tokens: 500_000, requests: 3 }, marks)).toBe(true)
  })

  test('Continue raises the crossed mark by one step', () => {
    expect(nextMarks({ points: 6, tokens: 10, requests: 1 }, firstMarks(DEFAULTS), DEFAULTS)).toEqual({ points: 10, tokens: 500_000 })
  })

  test('cache reads are not counted', () => {
    expect(uncached({ input_tokens: 1_200, cache_creation_input_tokens: 800 })).toBe(2_000)
  })

  test('anything but a Continue answer stops', () => {
    expect(choiceOf('Continue')).toBe('continue')
    expect(choiceOf("Don't ask again")).toBe('quiet')
    expect(choiceOf('Stop here')).toBe('stop')
    expect(choiceOf('')).toBe('stop')
    expect(choiceOf('hmm')).toBe('stop')
  })

  test('says what the turn used in exact figures', () => {
    const marks = firstMarks(DEFAULTS)
    expect(question({ points: 6, tokens: 0, requests: 14 }, marks, 20, 26)).toBe(
      'This turn has used 6 points of your session (20% → 26%, limit +5) over 14 requests. Keep going?',
    )
    expect(question({ points: undefined, tokens: 512_000, requests: 9 }, marks, undefined, undefined)).toBe(
      'This turn has used 512,000 uncached input tokens (limit 500,000) over 9 requests. Keep going?',
    )
  })

  test('names the token limit when tokens crossed it, even with a session reading', () => {
    // The live run: stopped by 5,615 tokens over a 5,000 limit while at +2 points.
    const marks = { points: 5, tokens: 5_000 }
    const spend = { points: 2, tokens: 5_615, requests: 6 }
    expect(question(spend, marks, 40, 42)).toBe(
      'This turn has used 5,615 uncached input tokens (limit 5,000) over 6 requests. Keep going?',
    )
    expect(stopNote(spend, marks)).toBe(
      '[turn-budget] The user stopped the previous turn at 5,615 uncached input tokens. Ask before continuing that work.',
    )
  })

  test('the note left for Claude on Stop is one line with the exact figure', () => {
    expect(stopNote({ points: 6, tokens: 0, requests: 14 }, firstMarks(DEFAULTS))).toBe(
      '[turn-budget] The user stopped the previous turn at +6 session points. Ask before continuing that work.',
    )
  })

  test('parses /turn-budget arguments', () => {
    expect(parse('8', DEFAULTS)?.points).toBe(8)
    expect(parse('tokens 1000000', DEFAULTS)?.tokens).toBe(1_000_000)
    expect(parse('off', DEFAULTS)?.isOff).toBe(true)
    expect(parse('', DEFAULTS)).toBeUndefined()
    expect(parse('-3', DEFAULTS)).toBeUndefined()
  })
})

// The engine's side: a store, readings, and a model whose every request
// reports the same usage and is counted.
const engine = (on: On, answer?: string) => {
  const store = new Map<string, unknown>()
  const sent = { requests: 0, asked: 0, aborted: [] as string[], notes: [] as string[], toasts: [] as string[] }
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('command.register', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    sent.toasts.push(e.text)
    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }) as never)
  on('turn.abort', ($, e) => {
    sent.aborted.push(e.turnId)
    return { value: undefined }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    sent.asked += 1
    if (answer === undefined) return { isError: true as const, result: 'dismissed', text: 'dismissed' }
    const q = (e as unknown as { questions: { question: string }[] }).questions[0]!.question
    return { result: { questions: (e as never as { questions: unknown[] }).questions, answers: { [q]: answer } } as never }
  })
  on('turn.step', async function* ($, e) {
    sent.requests += 1
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'tool_use' as const,
      usage: { input_tokens: 100_000, output_tokens: 10, cache_read_input_tokens: 900_000, cache_creation_input_tokens: 0, model: 'm' },
    }
  })
  return sent
}

const reading = (percentUsed: number) =>
  ({ rateLimits: [{ kind: 'five_hour', percentUsed }], context: { window: 1_000_000 }, changed: ['rateLimits'] }) as never

const step = async ($: { turn: { step: (e: never) => AsyncIterable<unknown> & PromiseLike<unknown> } }, index: number) => {
  const stream = $.turn.step({ turnId: 't1', index, model: 'm', messageCount: 1 } as never)
  for await (const _ of stream) void _
  return stream
}

describe('turn-budget', () => {
  test('does not ask while under the limit', async ($, on) => {
    const sent = engine(on, 'Stop here')
    await $.session.measure(reading(20))
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.session.measure(reading(23))
    await step($ as never, 0)

    expect(sent.asked).toBe(0)
    expect(sent.requests).toBe(1)
  })

  test('Stop here: asks before the request and sends nothing more', async ($, on) => {
    const sent = engine(on, 'Stop here')
    await $.session.measure(reading(20))
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.session.measure(reading(26))
    await step($ as never, 0)
    await step($ as never, 1)

    expect(sent.asked).toBe(1)
    expect(sent.requests).toBe(0)
    expect(sent.aborted).toEqual(['t1'])
  })

  test('Continue asks again one step later, not before', async ($, on) => {
    const sent = engine(on, 'Continue')
    await $.session.measure(reading(20))
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.session.measure(reading(26))
    await step($ as never, 0)
    await $.session.measure(reading(28))
    await step($ as never, 1)
    await $.session.measure(reading(31))
    await step($ as never, 2)

    expect(sent.asked).toBe(2)
    expect(sent.requests).toBe(3)
  })

  test("Don't ask again holds for this turn only", async ($, on) => {
    const sent = engine(on, "Don't ask again")
    await $.session.measure(reading(20))
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.session.measure(reading(40))
    await step($ as never, 0)
    await step($ as never, 1)
    expect(sent.asked).toBe(1)

    await $.turn.start({ text: 'again', turnId: 't2' })
    await $.session.measure(reading(46))
    const stream = $.turn.step({ turnId: 't2', index: 0, model: 'm', messageCount: 1 } as never)
    for await (const _ of stream) void _
    expect(sent.asked).toBe(2)
  })

  test('the token backstop asks when the session meter has not moved', async ($, on) => {
    const sent = engine(on, 'Continue')
    await $.session.measure(reading(20))
    await $.turn.start({ text: 'go', turnId: 't1' })
    for (let i = 0; i < 6; i++) await step($ as never, i)

    // 100,000 uncached per request (cache reads left out): asks before the 6th.
    expect(sent.asked).toBe(1)
    expect(sent.requests).toBe(6)
  })

  test('a question nobody answers never stops the turn', async ($, on) => {
    const sent = engine(on)
    await $.session.measure(reading(20))
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.session.measure(reading(30))
    await step($ as never, 0)
    await step($ as never, 1)

    expect(sent.asked).toBe(1)
    expect(sent.requests).toBe(2)
    expect(sent.aborted).toEqual([])
  })

  test('/turn-budget sets the limit with a toast and no transcript text', async ($, on) => {
    const sent = engine(on, 'Continue')
    const ran = await $.command.run({ command: 'turn-budget', args: '8' } as never)

    expect(ran.text).toBeUndefined()
    expect(sent.toasts.at(-1)).toContain('asks at +8 session points')
  })
})
