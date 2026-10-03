import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const BREAKDOWN = {
  categories: [
    { name: 'System prompt', tokens: 3_200, color: 'promptBorder', isDeferred: false, kind: 'used' },
    { name: 'System tools', tokens: 18_400, color: 'inactive', isDeferred: false, kind: 'used' },
    { name: 'MCP tools', tokens: 2_100, color: 'cyan_FOR_SUBAGENTS_ONLY', isDeferred: false, kind: 'used' },
    { name: 'MCP tools (deferred)', tokens: 41_000, color: 'inactive', isDeferred: true, kind: 'deferred' },
    { name: 'Memory files', tokens: 900, color: 'claude', isDeferred: false, kind: 'used' },
    { name: 'Messages', tokens: 75_400, color: 'purple_FOR_SUBAGENTS_ONLY', isDeferred: false, kind: 'used' },
    { name: 'Free space', tokens: 855_000, color: 'promptBorder', isDeferred: false, kind: 'free' },
    { name: 'Autocompact buffer', tokens: 45_000, color: 'inactive', isDeferred: false, kind: 'buffer' },
  ],
  totalTokens: 100_000,
  maxTokens: 1_000_000,
  rawMaxTokens: 1_000_000,
  autocompactSource: 'model',
  percentage: 10,
  gridRows: [],
  model: 'claude-opus-5-5',
  memoryFiles: [{ path: 'C:/Users/dev/.claude/CLAUDE.md', type: 'User', tokens: 900 }],
  mcpTools: [
    { name: 'mcp__browser__navigate', serverName: 'browser', tokens: 1_500, isLoaded: true },
    { name: 'mcp__browser__click', serverName: 'browser', tokens: 600, isLoaded: true },
    { name: 'mcp__github__create_pr', serverName: 'github', tokens: 2_000, isLoaded: false },
  ],
  agents: [{ agentType: 'Explore', source: 'built-in', tokens: 300 }],
  skills: { totalSkills: 40, includedSkills: 40, tokens: 6_000, skillFrontmatter: [] },
  isAutoCompactEnabled: true,
  apiUsage: null,
}

const engine = (on: On) => {
  on('clock.now', () => ({ value: Date.parse('2026-10-03T12:00:00Z') }))
  on('command.register', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isOpen: true } }) as never)
  on('session.usage', () => ({
    value: { context: { tokens: 100_000, window: 1_000_000, percent: 10, breakdown: BREAKDOWN }, rateLimits: [] },
  }) as never)
}

const pane = { title: 'Context X-ray', isFocused: false, bodyColumns: 90, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }

const texts = async (ui: { findAll: (q: { type?: string }) => Promise<{ text: string }[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(t => t.text)

describe('context-xray', () => {
  test('opens with no transcript text and shows the exact breakdown', async ($, on) => {
    engine(on)
    const ran = await $.command.run({ command: 'xray', args: '' } as never)
    expect(ran.text).toBeUndefined()

    const ui = await $.ui.mount({ plugin: 'context-xray', surface: 'desktop', component: 'Pane', requestId: 'context-xray', props: pane })
    const shown = await texts(ui)

    expect(shown).toContain('100,000 ')
    expect(shown).toContain('of 1,000,000 tokens · 10% full')
    expect(shown).toContain('Sent with every request')
    expect(shown).toContain('Messages')
    expect(shown).toContain('75,400')
    expect(shown).toContain('System tools')
    expect(shown).toContain('18,400')
    expect(shown).toContain('Loaded on demand')
    expect(shown).toContain('MCP tools (deferred)')
    expect(shown).toContain('  2 loaded · 1 on demand')
    expect(shown).toContain('mcp__browser__navigate')
    expect(shown).toContain('CLAUDE.md')
    expect(shown).toContain('Skills (40/40)')
    expect(shown).toContain('Free 855,000 · compaction buffer 45,000')
  })

  test('lists in-use categories largest first', async ($, on) => {
    engine(on)
    await $.command.run({ command: 'xray', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'context-xray', surface: 'desktop', component: 'Pane', requestId: 'context-xray', props: pane })
    const shown = await texts(ui)
    const order = ['Messages', 'System tools', 'System prompt', 'MCP tools', 'Memory files'].map(n => shown.indexOf(n))

    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  test('draws text bars in the terminal', async ($, on) => {
    engine(on)
    await $.command.run({ command: 'xray', args: '' } as never)
    const ui = await $.ui.mount({ plugin: 'context-xray', surface: 'terminal', component: 'Pane', requestId: 'context-xray', props: pane })

    expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
    expect((await texts(ui)).some(t => t.includes('━'))).toBe(true)
  })
})
