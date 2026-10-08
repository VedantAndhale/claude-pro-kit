import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AnswerBlock, AnswerKind, AnswerPage, AnswerReply, AnswerView } from '../types'
import {
  EMPTY_ANSWERS,
  decisionsOf,
  diagramStyle,
  extractSvgs,
  frontmatter,
  modelOf,
  renderedPath,
  responseOf,
  slug,
  standaloneSvg,
  styleWarnings,
} from './page'

// Three kinds of page in one side pane: explain, plan and eli5. Claude writes a
// short Markdown draft; the bundled renderer in vendor/ (MIT, license
// alongside) checks it, lays out its diagrams and writes a full HTML copy; the
// pane draws everything natively. No model calls: the draft is Claude's answer.

const PANE = 'answer-pane'
const TOOL = 'mcp__answer-pane__show_page'
const KEEP = 30
const MAX_ERROR = 1_500
const STYLES = ['off', '80', 'strict'] as const

const pages = atom({ plugin: 'answer-pane', key: 'pages' } as const, [] as AnswerPage[])
const currentId = atom({ plugin: 'answer-pane', key: 'currentId' } as const, null as string | null)
const view = atom({ plugin: 'answer-pane', key: 'view' } as const, 'page' as AnswerView)
const replies = atom({ plugin: 'answer-pane', key: 'replies' } as const, {} as Record<string, AnswerReply>)

// Kept short: it rides along with every request so Claude knows when to use it.
// The renderer's own messages teach the rest, each with a corrected example.
const DESCRIPTION = [
  'Show an answer as a visual page in a pane beside the chat. Set `kind:` in the frontmatter:',
  '- explain: an answer with 3+ linked concepts, a process or protocol, a comparison over 3+ dimensions, a hierarchy, or stages over time.',
  '- plan: before building anything that touches more than a couple of files. Panels are what someone can now do or see, split by behaviour (at most 5); inside, `### How` / `### Where` with one exhibit each (a diagram, or code with `path:line`). Put 2-5 decisions on the panels they change as ```decision Question? with `- option` lines, the default ending in ` *`. End with a panel `Not changing`. After showing it, stop and wait: the user answers in the pane and sends the response; build only after that.',
  '- eli5: for someone who knows nothing about the topic. At most 5 panels, a diagram in each, sentences under 15 words, no jargon.',
  'Format: `---` frontmatter with `kind:` and `title:` (optional `subtitle:`), a one-line lead, then panels `## A Panel title`. Inside: paragraphs, lists, tables (cells may start with ok / no / warn), and fenced blocks: ```flow LR lines `A -> B: label` (`-->` dashed, `(Round)`, `*Highlight`); ```sequence `participants: A, B` then `A -> B: msg`, `note A: text`; ```callout warn|note|tip Title; ```tree indented lines; ```timeline `when | what`; ```limits `label | value / max | unit`; ```kv `key | value`.',
  'Write plainly: short sentences, active voice, one idea each. No HTML or CSS. If the result reports an error, fix that line as shown and call again; style warnings are optional to fix, once. Then reply in 2-3 lines.',
].join('\n')

const join = (...parts: string[]) => parts.map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p)).join('/')

async function pagesDir($: EngineInterface): Promise<string | undefined> {
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  const base = config ?? (home === undefined ? undefined : join(home, '.claude'))
  return base === undefined ? undefined : join(base, 'answer-pane')
}

async function openInBrowser($: EngineInterface, path: string) {
  const isWindows = /^[a-z]:[\\/]/i.test(path)
  const argv = isWindows ? ['cmd', '/c', 'start', '', path] : [(await $.env.get('XDG_CURRENT_DESKTOP')) ? 'xdg-open' : 'open', path]
  await $.process.run(argv).catch(() => undefined)
}

async function render($: EngineInterface, draft: string): Promise<{ page?: AnswerPage; error?: string; warnings?: string[] }> {
  const dir = await pagesDir($)
  if (dir === undefined) return { error: 'answer-pane could not find a folder to write the page to.' }
  const { meta } = frontmatter(draft)
  const at = await $.clock.now()
  const id = `${at}-${slug(meta.title || 'answer')}`
  const draftPath = join(dir, `${id}.md`)
  const htmlPath = join(dir, `${id}.html`)
  await $.fs.write(draftPath, draft)

  const style = ((await $.store.get('style')) as string | undefined) ?? '80'
  const ran = await $.process
    .run(['node', join($.plugin.root, 'vendor', 'am.mjs'), 'render', draftPath, '-o', htmlPath, '--no-open', '--style', style])
    .catch((e: unknown) => ({ exitCode: 1, stdout: '', stderr: e instanceof Error ? e.message : String(e) }))
  const output = `${ran.stdout}\n${ran.stderr}`.trim()
  if (ran.exitCode !== 0 || renderedPath(ran.stdout) === undefined) {
    const hint = /ENOENT|not recognized|not found/i.test(output) && !/✗/.test(output) ? ' (Node.js 20+ must be installed)' : ''
    return { error: `The page did not render${hint}. Fix the draft and call show_page again:\n${output.slice(0, MAX_ERROR)}` }
  }

  const html = await $.fs.read(htmlPath)
  const css = diagramStyle(html, meta.theme || 'blueprint')
  const svgs = extractSvgs(html).map(s => ({ ...s, svg: standaloneSvg(s.svg, css) }))
  return { page: { ...modelOf(draft, svgs), id, htmlPath, at }, warnings: styleWarnings(ran.stdout) }
}

