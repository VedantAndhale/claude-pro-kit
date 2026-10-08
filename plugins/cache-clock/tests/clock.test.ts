import { describe, expect, test } from 'claude-code/testing'

import { classify, contextOf, formatGap, formatLeft, statusText } from '../hooks/register'

const MIN = 60_000
const assumed = { ms: 5 * MIN, isConfirmed: false }
const hour = { ms: 60 * MIN, isConfirmed: true }

const hit = { input_tokens: 40, output_tokens: 300, cache_read_input_tokens: 60_000, cache_creation_input_tokens: 500 }
const miss = { input_tokens: 40, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 61_164 }

describe('cache-clock', () => {
  test('the next request re-sends input, cache read, cache write and output', async () => {
    expect(contextOf(hit)).toBe(60_840)
  })

  test('a hit after more than 5 minutes proves a 1 hour cache', async () => {
    expect(classify(7 * MIN, 60_840, hit, assumed)).toEqual({ ttl: hour, missTokens: undefined })
  })

  test('a miss after more than 5 minutes proves a 5 minute cache and counts the re-send', async () => {
    expect(classify(7 * MIN, 60_840, miss, assumed)).toEqual({
      ttl: { ms: 5 * MIN, isConfirmed: true },
      missTokens: 61_204,
    })
  })

  test('a quick follow-up proves nothing and reports no miss', async () => {
    expect(classify(30_000, 60_840, hit, assumed)).toEqual({ ttl: assumed, missTokens: undefined })
  })

  test('a miss inside the cache lifetime is not reported as an expiry', async () => {
    expect(classify(2 * MIN, 60_840, miss, hour).missTokens).toBeUndefined()
  })

  test('formats time left and idle gaps', async () => {
    expect(formatLeft(4 * MIN + 59_000)).toBe('4m')
    expect(formatLeft(41_000)).toBe('41s')
    expect(formatGap(7 * MIN + 12_000)).toBe('7m 12s')
    expect(formatGap(75 * MIN)).toBe('1h 15m')
  })

  test('status says warm with time left, or cold with the exact re-send', async () => {
    expect(statusText(3 * MIN, 61_204, hour)).toBe('cache warm · 3m left')
    expect(statusText(3 * MIN, 61_204, assumed)).toBe('cache warm · ≥3m left')
    expect(statusText(-1, 61_204, hour)).toBe('cache cold · next message re-sends 61,204 tokens')
    expect(statusText(-1, 61_204, assumed)).toBe('cache likely cold · next message re-sends 61,204 tokens')
  })
})

import { warnBefore } from '../hooks/register'

describe('the expiry warning', () => {
  test('5 minutes before a 1-hour cache ends, 1 minute before a 5-minute one', () => {
    expect(warnBefore(60 * 60_000)).toBe(5 * 60_000)
    expect(warnBefore(5 * 60_000)).toBe(60_000)
  })
})
