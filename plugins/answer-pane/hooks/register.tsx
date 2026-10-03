import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AnswerPage, AnswerView } from '../types'
import { diagramStyle, extractSvgs, frontmatter, partsOf, renderedPath, slug, standaloneSvg } from './page'

// Claude writes a short Markdown draft; answer-me-with-html's own renderer
// (vendored, MIT, by its contributors) builds the page; the pane shows it
// inside Claude Code, diagrams included, with the full page a click away.
// No model calls: the draft is Claude's answer, the rest is local.

const PANE = 'answer-pane'
const TOOL = 'mcp__answer-pane__show_page'
const KEEP = 30
const MAX_ERROR = 1_500

const pages = atom({ plugin: 'answer-pane', key: 'pages' } as const, [] as AnswerPage[])
const currentId = atom({ plugin: 'answer-pane', key: 'currentId' } as const, null as string | null)
const view = atom({ plugin: 'answer-pane', key: 'view' } as const, 'page' as AnswerView)

// Kept short: it rides along with every request so Claude knows when to use it.
// The renderer's own error messages teach the rest, with a corrected example.
const DESCRIPTION = [
  'Show an explanation as a visual page in a pane beside the chat. Use it when an answer has 3+ linked concepts, a process or protocol (branches, several parties), a comparison over 3+ dimensions, a hierarchy, or stages over time, or when the user asks to explain visually. Not for short answers, commands to copy, or plain code edits.',
  'Write content only, as Markdown: `---` frontmatter with `title:` (optional `subtitle:`), one-line lead, then 3-8 panels as `## A Panel title`, each answering one sub-question. Inside panels use paragraphs, lists, tables (cells may start with ok / no / warn) and fenced blocks:',
  '```flow LR` lines `A -> B: label` (`-->` dashed, `(Round)` node, `*Highlight` node); ```sequence` with `participants: A, B` then `A -> B: message` and `note A: text`; ```callout warn|note|tip Title` then text; ```tree` indented lines; ```timeline` lines `when | what`; ```limits` lines `label | value / max | unit`; ```kv` lines `key | value`.',
  'No HTML, CSS or coordinates. If the result reports an error, fix that line as its example shows and call again. Then reply in 2-3 lines: the conclusion, and that the page is in the pane.',
].join('\n')

const join = (...parts: string[]) => parts.map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p)).join('/')

async function pagesDir($: EngineInterface): Promise<string | undefined> {
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  const base = config ?? (home === undefined ? undefined : join(home, '.claude'))
  return base === undefined ? undefined : join(base, 'answer-pane')
}

// Opens a file with the system's own handler: the default browser for .html.
async function openInBrowser($: EngineInterface, path: string) {
  const isWindows = /^[a-z]:[\\/]/i.test(path)
  const argv = isWindows ? ['cmd', '/c', 'start', '', path] : [(await $.env.get('XDG_CURRENT_DESKTOP')) ? 'xdg-open' : 'open', path]
  await $.process.run(argv).catch(() => undefined)
}

