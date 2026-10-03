import { describe, expect, test } from 'claude-code/testing'

import { costliest, duration, firstLine, row, spent, totals } from '../hooks/register'
import type { ReceiptTurn } from '../types'

const turn = (n: number, newTok: number, outTok: number, extra: Partial<ReceiptTurn> = {}): ReceiptTurn => ({
  n,
  prompt: `prompt ${n}`,
  isRunning: false,
  ms: 42_000,
  tools: 3,
  newTok,
  cacheTok: 50_000,
  outTok,
  agentTok: 0,
  ...extra,
})

const list = [turn(1, 24_000, 400), turn(2, 1_200, 300), turn(3, 61_000, 2_000), turn(4, 900, 100, { isRunning: true })]

describe('session-receipt', () => {
  test('counts uncached input and output as spent, not cache reads', async () => {
    expect(spent(turn(1, 24_000, 400))).toBe(24_400)
  })

  test('adds up the session', async () => {
    expect(totals(list)).toEqual({ newTok: 87_100, cacheTok: 200_000, outTok: 2_800, agentTok: 0, tools: 12 })
  })

  test('ranks the costliest turns', async () => {
    expect(costliest(list, 2).map(t => t.n)).toEqual([3, 1])
  })

  test('writes a row with exact figures', async () => {
    expect(row(turn(3, 61_000, 2_000, { agentTok: 8_500 }))).toBe(
      '#3  61,000 new · 50,000 cached · 2,000 out (8,500 subagents) · 3 tools · 42s',
    )
    expect(row(list[3])).toBe('#4  900 new · 50,000 cached · 100 out · 3 tools · running')
  })

  test('formats durations and prompts', async () => {
    expect(duration(125_000)).toBe('2m 5s')
    expect(firstLine('  fix the parser\nand the tests')).toBe('fix the parser')
    expect(firstLine('x'.repeat(80))).toHaveLength(60)
  })
})
