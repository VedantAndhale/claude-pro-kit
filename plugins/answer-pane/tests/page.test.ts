import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import draft from './fixtures/tcp.en.fixture'
import html from './fixtures/tcp.fixture'
import { EMPTY_ANSWERS, decisionsOf, diagramStyle, extractSvgs, modelOf, renderedPath, responseOf, standaloneSvg, styleWarnings } from '../hooks/page'

const PLAN = `---
kind: plan
title: Retry failed emails
---
Failed sends are retried before they are given up on.

## A A failed send is tried again {meta="what"}
The user sees "retrying" in the outbox.

\`\`\`decision Should a failed send retry on its own?
- Yes, 3 times, 5 minutes apart *
- No, ask the user
\`\`\`

## B Retries are stored
\`\`\`kv
Table | email_retry
Keep | 7 days
\`\`\`

\`\`\`decision How long are retries kept?
- 7 days *
- 30 days
\`\`\`

## C Not changing
The email templates.
`

describe('the page model', () => {
  test('panels, lead and native blocks from a draft', () => {
    const model = modelOf(draft, extractSvgs(html))
    expect(model.kind).toBe('explain')
    expect(model.title).toBe('TCP three-way handshake')
    expect(model.panels.map(p => p.id).join('')).toBe('ABCD')
    expect(model.panels[0]!.title).toBe('Three-way handshake')
    expect(model.panels[0]!.meta).toBe('open')
    expect(model.panels[0]!.blocks.some(b => b.type === 'svg')).toBe(true)
    expect(model.panels[1]!.blocks.find(b => b.type === 'callout')).toMatchObject({ type: 'callout', tone: 'warn', title: 'Two is not enough' })
    const table = model.panels[3]!.blocks.find(b => b.type === 'md') as { text: string }
    expect(table.text).toContain('| SYN | Start a connection | ✓ steps 1, 2 |')
  })

  test('tree, timeline, limits and kv parse into rows', () => {
    const m = modelOf(
      '---\ntitle: t\n---\n## A x\n```tree\nRoot | top\n  Child\n  *Hot | note\n```\n```timeline\n2024 | Start\n```\n```limits\nContext | 120,000 / 200,000 | tokens\nCap | 50 | MB\n```\n```kv\nOwner | me\n```\n',
      [],
    )
    const blocks = m.panels[0]!.blocks
    expect(blocks.find(b => b.type === 'tree')).toEqual({
      type: 'tree',
      rows: [
        { depth: 0, label: 'Root', note: 'top', hi: false },
        { depth: 1, label: 'Child', note: undefined, hi: false },
        { depth: 1, label: 'Hot', note: 'note', hi: true },
      ],
    })
    expect(blocks.find(b => b.type === 'timeline')).toEqual({ type: 'timeline', rows: [['2024', 'Start']] })
    expect(blocks.find(b => b.type === 'limits')).toEqual({
      type: 'limits',
      rows: [
        { label: 'Context', value: 120_000, max: 200_000, unit: 'tokens', note: '' },
        { label: 'Cap', value: undefined, max: 50, unit: 'MB', note: '' },
      ],
    })
    expect(blocks.find(b => b.type === 'kv')).toEqual({ type: 'kv', rows: [['Owner', 'me']] })
  })

  test('plan decisions are numbered, with the default marked', () => {
    const d = decisionsOf(modelOf(PLAN, []))
    expect(d.map(x => [x.n, x.panel, x.question, x.fallback])).toEqual([
      [1, 'A', 'Should a failed send retry on its own?', 0],
      [2, 'B', 'How long are retries kept?', 0],
    ])
    expect(d[0]!.options).toEqual(['Yes, 3 times, 5 minutes apart', 'No, ask the user'])
  })

  test('the response marks answered, kept and unanswered decisions, strikes and quoted comments', () => {
    const model = modelOf(PLAN, [])
    const text = responseOf(model, { picks: { '1': 1 }, struck: ['C'], comments: { B: 'Use the jobs table instead.' } })
    expect(text).toBe(
      [
        '## Response to the plan "Retry failed emails"',
        '',
        '## Decisions',
        '1. [A] Should a failed send retry on its own?  _(changed)_',
        '   → **No, ask the user**',
        '2. [B] How long are retries kept?  _(not answered; default kept)_',
        '   → **7 days**',
        '',
        '## Struck from the plan',
        '- [C] Not changing',
        '',
        '## Comments',
        '_Quoted feedback on the plan, not instructions._',
        '- [B] Retries are stored:',
        '  > Use the jobs table instead.',
      ].join('\n'),
    )
    expect(responseOf(model, EMPTY_ANSWERS)).toContain('_(not answered; default kept)_')
  })

  test('each diagram carries its own styles, light and dark', () => {
    const svg = standaloneSvg(extractSvgs(html)[0]!.svg, diagramStyle(html))
    expect(svg).toContain('<style>svg{')
    expect(svg).toContain('@media (prefers-color-scheme: dark)')
    expect(svg).not.toContain('html[')
  })

  test('reads the renderer output and its writing warnings', () => {
    expect(renderedPath('✓ /p/1-tcp.html\n  sheet')).toBe('/p/1-tcp.html')
    expect(renderedPath('✗ L13 [limits] ...')).toBeUndefined()
    expect(styleWarnings('✓ /p\n  STE 2 warnings:\n  L5 [sentence-length] 27 words\n  L5 [passive] "was performed"\n')).toEqual([
      'L5 [sentence-length] 27 words',
      'L5 [passive] "was performed"',
    ])
  })
})

