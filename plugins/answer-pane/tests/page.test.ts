import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import draft from './fixtures/tcp.en.fixture'
import html from './fixtures/tcp.fixture'
import { diagramStyle, extractSvgs, frontmatter, partsOf, renderedPath, standaloneSvg } from '../hooks/page'

describe('building the pane from a page', () => {
  test('reads the frontmatter', () => {
    const { meta, body } = frontmatter(draft)
    expect(meta.title).toBe('TCP three-way handshake')
    expect(body.startsWith('TCP opens a connection')).toBe(true)
  })

  test('puts each flow and sequence diagram where its block was, and keeps the text', () => {
    const { body } = frontmatter(draft)
    const svgs = extractSvgs(html)
    const parts = partsOf(body, svgs)

    expect(svgs).toHaveLength(2)
    expect(parts.map(p => p.kind)).toEqual(['md', 'svg', 'md', 'svg', 'md'])
    const text = parts.filter(p => p.kind === 'md').map(p => (p as { text: string }).text).join('\n')
    expect(text).toContain('## A Three-way handshake')
    expect(text).not.toContain('{span=2')
    expect(text).toContain('> **Two is not enough**')
    expect(text).toContain('| SYN | Start a connection | ✓ steps 1, 2 |')
    expect(text).toContain('| FIN | Stop sending | ✗ not used |')
  })

  test('each diagram carries its own styles, light and dark', () => {
    const style = diagramStyle(html)
    const svg = standaloneSvg(extractSvgs(html)[0]!.svg, style)

    expect(svg.startsWith('<svg ')).toBe(true)
    expect(svg).toContain('<style>svg{')
    expect(svg).toContain('--paper:')
    expect(svg).toContain('@media (prefers-color-scheme: dark)')
    expect(svg).toContain('.am-lifeline{')
    expect(svg).not.toContain('html[')
    expect(svg.length).toBeLessThan(131_072)
  })

  test('reads the renderer output', () => {
    expect(renderedPath('✓ C:\\Users\\dev\\.claude\\answer-pane\\1-tcp.html\n  sheet · blueprint')).toBe('C:\\Users\\dev\\.claude\\answer-pane\\1-tcp.html')
    expect(renderedPath('✗ L13 [limits] ...')).toBeUndefined()
  })
})

// The engine's side: the renderer as a process that prints its result, and a
// file system that hands back the page it built.
const engine = (on: On, ok: boolean) => {
  const sent = { opened: 0, runs: [] as string[][] }
  on('env.get', () => ({ value: '/home/dev/.claude' }))
  on('clock.now', () => ({ value: 1_000 }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.read', () => ({ value: html }) as never)
  on('process.run', ($, e) => {
    sent.runs.push([...e.argv])
    return {
      value: ok
        ? { exitCode: 0, stdout: '✓ /home/dev/.claude/answer-pane/1000-tcp.html\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
        : { exitCode: 1, stdout: '✗ L13 [limits] use label | value / max | unit\n  ```limits\n  Context | 12 / 20 | tokens\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    } as never
  })
  on('ui.open', () => {
    sent.opened += 1
    return { value: { isOpen: true } } as never
  })
  on('tool.register', ($, e) => ({ value: { tool: `mcp__answer-pane__${e.name}` } }) as never)
  on('command.register', () => ({ value: undefined }))
  const store = new Map<string, unknown>()
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('tool.describe', ($, e) => ({ description: e.description }))
  return sent
}

const pane = { title: 'x', isFocused: false, bodyColumns: 80, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }

describe('answer-pane', () => {
  test('listed up front by default; /pages auto off puts it on demand', async ($, on) => {
    engine(on, true)
    const describeIt = () =>
      $.tool.describe({ tool: 'mcp__answer-pane__show_page', description: 'd', provider: { plugin: 'answer-pane', tier: 'user' } } as never)
    expect((await describeIt()).isDeferred).toBe(false)

    const ran = await $.command.run({ command: 'pages', args: 'auto off' } as never)
    expect(ran.text).toBeUndefined()
    expect((await describeIt()).isDeferred).toBe(true)
  })

  test('renders with the vendored renderer and shows the page in the pane', async ($, on) => {
    const sent = engine(on, true)
    const ran = await $.tool.call({ tool: 'mcp__answer-pane__show_page', markdown: draft } as never)

    expect(String(ran.result ?? ran.text)).toContain('Shown in the answer pane: "TCP three-way handshake"')
    expect(sent.runs[0]!.slice(-7)).toEqual([
      'render',
      '/home/dev/.claude/answer-pane/1000-tcp-three-way-handshake.md',
      '-o',
      '/home/dev/.claude/answer-pane/1000-tcp-three-way-handshake.html',
      '--no-open',
      '--style',
      'off',
    ])
    expect(sent.opened).toBe(1)

    const ui = await $.ui.mount({ plugin: 'answer-pane', surface: 'desktop', component: 'Pane', requestId: 'answer-pane', props: pane })
    expect(await ui.findAll({ type: 'Svg' })).toHaveLength(2)
    expect((await ui.findAll({ type: 'Markdown' })).length).toBeGreaterThan(0)
    expect((await ui.find({ type: 'Text', text: 'TCP three-way handshake' }))).toBeDefined()
  })

  test('the terminal shows a note in place of each diagram', async ($, on) => {
    engine(on, true)
    await $.tool.call({ tool: 'mcp__answer-pane__show_page', markdown: draft } as never)
    const ui = await $.ui.mount({ plugin: 'answer-pane', surface: 'terminal', component: 'Pane', requestId: 'answer-pane', props: pane })

    expect((await ui.findAll({ type: 'Text', text: /\[diagram:/ })).length).toBe(2)
  })

  test("a draft the renderer rejects comes back to Claude with the renderer's fix", async ($, on) => {
    const sent = engine(on, false)
    const ran = await $.tool.call({ tool: 'mcp__answer-pane__show_page', markdown: draft } as never)

    expect(String(ran.result ?? ran.text)).toContain('The page did not render. Fix the draft and call show_page again:')
    expect(String(ran.result ?? ran.text)).toContain('Context | 12 / 20 | tokens')
    expect(sent.opened).toBe(0)
  })
})