async function ask($: EngineInterface, kind: AnswerKind, topic: string) {
  const what =
    kind === 'eli5'
      ? `Explain this like I know nothing about it, as an eli5 page with show_page: ${topic}`
      : `Before building anything, make a plan page with show_page for: ${topic}`
  // A command cannot start a turn while it runs: the prompt goes in just after.
  $.clock.after(10, () => void $.prompt.submit({ text: what }))
}

const TONE: Record<string, string> = { warn: 'warning', note: 'claude', tip: 'success', error: 'error', info: 'claude' }
const KIND_LABEL: Record<AnswerKind, string> = { explain: 'Explain', plan: 'Plan', eli5: 'ELI5' }

// The bar of a `limits` row: the markup is wider than any pane and stretches,
// so it fills the space its row leaves.
const limitBar = (value: number, max: number) => {
  const w = max > 0 ? Math.max(1, Math.min(100, (value / max) * 100)) : 0
  const fill = w >= 95 ? '#E5534B' : w >= 80 ? '#E0A23A' : '#D97757'
  return `<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="6" viewBox="0 0 100 6" preserveAspectRatio="none"><rect width="100" height="6" fill="rgb(128,128,128)" fill-opacity="0.28"/><rect width="${w.toFixed(2)}" height="6" fill="${fill}"/></svg>`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'show_page',
      description: DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: { markdown: { type: 'string', description: 'The page draft: frontmatter with kind and title, a lead, then ## panels.' } },
        required: ['markdown'],
      },
    })
    await $.command.register({ name: 'pages', description: 'Answer pane: /pages · /pages auto on|off · /pages style off|80|strict' })
    await $.command.register({ name: 'eli5', description: 'Answer pane: explain a topic simply, as a page in the side pane' })
    await $.command.register({ name: 'plan-page', description: 'Answer pane: a plan with decisions in the side pane before Claude builds' })
    return next(e)
  })

  // Auto (the default): listed in front, so Claude can choose a page on its own.
  // Off: on demand through ToolSearch. Read once per session.
  on('tool.describe', { tool: TOOL }, async ($, e, next) => {
    const described = await next(e)
    const isAuto = ((await $.store.get('auto')) as boolean | undefined) ?? true
    return { ...described, isDeferred: !isAuto }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const draft = (e as { markdown?: unknown }).markdown
    if (typeof draft !== 'string' || draft.trim() === '') return { deny: 'show_page needs markdown: the page draft.' }

    const { page, error, warnings = [] } = await render($, draft)
    if (!page) return { result: error }

    await update($, pages, list => [page, ...list].slice(0, KEEP))
    await update($, currentId, () => page.id)
    await update($, view, () => 'page')
    await $.ui.open({ id: PANE, title: page.title })
    const decisions = decisionsOf(page).length
    const wait = page.kind === 'plan' ? ` It has ${decisions} decisions. Stop here and wait for the user's response before building.` : ''
    const style = warnings.length ? `\nWriting warnings (optional, fix once and call again, or leave):\n${warnings.slice(0, 8).join('\n')}` : ''
    return { result: `Shown in the answer pane: "${page.title}" (${page.kind}).${wait}${style}` }
  })

  // Answered with no text, so these commands add nothing to the conversation.
  on('command.run', { command: 'pages' }, async ($, e) => {
    const [a, b] = e.args.trim().toLowerCase().split(/\s+/)
    if (a === 'auto' && (b === 'on' || b === 'off')) {
      await $.store.set('auto', b === 'on')
      $.ui.toast(b === 'on' ? 'Answer pane: Claude can choose a page on its own, from the next session.' : 'Answer pane: pages on request only, from the next session.')
      return {}
    }
    if (a === 'style' && (STYLES as readonly string[]).includes(b ?? '')) {
      await $.store.set('style', b)
      $.ui.toast(`Answer pane: writing check ${b === 'off' ? 'off' : b === '80' ? '80% of ASD-STE100' : 'strict ASD-STE100'}.`)
      return {}
    }
    await update($, view, () => 'list')
    await $.ui.open({ id: PANE, title: 'Pages' })
    return {}
  })

  on('command.run', { command: 'eli5' }, async ($, e) => {
    if (e.args.trim()) await ask($, 'eli5', e.args.trim())
    else $.ui.toast('Usage: /eli5 <topic>')
    return {}
  })

  on('command.run', { command: 'plan-page' }, async ($, e) => {
    if (e.args.trim()) await ask($, 'plan', e.args.trim())
    else $.ui.toast('Usage: /plan-page <what to build>')
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown, Code } = $.ui.resolve(e)
    const Svg = e.surface === 'terminal' || e.surface === 'mobile' ? undefined : $.ui.resolve(e).Svg
    const Input = e.surface === 'mobile' ? undefined : $.ui.resolve(e).Input
    const list = await read($, pages)
    const id = await read($, currentId)
    const mode = await read($, view)
    const page = list.find(p => p.id === id) ?? list[0]

    if (mode === 'list' || !page) {
      return (
        <Box flexDirection="column">
          <Text bold>{'Pages this session'}</Text>
          {list.length === 0 && <Text dimColor>{'No pages yet. Try /eli5 <topic> or /plan-page <task>.'}</Text>}
          {list.map((p, i) => (
            <Button
              key={`p:${p.id}`}
              plain
              label={`${KIND_LABEL[p.kind]} · ${p.title}`}
              hotkey={i < 9 ? String(i + 1) : undefined}
              onPress={async () => {
                await update($, currentId, () => p.id)
                await update($, view, () => 'page')
              }}
            />
          ))}
        </Box>
      )
    }

    const reply = (await read($, replies))[page.id] ?? EMPTY_ANSWERS
    const setReply = (fn: (r: AnswerReply) => AnswerReply) =>
      update($, replies, all => ({ ...all, [page.id]: fn(all[page.id] ?? EMPTY_ANSWERS) }))
    const isPlan = page.kind === 'plan'
    const decisions = decisionsOf(page)
    const answered = decisions.filter(d => reply.picks[String(d.n)] !== undefined).length

    const draw = (b: AnswerBlock, key: string): unknown => {
      switch (b.type) {
        case 'md':
          return <Markdown key={key} text={b.text} />
        case 'code':
          return <Code key={key} source={b.text.slice(0, 10_000)} language={b.lang || undefined} />
        case 'svg':
          return Svg ? (
            <Box key={key} marginTop={1} marginBottom={1}>
              <Svg source={b.svg} alt={b.label} />
            </Box>
          ) : (
            <Text key={key} dimColor>{`[diagram: ${b.label}]`}</Text>
          )
        case 'callout':
          return (
            <Box key={key} flexDirection="column" borderStyle="round" borderColor={TONE[b.tone] ?? 'claude'} paddingX={1} marginTop={1} marginBottom={1}>
              {b.title && <Text bold color={TONE[b.tone] ?? 'claude'}>{b.title}</Text>}
              <Markdown text={b.text} />
            </Box>
          )
        case 'kv':
          return (
            <Box key={key} flexDirection="column" marginTop={1}>
              {b.rows.map(([k, v], i) => (
                <Box key={`${key}:${i}`} flexDirection="row">
                  <Box width={16} flexShrink={0}>
                    <Text dimColor wrap="truncate-end">{k}</Text>
                  </Box>
                  <Text>{v ?? ''}</Text>
                </Box>
              ))}
            </Box>
          )
        case 'timeline':
          return (
            <Box key={key} flexDirection="column" marginTop={1}>
              {b.rows.map(([when, what, detail], i) => (
                <Box key={`${key}:${i}`} flexDirection="row">
                  <Text color="claude">{i === b.rows.length - 1 ? '● ' : '○ '}</Text>
                  <Box width={12} flexShrink={0}>
                    <Text bold wrap="truncate-end">{when ?? ''}</Text>
                  </Box>
                  <Text>{what ?? ''}</Text>
                  {detail && <Text dimColor>{`  ${detail}`}</Text>}
                </Box>
              ))}
            </Box>
          )
        case 'tree':
          return (
            <Box key={key} flexDirection="column" marginTop={1}>
              {b.rows.map((r, i) => (
                <Box key={`${key}:${i}`} flexDirection="row">
                  <Text dimColor>{`${'   '.repeat(Math.max(0, r.depth - 1))}${r.depth > 0 ? '└─ ' : ''}`}</Text>
                  <Text bold={r.depth === 0 || r.hi} color={r.hi ? 'claude' : undefined}>{r.label}</Text>
                  {r.note && <Text dimColor>{`  ${r.note}`}</Text>}
                </Box>
              ))}
            </Box>
          )
        case 'limits':
          return (
            <Box key={key} flexDirection="column" marginTop={1}>
              {b.rows.map((r, i) => (
                <Box key={`${key}:${i}`} flexDirection="row" alignItems="center">
                  <Box width={16} flexShrink={0}>
                    <Text wrap="truncate-end">{r.label}</Text>
                  </Box>
                  <Box flexShrink={0} marginRight={1}>
                    <Text bold>{`${r.value !== undefined ? `${r.value.toLocaleString('en-US')} / ` : ''}${(r.max ?? 0).toLocaleString('en-US')}${r.unit ? ` ${r.unit}` : ''}`}</Text>
                  </Box>
                  {Svg && r.max !== undefined && (
                    <Box flexGrow={1} flexShrink={1}>
                      <Svg source={limitBar(r.value ?? r.max, r.max)} alt={r.label} height={6} />
                    </Box>
                  )}
                  {r.note && <Text dimColor>{`  ${r.note}`}</Text>}
                </Box>
              ))}
            </Box>
          )
        case 'decision': {
          const picked = reply.picks[String(b.n)]
          return (
            <Box key={key} flexDirection="column" borderStyle="round" borderColor={picked === undefined ? 'warning' : 'success'} paddingX={1} marginTop={1}>
              <Text bold>{`${b.n}. ${b.question}`}</Text>
              {b.options.map((o, i) => (
                <Button
                  key={`d${b.n}:${i}`}
                  plain
                  label={`${(picked ?? -1) === i ? '◉' : '○'} ${o}${i === b.fallback ? '  (proposed)' : ''}`}
                  onPress={() => setReply(r => ({ ...r, picks: { ...r.picks, [String(b.n)]: i } }))}
                />
              ))}
            </Box>
          )
        }
      }
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" alignItems="flex-start">
          <Box flexDirection="column" flexShrink={1}>
            <Text dimColor>{KIND_LABEL[page.kind]}</Text>
            <Text bold wrap="truncate-end">{page.title}</Text>
            {page.subtitle && <Text dimColor wrap="truncate-end">{page.subtitle}</Text>}
          </Box>
          <Box flexDirection="row" flexShrink={0}>
            <Button key="list" label="Pages" hotkey="p" onPress={() => update($, view, () => 'list')} />
            <Button key="open" label="Browser" hotkey="o" onPress={() => openInBrowser($, page.htmlPath)} />
          </Box>
        </Box>

        {page.lead.map((b, i) => draw(b, `lead${i}`))}

        {page.panels.map(p => {
          const isStruck = reply.struck.includes(p.id)
          return (
            <Box key={`panel:${p.id}`} flexDirection="column" borderStyle="round" borderDimColor paddingX={1} marginTop={1}>
              <Box flexDirection="row" justifyContent="space-between">
                <Box flexDirection="row" flexShrink={1}>
                  <Text inverse bold>{` ${p.id} `}</Text>
                  <Text bold strikethrough={isStruck} wrap="truncate-end">{` ${p.title}`}</Text>
                </Box>
                {p.meta && <Text dimColor>{p.meta}</Text>}
              </Box>
              {!isStruck && p.blocks.map((b, i) => draw(b, `${p.id}:${i}`))}
              {isPlan && (
                <Box flexDirection="column" marginTop={1}>
                  <Button
                    key={`strike:${p.id}`}
                    plain
                    label={isStruck ? 'Restore' : 'Strike from the plan'}
                    onPress={() => setReply(r => ({ ...r, struck: isStruck ? r.struck.filter(s => s !== p.id) : [...r.struck, p.id] }))}
                  />
                  {Input && (
                    <Input
                      key={`comment:${p.id}`}
                      placeholder="Comment on this part"
                      value={reply.comments[p.id] ?? ''}
                      onInput={v => setReply(r => ({ ...r, comments: { ...r.comments, [p.id]: v } }))}
                      onSubmit={v => setReply(r => ({ ...r, comments: { ...r.comments, [p.id]: v } }))}
                    />
                  )}
                </Box>
              )}
            </Box>
          )
        })}

        {isPlan && (
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" marginTop={1}>
            <Text color={answered === decisions.length ? 'success' : 'warning'}>{`${answered} of ${decisions.length} decisions answered`}</Text>
            <Button
              key="respond"
              label="Respond"
              variant="primary"
              hotkey="r"
              onPress={async () => {
                const latest = (await read($, replies))[page.id] ?? EMPTY_ANSWERS
                const filled = await $.prompt.fill({ text: responseOf(page, latest), mode: 'replace' })
                $.ui.toast(filled.isFilled ? 'Response is in the prompt box. Read it, then press Enter to send.' : 'Could not reach the prompt box; close the dialog and press Respond again.')
              }}
            />
          </Box>
        )}
      </Box>
    )
  })
}
