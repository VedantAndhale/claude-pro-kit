// Turning an answer-me-with-html draft and the page its renderer built into
// what the pane draws. Pure, so the tests exercise it directly.

export type Part = { kind: 'md'; text: string } | { kind: 'svg'; svg: string; label: string }

export type Page = {
  id: string
  title: string
  subtitle?: string
  htmlPath: string
  at: number
  parts: Part[]
}

/** The two components the renderer draws as SVG; every other one is HTML. */
const DIAGRAMS = new Set(['flow', 'sequence'])

/** Components the renderer knows; the pane shows the non-diagram ones as text. */
const COMPONENTS = new Set(['flow', 'sequence', 'callout', 'kv', 'timeline', 'annot', 'tree', 'limits'])

/** A Markdown element holds at most 10,000 characters. */
const MD_LIMIT = 9_000

export const frontmatter = (draft: string): { meta: Record<string, string>; body: string } => {
  const text = draft.replace(/\r\n/g, '\n')
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  if (!m) return { meta: {}, body: text }
  const meta: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const kv = /^([\w-]+):\s*(.*?)\s*(#.*)?$/.exec(line)
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '')
  }
  return { meta, body: text.slice(m[0].length) }
}

const STATUS: Record<string, string> = { ok: '✓', no: '✗', warn: '!' }

/** Table cells that start with ok / no / warn get the renderer's badge glyphs. */
const badges = (line: string) =>
  line.startsWith('|') ? line.replace(/\|\s*(ok|no|warn)\b/g, (_, w: string) => `| ${STATUS[w]}`) : line

/** `## A Title {span=2 meta="x"}` keeps its letter and title, not the layout braces. */
const heading = (line: string) => line.replace(/^(#{1,6}\s+.*?)\s*\{[^}]*\}\s*$/, '$1')

const push = (parts: Part[], text: string) => {
  const t = text.trim()
  if (!t) return
  for (let i = 0; i < t.length; i += MD_LIMIT) parts.push({ kind: 'md', text: t.slice(i, i + MD_LIMIT) })
}

/** The draft's body as pane parts, each flow/sequence block replaced by its rendered SVG in order. */
export const partsOf = (body: string, svgs: { svg: string; label: string }[]): Part[] => {
  const parts: Part[] = []
  const lines = body.split('\n')
  let buffer: string[] = []
  let next = 0

  for (let i = 0; i < lines.length; i++) {
    const open = /^```(\w+)?\s*(.*)$/.exec(lines[i])
    if (!open) {
      buffer.push(badges(heading(lines[i])))
      continue
    }
    const lang = open[1] ?? ''
    const args = open[2] ?? ''
    const inner: string[] = []
    i++
    while (i < lines.length && !/^```\s*$/.test(lines[i])) inner.push(lines[i++])

    if (DIAGRAMS.has(lang) && next < svgs.length) {
      push(parts, buffer.join('\n'))
      buffer = []
      parts.push({ kind: 'svg', ...svgs[next++] })
    } else if (lang === 'callout') {
      const [, kind = 'note', title = ''] = /^(\w+)?\s*(.*)$/.exec(args) ?? []
      const head = title ? `**${title}**` : `**${kind}**`
      buffer.push('', ...[head, ...inner].map(l => `> ${l}`), '')
    } else if (COMPONENTS.has(lang)) {
      buffer.push('```', ...inner, '```')
    } else {
      buffer.push(`\`\`\`${lang}${args ? ` ${args}` : ''}`, ...inner, '```')
    }
  }
  push(parts, buffer.join('\n'))
  // Diagrams the draft did not account for still show, after the text.
  for (; next < svgs.length; next++) parts.push({ kind: 'svg', ...svgs[next] })
  return parts
}

/** The `<svg>` elements of the page body, with their accessible labels. */
export const extractSvgs = (html: string) => {
  const body = html.split(/<body[^>]*>/)[1] ?? html
  return (body.match(/<svg[\s\S]*?<\/svg>/g) ?? []).map(svg => ({
    svg,
    label: /aria-label="([^"]*)"/.exec(svg)?.[1] ?? 'diagram',
  }))
}

type Rule = { sel: string; body: string }

/** Top-level CSS rules, with @media blocks left out. */
const topRules = (css: string): Rule[] => {
  const rules: Rule[] = []
  let i = 0
  while (i < css.length) {
    const open = css.indexOf('{', i)
    if (open < 0) break
    const sel = css.slice(i, open).trim()
    if (sel.startsWith('@')) {
      let depth = 1
      let j = open + 1
      while (j < css.length && depth > 0) {
        if (css[j] === '{') depth++
        else if (css[j] === '}') depth--
        j++
      }
      i = j
      continue
    }
    const close = css.indexOf('}', open)
    if (close < 0) break
    rules.push({ sel, body: css.slice(open + 1, close).trim() })
    i = close + 1
  }
  return rules
}

/**
 * The page's own styles for its diagrams, rewritten to work inside a lone SVG:
 * the theme's light and dark variables on the svg element, and the diagram rules.
 */
export const diagramStyle = (html: string, theme = 'blueprint') => {
  const css = /<style[^>]*>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? ''
  const rules = topRules(css)
  const vars = (dark: boolean) =>
    rules.find(r =>
      dark
        ? r.sel === `html[data-theme="${theme}"][data-mode="dark"]`
        : r.sel.startsWith(`html[data-theme="${theme}"]`) && !r.sel.includes('dark') && !r.sel.includes(' .') && r.body.includes('--'),
    )?.body ?? ''
  const diagramRules = rules
    .filter(r => r.sel.includes('.am-') && !r.sel.includes('html['))
    .filter(r => /am-(diagram|node|edge|arrow|lifeline|actor|note|step|cluster|msg|seq|flow)/.test(r.sel))
    .map(r => `${r.sel.replace(/\.am-diagram svg/g, 'svg').replace(/\.am-diagram\s+/g, 'svg ').replace(/^\.am-diagram$/, 'svg')}{${r.body}}`)
    .join('')
  const light = vars(false)
  const dark = vars(true)
  return (
    `svg{${light}}` +
    (dark ? `@media (prefers-color-scheme: dark){svg{${dark}}}` : '') +
    `svg{font-family:var(--font-sans)}svg text{fill:var(--ink);font-size:13px}` +
    diagramRules
  )
}

/** One diagram as a self-contained SVG: its styles inside it, on the page's paper colour. */
export const standaloneSvg = (svg: string, style: string) => {
  const end = svg.indexOf('>')
  return `${svg.slice(0, end + 1)}<style>${style}</style><rect width="100%" height="100%" fill="var(--paper)"/>${svg.slice(end + 1)}`
}

/** The renderer prints `✓ <path>` on success, and `✗ L<line> …` with a fix example on errors. */
export const renderedPath = (stdout: string) => /^✓\s+(.+)$/m.exec(stdout)?.[1]?.trim()

export const slug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'page'