async function render($: EngineInterface, draft: string): Promise<{ page?: AnswerPage; error?: string }> {
  const dir = await pagesDir($)
  if (dir === undefined) return { error: 'answer-pane could not find a folder to write the page to.' }
  const { meta, body } = frontmatter(draft)
  const title = meta.title || 'Answer'
  const at = await $.clock.now()
  const id = `${at}-${slug(title)}`
  const draftPath = join(dir, `${id}.md`)
  const htmlPath = join(dir, `${id}.html`)
  await $.fs.write(draftPath, draft)

  const ran = await $.process
    .run(['node', join($.plugin.root, 'vendor', 'am.mjs'), 'render', draftPath, '-o', htmlPath, '--no-open', '--style', 'off'])
    .catch((e: unknown) => ({ exitCode: 1, stdout: '', stderr: e instanceof Error ? e.message : String(e) }))
  const output = `${ran.stdout}\n${ran.stderr}`.trim()
  const done = renderedPath(ran.stdout)
  if (ran.exitCode !== 0 || done === undefined) {
    const hint = /ENOENT|not recognized|not found/i.test(output) && !/✗/.test(output) ? ' (Node.js 20+ must be installed)' : ''
    return { error: `The page did not render${hint}. Fix the draft and call show_page again:\n${output.slice(0, MAX_ERROR)}` }
  }

  const html = await $.fs.read(htmlPath)
  const style = diagramStyle(html, meta.theme || 'blueprint')
  const svgs = extractSvgs(html).map(s => ({ ...s, svg: standaloneSvg(s.svg, style) }))
  return { page: { id, title, subtitle: meta.subtitle, htmlPath, at, parts: partsOf(body, svgs) } }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'show_page',
      description: DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: { markdown: { type: 'string', description: 'The page draft: frontmatter, lead, then ## panels.' } },
        required: ['markdown'],
      },
    })
    await $.command.register({ name: 'pages', description: 'Answer pane: /pages lists the pages of this session · /pages auto on|off' })
    return next(e)
  })

  // Auto (the default): listed in front, so Claude can choose a page on its own;
  // measured at +1,319 prompt tokens per request. Off: on demand through
  // ToolSearch, +781, used when you ask for a page. Read once per session.
  on('tool.describe', { tool: TOOL }, async ($, e, next) => {
    const described = await next(e)
    const isAuto = ((await $.store.get('auto')) as boolean | undefined) ?? true
    return { ...described, isDeferred: !isAuto }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const draft = (e as { markdown?: unknown }).markdown
    if (typeof draft !== 'string' || draft.trim() === '') return { deny: 'show_page needs markdown: the page draft.' }

    const { page, error } = await render($, draft)
    if (!page) return { result: error }

    await update($, pages, list => [page, ...list].slice(0, KEEP))
    await update($, currentId, () => page.id)
    await update($, view, () => 'page')
    await $.ui.open({ id: PANE, title: page.title })
    return { result: `Shown in the answer pane: "${page.title}". Full page: ${page.htmlPath}` }
  })

  // Answered with no text, so the command adds nothing to the conversation.
  on('command.run', { command: 'pages' }, async ($, e) => {
    const [a, b] = e.args.trim().toLowerCase().split(/\s+/)
    if (a === 'auto' && (b === 'on' || b === 'off')) {
      await $.store.set('auto', b === 'on')
      $.ui.toast(
        b === 'on'
          ? 'Answer pane: Claude can choose a page on its own, from the next session.'
          : 'Answer pane: pages on request only, from the next session. Ask for a visual page when you want one.',
      )
      return {}
    }
    await update($, view, () => 'list')
    await $.ui.open({ id: PANE, title: 'Pages' })
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const Svg = e.surface === 'terminal' || e.surface === 'mobile' ? undefined : $.ui.resolve(e).Svg
    const list = await read($, pages)
    const id = await read($, currentId)
    const mode = await read($, view)
    const page = list.find(p => p.id === id) ?? list[0]

    if (mode === 'list' || !page) {
      return (
        <Box flexDirection="column">
          <Text bold>{'Pages this session'}</Text>
          {list.length === 0 && <Text dimColor>{'No pages yet. Ask Claude to explain something visually.'}</Text>}
          {list.map((p, i) => (
            <Button
              key={`p:${p.id}`}
              plain
              label={`${p.title}`}
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

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" alignItems="flex-start">
          <Box flexDirection="column" flexShrink={1}>
            <Text bold wrap="truncate-end">{page.title}</Text>
            {page.subtitle && <Text dimColor wrap="truncate-end">{page.subtitle}</Text>}
          </Box>
          <Box flexDirection="row">
            <Button key="open" label="Open in browser" hotkey="o" onPress={() => openInBrowser($, page.htmlPath)} />
            <Button key="list" label="Pages" hotkey="p" onPress={() => update($, view, () => 'list')} />
          </Box>
        </Box>
        {page.parts.map((part, i) =>
          part.kind === 'md' ? (
            <Markdown key={`m${i}`} text={part.text} />
          ) : Svg ? (
            <Box key={`s${i}`} marginTop={1} marginBottom={1}>
              <Svg source={part.svg} alt={part.label} />
            </Box>
          ) : (
            <Text key={`s${i}`} dimColor>{`[diagram: ${part.label}. Press o to open the full page]`}</Text>
          ),
        )}
      </Box>
    )
  })
}
