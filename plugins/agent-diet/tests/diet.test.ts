import { describe, expect, test } from 'claude-code/testing'

import { DEFAULTS, describe as say, parseCommand, pick } from '../hooks/register'

describe('agent-diet', () => {
  test('moves a listed agent type to the cheaper model', async () => {
    expect(pick(DEFAULTS, { subagentType: 'Explore' })).toBe('haiku')
  })

  test('leaves other agent types alone', async () => {
    expect(pick(DEFAULTS, { subagentType: 'general-purpose' })).toBeUndefined()
    expect(pick(DEFAULTS, { subagentType: 'Plan' })).toBeUndefined()
  })

  test('keeps a model Claude asked for, and forks', async () => {
    expect(pick(DEFAULTS, { subagentType: 'Explore', model: 'opus' })).toBeUndefined()
    expect(pick(DEFAULTS, { subagentType: 'Explore', fork: true })).toBeUndefined()
  })

  test('does nothing when off', async () => {
    expect(pick({ ...DEFAULTS, isOn: false }, { subagentType: 'Explore' })).toBeUndefined()
  })

  test('parses the command', async () => {
    expect(parseCommand('', DEFAULTS)).toBeUndefined()
    expect(parseCommand('off', DEFAULTS)).toEqual({ ...DEFAULTS, isOn: false })
    expect(parseCommand('model sonnet', DEFAULTS)).toEqual({ ...DEFAULTS, model: 'sonnet' })
    expect(parseCommand('model gpt', DEFAULTS)).toContain('Use /agent-diet')
    expect(parseCommand('add wide-reader', DEFAULTS)).toEqual({ ...DEFAULTS, types: ['Explore', 'wide-reader'] })
    expect(parseCommand('remove Explore', DEFAULTS)).toEqual({ ...DEFAULTS, types: [] })
    expect(parseCommand('dance', DEFAULTS)).toContain('Use /agent-diet')
  })

  test('says what it does in one line', async () => {
    expect(say(DEFAULTS, 3)).toBe('agent-diet on · Explore on haiku · 3 this session')
    expect(say({ ...DEFAULTS, isOn: false }, 0)).toBe('agent-diet off · subagents run on their usual model')
  })
})
