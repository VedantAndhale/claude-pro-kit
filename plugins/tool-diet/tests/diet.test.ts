import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { CORE, RECENT, shouldDefer, sourceOf, summarize } from '../hooks/register'

const memory = (patch: Partial<{ sessions: number; lastUsed: Record<string, number>; keep: string[]; isOff: boolean }> = {}) => ({
  sessions: 10,
  lastUsed: {},
  keep: [],
  isOff: false,
  ...patch,
})

describe('shouldDefer', () => {
  test('never defers core tools', () => {
    for (const tool of CORE) expect(shouldDefer(tool, memory())).toBe(false)
  })

  test('defers a tool never used', () => {
    expect(shouldDefer('Artifact', memory())).toBe(true)
  })

  test(`keeps a tool used in the last ${RECENT} sessions, defers one used before that`, () => {
    expect(shouldDefer('Artifact', memory({ lastUsed: { Artifact: 6 } }))).toBe(false)
    expect(shouldDefer('Artifact', memory({ lastUsed: { Artifact: 5 } }))).toBe(true)
  })

  test('keeps a tool the person pinned, and nothing when off', () => {
    expect(shouldDefer('Artifact', memory({ keep: ['Artifact'] }))).toBe(false)
    expect(shouldDefer('Artifact', memory({ isOff: true }))).toBe(false)
  })
})

// An in-memory store and a stand-in for the engine's own tool description.
const engine = (on: On) => {
  const store = new Map<string, unknown>()
  const toasts: string[] = []
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('command.register', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('tool.describe', ($, e) => ({ description: e.description, ...(e.isDeferred ? { isDeferred: true } : {}) }))
  return { store, toasts }
}

const describeTool = (tool: string, isDeferred = false) => ({
  tool,
  description: `${tool} does things`,
  provider: { plugin: 'engine', tier: 'core' as const },
  ...(isDeferred ? { isDeferred: true as const } : {}),
})

describe('summary', () => {
  test('names MCP servers instead of ids and groups by source', () => {
    expect(sourceOf({ plugin: 'engine', tier: 'core' })).toBe('built-in')
    expect(sourceOf({ plugin: 'mcp:claude.ai Claude Docs', tier: 'user' })).toBe('claude.ai Claude Docs')

    const moved = new Map([
      ['Artifact', 'built-in'], ['Workflow', 'built-in'], ['ListAgents', 'built-in'], ['ReportFindings', 'built-in'], ['SendUserFile', 'built-in'],
      ['mcp__1a59c906-04da__batch', 'claude.ai Claude Docs'], ['mcp__1a59c906-04da__guide', 'claude.ai Claude Docs'],
    ])
    expect(summarize(moved)).toBe('5 built-in: Artifact, ListAgents +3 more · 2 from claude.ai Claude Docs: batch, guide')
    expect(sourceOf({ plugin: 'mcp:1a59c906-04da-521d-bda7-7f71b9f9e01c', tier: 'user' })).toBe('a connector')

    const many = new Map([['a', 'one'], ['b', 'two'], ['c', 'three'], ['d', 'four'], ['e', 'five']])
    expect(summarize(many).endsWith(' · +2 more sources')).toBe(true)
  })
})

describe('tool-diet', () => {
  test('moves an unused tool on demand and leaves core tools loaded', async ($, on) => {
    engine(on)
    await $.session.start({ source: 'startup', cwd: 'C:/repo' } as never)

    expect((await $.tool.describe(describeTool('Artifact') as never)).isDeferred).toBe(true)
    expect((await $.tool.describe(describeTool('Bash') as never)).isDeferred).toBeUndefined()
  })

  test("leaves a tool another plugin explicitly keeps listed", async ($, on) => {
    on('tool.describe', { tool: 'mcp__answer-pane__show_page' }, ($, e) => ({ description: e.description, isDeferred: false }))
    engine(on)
    await $.session.start({ source: 'startup', cwd: 'C:/repo' } as never)

    expect((await $.tool.describe(describeTool('mcp__answer-pane__show_page') as never)).isDeferred).toBe(false)
  })

  test('keeps a tool loaded in the sessions after it was used', async ($, on) => {
    engine(on)
    on('tool.call', () => ({ result: {} as never }))
    await $.session.start({ source: 'startup', cwd: 'C:/repo' } as never)
    await $.tool.call({ tool: 'ListAgents' } as never)
    await $.session.start({ source: 'startup', cwd: 'C:/repo' } as never)

    expect((await $.tool.describe(describeTool('ListAgents') as never)).isDeferred).toBeUndefined()
  })

  test('/tool-diet answers with a toast and no transcript text', async ($, on) => {
    const { toasts } = engine(on)
    await $.session.start({ source: 'startup', cwd: 'C:/repo' } as never)
    await $.tool.describe(describeTool('Artifact') as never)
    await $.tool.describe(describeTool('Workflow') as never)

    const ran = await $.command.run({ command: 'tool-diet', args: '' } as never)
    expect(ran.text).toBeUndefined()
    expect(toasts.at(-1)).toBe('2 tools on demand. 2 built-in: Artifact, Workflow')
  })

  test('/tool-diet keep pins a tool for later sessions', async ($, on) => {
    engine(on)
    await $.session.start({ source: 'startup', cwd: 'C:/repo' } as never)
    await $.command.run({ command: 'tool-diet', args: 'keep Artifact' } as never)
    await $.session.start({ source: 'startup', cwd: 'C:/repo' } as never)

    expect((await $.tool.describe(describeTool('Artifact') as never)).isDeferred).toBeUndefined()
  })
})
