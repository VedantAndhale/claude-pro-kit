import { describe, expect, test } from 'claude-code/testing'

import { TOOLS, diet, kindOf, textOf } from '../hooks/diet'

const lines = (n: number, special: Record<number, string> = {}) =>
  Array.from({ length: n }, (_, i) => special[i + 1] ?? `line ${i + 1}`).join('\n')

const PATH = 'C:/Users/dev/.claude/output-diet/session-1/toolu_1.txt'

describe('diet', () => {
  test('leaves short output alone', () => {
    expect(diet(lines(120), PATH)).toBeUndefined()
  })

  test('keeps the first 30 and last 50 lines of long output', () => {
    const slim = diet(lines(500), PATH) ?? ''

    expect(slim.startsWith(`[output-diet: 80/500 lines shown; all 500 in ${PATH}]`)).toBe(true)
    expect(slim).toContain('line 1\n')
    expect(slim).toContain('line 30\n')
    expect(slim).toContain('… [lines 31–450 omitted]')
    expect(slim).not.toContain('line 31\n')
    expect(slim).not.toContain('line 450\n')
    expect(slim).toContain('line 451\n')
    expect(slim.endsWith('line 500')).toBe(true)
  })

  test('keeps error and warning lines from the omitted middle, with their line numbers', () => {
    const slim = diet(lines(500, { 250: 'ERROR: build failed in src/app.ts', 300: 'Warning: deprecated API' }), PATH) ?? ''

    expect(slim).toContain('[output-diet: 82/500 lines shown;')
    expect(slim).toContain('… [lines 31–450 omitted; error/warning lines from them:]')
    expect(slim).toContain('   250│ ERROR: build failed in src/app.ts')
    expect(slim).toContain('   300│ Warning: deprecated API')
  })

  test('keeps at most 40 matched lines', () => {
    const errors = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [100 + i, `error ${i}`]))
    const slim = diet(lines(500, errors), PATH) ?? ''

    expect(slim).toContain('[output-diet: 120/500 lines shown;')
    expect(slim).toContain('   139│ error 39')
    expect(slim).not.toContain('   140│ error 40')
  })

  test('cuts very long lines when the output is few lines but many characters', () => {
    const slim = diet(lines(10, { 5: 'x'.repeat(10_000) }), PATH) ?? ''

    expect(slim).toContain(`${'x'.repeat(400)} [… line cut]`)
    expect(slim).not.toContain('omitted')
    expect(slim.length).toBeLessThan(2_000)
  })

  test('reads plain string results and text-block results', () => {
    expect(textOf('plain')).toBe('plain')
    expect(textOf([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb')
    expect(textOf([{ type: 'image', source: {} }])).toBeUndefined()
  })

  test('applies to shell, search and subagent results only', () => {
    expect(TOOLS.has('Bash')).toBe(true)
    expect(TOOLS.has('PowerShell')).toBe(true)
    expect(TOOLS.has('Grep')).toBe(true)
    expect(TOOLS.has('Agent')).toBe(true)
    expect(TOOLS.has('Read')).toBe(false)
    expect(TOOLS.has('Glob')).toBe(false)
  })

  test('keeps the first 100 lines of a long search result', () => {
    const text = Array.from({ length: 250 }, (_, i) => `src/f${i}.ts:1:match`).join('\n')
    const slim = diet(text, 'X', kindOf('Grep')) as string
    expect(slim.startsWith('[output-diet: first 100/250 lines shown; narrow the search, or read all in X]')).toBe(true)
    expect(slim).toContain('src/f99.ts')
    expect(slim).not.toContain('src/f100.ts')
  })

  test('keeps the opening and the conclusion of a long subagent report', () => {
    const text = `START${'a'.repeat(20_000)}END`
    const slim = diet(text, 'X', kindOf('Agent')) as string
    expect(slim).toContain('8,000/20,008 chars of the report shown; all in X')
    expect(slim).toContain('START')
    expect(slim).toContain('END')
    expect(slim).toContain('[12,008 chars omitted]')
  })

  test('leaves a report of many short lines under 8,000 chars alone', () => {
    const text = Array.from({ length: 200 }, () => 'ok').join('\n')
    expect(diet(text, 'X', kindOf('Agent'))).toBeUndefined()
  })
})
