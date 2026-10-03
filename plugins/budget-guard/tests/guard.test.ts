import { describe, expect, test } from 'claude-code/testing'

import { holdText, overLimit, parseCommand, untilReset } from '../hooks/register'

const NOW = Date.parse('2026-10-03T12:00:00Z')

const readings = [
  { kind: 'five_hour', pct: 93, resetsAt: '2026-10-03T13:12:00Z' },
  { kind: 'seven_day', pct: 61, resetsAt: '2026-10-07T09:00:00Z' },
]

describe('budget-guard', () => {
  test('finds the windows at or over the limit', async () => {
    expect(overLimit(readings, 90).map(r => r.kind)).toEqual(['five_hour'])
    expect(overLimit(readings, 95)).toEqual([])
    expect(overLimit(readings, 61).map(r => r.kind)).toEqual(['five_hour', 'seven_day'])
  })

  test('ignores windows it does not know', async () => {
    expect(overLimit([{ kind: 'gateway', pct: 100 }], 90)).toEqual([])
  })

  test('says how long until the window resets', async () => {
    expect(untilReset('2026-10-03T13:12:00Z', NOW)).toBe('1h 12m')
    expect(untilReset('2026-10-03T12:20:00Z', NOW)).toBe('20m')
    expect(untilReset('2026-10-07T09:00:00Z', NOW)).toBe('3d 21h')
    expect(untilReset(undefined, NOW)).toBeUndefined()
  })

  test('explains the hold with exact readings', async () => {
    expect(holdText(overLimit(readings, 90), 90, NOW)).toBe(
      'budget-guard: 5-hour usage at 93%, resets in 1h 12m (your limit is 90%). Send the same message again to go ahead, or /budget off.',
    )
  })

  test('parses the command', async () => {
    const on = { limit: 90, isOn: true }
    expect(parseCommand('', on)).toBeUndefined()
    expect(parseCommand('80', on)).toEqual({ limit: 80, isOn: true })
    expect(parseCommand('75%', { limit: 90, isOn: false })).toEqual({ limit: 75, isOn: true })
    expect(parseCommand('off', on)).toEqual({ limit: 90, isOn: false })
    expect(parseCommand('150', on)).toBe('Use /budget <1-100>, /budget on or /budget off.')
  })
})
