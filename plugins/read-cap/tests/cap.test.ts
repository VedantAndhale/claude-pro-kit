import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { describeOutline, lineCount, outline } from '../hooks/register'

const FILE = 'C:/repo/src/big.ts'

const lines = (n: number) => Array.from({ length: n }, (_, i) => `// line ${i + 1}`).join('\n') + '\n'

const engine = (on: On, text: string) => {
  const runs = { count: 0 }
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: text.length, mtimeMs: 1, isLink: false } }))
  on('fs.read', () => ({ value: text }))
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', { tool: 'Read' }, () => {
    runs.count += 1
    return { result: { type: 'text', file: {} } as never }
  })
  return runs
}

const read = (extra: Record<string, unknown> = {}) => ({ tool: 'Read' as const, file_path: FILE, ...extra })

const SOURCE = [
  '# Notes',
  'import { x } from "y"',
  'export async function load(path: string) {',
  '  if (path) {',
  '  }',
  '}',
  'export class Store {',
  '  async get(key: string): Promise<string> {',
  '  }',
  '}',
  'export const LIMIT = 10',
  'def handler(event):',
  'class Parser:',
  'func Run(ctx context.Context) error {',
  'pub fn parse(input: &str) -> Result<()> {',
  '  for (const a of b) {',
].join('\n')

describe('read-cap', () => {
  test('counts lines with or without a final newline', async () => {
    expect(lineCount('a\nb\n')).toBe(2)
    expect(lineCount('a\nb')).toBe(2)
    expect(lineCount('')).toBe(0)
  })

  test('outlines definitions across languages and skips control flow', async () => {
    expect(outline(SOURCE).entries).toEqual([
      '1: # Notes',
      '3: export async function load(path: string) {',
      '7: export class Store {',
      '8: async get(key: string): Promise<string> {',
      '11: export const LIMIT = 10',
      '12: def handler(event):',
      '13: class Parser:',
      '14: func Run(ctx context.Context) error {',
      '15: pub fn parse(input: &str) -> Result<()> {',
    ])
  })

  test('heads the outline with the exact line count', async () => {
    expect(describeOutline(FILE, SOURCE).split('\n')[0]).toBe('big.ts: 16 lines')
  })

  test('lets a short file through', async ($, on) => {
    const runs = engine(on, lines(1000))
    const done = await $.tool.call(read())

    expect(done.deny).toBeUndefined()
    expect(runs.count).toBe(1)
  })

  test('refuses a whole read of a long file once, then lets the retry through', async ($, on) => {
    const runs = engine(on, lines(3412))
    const first = await $.tool.call(read())
    const second = await $.tool.call(read())

    expect(first.deny).toContain('big.ts has 3,412 lines')
    expect(second.deny).toBeUndefined()
    expect(runs.count).toBe(1)
  })

  test('lets a ranged read of a long file through', async ($, on) => {
    const runs = engine(on, lines(3412))
    const done = await $.tool.call(read({ offset: 200, limit: 80 }))

    expect(done.deny).toBeUndefined()
    expect(runs.count).toBe(1)
  })

  test('lets an image through without reading it', async ($, on) => {
    const runs = engine(on, lines(3412))
    const done = await $.tool.call(read({ file_path: 'C:/repo/shot.png' }))

    expect(done.deny).toBeUndefined()
    expect(runs.count).toBe(1)
  })

  test('answers the outline tool from the file on disk', async ($, on) => {
    engine(on, SOURCE)
    const done = await $.tool.call({ tool: 'mcp__read-cap__outline', file_path: FILE } as never)

    expect(String(done.result)).toContain('7: export class Store {')
  })
})