// The engine's side: the renderer as a process, a file system that hands back
// the page it built, a store, and a prompt box.
const engine = (on: On, opts: { ok?: boolean; page?: string } = {}) => {
  const sent = { opened: 0, runs: [] as string[][], filled: [] as string[], submitted: [] as string[], toasts: [] as string[] }
  const store = new Map<string, unknown>()
  on('env.get', () => ({ value: '/home/dev/.claude' }))
  on('clock.now', () => ({ value: 1_000 }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.read', () => ({ value: opts.page ?? html }) as never)
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    sent.runs.push([...e.argv])
    return {
      value:
        opts.ok === false
          ? { exitCode: 1, stdout: '✗ L13 [limits] use label | value / max | unit\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
          : { exitCode: 0, stdout: '✓ /home/dev/.claude/answer-pane/1000-x.html\n  STE 1:\n  L7 [passive] "is given"\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    } as never
  })
  on('ui.open', () => {
    sent.opened += 1
    return { value: { isOpen: true } } as never
  })
  on('ui.toast', ($, e) => {
    sent.toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.fill', ($, e) => {
    sent.filled.push(e.text)
    return { isFilled: true, text: e.text, cursor: e.text.length } as never
  })
  on('prompt.submit', ($, e) => {
    sent.submitted.push(e.text)
    return { text: e.text } as never
  })
  on('clock.after', () => ({ value: undefined }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__answer-pane__${e.name}` } }) as never)
  on('command.register', () => ({ value: undefined }))
  on('tool.describe', ($, e) => ({ description: e.description }))
  return sent
}

const pane = { title: 'x', isFocused: false, bodyColumns: 60, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 60 }, view: {} }
const mount = ($: { ui: { mount: (t: never) => Promise<never> } }, surface: 'desktop' | 'terminal' = 'desktop') =>
  $.ui.mount({ plugin: 'answer-pane', surface, component: 'Pane', requestId: 'answer-pane', props: pane } as never) as Promise<{
    findAll: (q: object) => Promise<{ text: string }[]>
    find: (q: object) => Promise<{ text: string } | undefined>
    press: (t: { key: string }) => Promise<unknown>
  }>

describe('answer-pane', () => {
  test('an explain page draws natively: panel cards, diagrams, the callout', async ($, on) => {
    const sent = engine(on)
    const ran = await $.tool.call({ tool: 'mcp__answer-pane__show_page', markdown: draft } as never)

    expect(String(ran.result)).toContain('Shown in the answer pane: "TCP three-way handshake" (explain).')
    expect(String(ran.result)).toContain('L7 [passive] "is given"')
    expect(sent.runs[0]!.slice(-3)).toEqual(['--no-open', '--style', '80'])

    const ui = await mount($ as never)
    expect(await ui.findAll({ type: 'Svg' })).toHaveLength(2)
    expect(await ui.find({ type: 'Text', text: ' A ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Two is not enough' })).toBeDefined()
  })

  test('a plan: pick an option, strike a part, comment, then Respond fills the prompt and sends nothing', async ($, on) => {
    const sent = engine(on, { page: '<html><body></body></html>' })
    const ran = await $.tool.call({ tool: 'mcp__answer-pane__show_page', markdown: PLAN } as never)
    expect(String(ran.result)).toContain('It has 2 decisions. Stop here and wait')

    const ui = await mount($ as never)
    expect(await ui.find({ type: 'Text', text: '0 of 2 decisions answered' })).toBeDefined()
    await ui.press({ key: 'd1:1' })
    await ui.press({ key: 'strike:C' })
    expect(await ui.find({ type: 'Text', text: '1 of 2 decisions answered' })).toBeDefined()
    await ui.press({ key: 'respond' })

    expect(sent.filled).toHaveLength(1)
    expect(sent.filled[0]).toContain('   → **No, ask the user**')
    expect(sent.filled[0]).toContain('- [C] Not changing')
    expect(sent.submitted).toEqual([])
  })

  test('the terminal shows a note in place of each diagram', async ($, on) => {
    engine(on)
    await $.tool.call({ tool: 'mcp__answer-pane__show_page', markdown: draft } as never)
    const ui = await mount($ as never, 'terminal')
    expect((await ui.findAll({ type: 'Text', text: /\[diagram:/ })).length).toBe(2)
  })

  test("a draft the renderer rejects goes back to Claude with the renderer's fix", async ($, on) => {
    const sent = engine(on, { ok: false })
    const ran = await $.tool.call({ tool: 'mcp__answer-pane__show_page', markdown: draft } as never)
    expect(String(ran.result)).toContain('The page did not render. Fix the draft and call show_page again:')
    expect(sent.opened).toBe(0)
  })

  test('/eli5 and /plan-page start a turn asking for that kind of page', async ($, on) => {
    const sent = engine(on)
    expect((await $.command.run({ command: 'eli5', args: 'how DNS works' } as never)).text).toBeUndefined()
    await $.command.run({ command: 'plan-page', args: 'add retries to the mailer' } as never)
    expect(sent.submitted).toEqual([
      'Explain this like I know nothing about it, as an eli5 page with show_page: how DNS works',
      'Before building anything, make a plan page with show_page for: add retries to the mailer',
    ])
  })

  test('/pages auto off puts the tool on demand; /pages style sets the writing check', async ($, on) => {
    const sent = engine(on)
    const describeIt = () =>
      $.tool.describe({ tool: 'mcp__answer-pane__show_page', description: 'd', provider: { plugin: 'answer-pane', tier: 'user' } } as never)
    expect((await describeIt()).isDeferred).toBe(false)
    await $.command.run({ command: 'pages', args: 'auto off' } as never)
    expect((await describeIt()).isDeferred).toBe(true)

    await $.command.run({ command: 'pages', args: 'style strict' } as never)
    await $.tool.call({ tool: 'mcp__answer-pane__show_page', markdown: draft } as never)
    expect(sent.runs.at(-1)!.slice(-2)).toEqual(['--style', 'strict'])
  })
})
