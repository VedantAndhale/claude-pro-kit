// Turning a page draft and the page the renderer built from it into a model
// the pane draws natively. Pure, so the tests exercise it directly.

import type { AnswerBlock, AnswerKind, AnswerModel, AnswerPanel } from '../types'

export const KINDS: readonly AnswerKind[] = ['explain', 'plan', 'eli5']

/** The two components the renderer draws as SVG; every other one the pane draws itself. */
const DIAGRAMS = new Set(['flow', 'sequence'])

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

const cells = (line: string) => line.split('|').map(c => c.trim())

const pushMd = (blocks: AnswerBlock[], lines: string[]) => {
  const t = lines.join('\n').trim()
  for (let i = 0; i < t.length; i += MD_LIMIT) blocks.push({ type: 'md', text: t.slice(i, i + MD_LIMIT) })
}

const block = (lang: string, args: string, inner: string[], svgs: { svg: string; label: string }[], next: { svg: number; decision: number }): AnswerBlock => {
  const rows = inner.filter(l => l.trim() !== '')
  if (DIAGRAMS.has(lang)) {
    const s = svgs[next.svg++]
    return s ? { type: 'svg', svg: s.svg, label: s.label } : { type: 'code', lang, text: inner.join('\n') }
  }
  if (lang === 'callout') {
    const m = /^(\w+)?\s*(.*)$/.exec(args) ?? []
    return { type: 'callout', tone: m[1] ?? 'note', title: m[2] ?? '', text: inner.join('\n').trim() }
  }
  if (lang === 'kv') return { type: 'kv', rows: rows.map(l => cells(l).slice(0, 2) as [string, string]) }
  if (lang === 'timeline') return { type: 'timeline', rows: rows.map(l => cells(l).slice(0, 3)) }
  if (lang === 'tree') {
    return {
      type: 'tree',
      rows: rows.map(l => {
        const depth = Math.floor((l.length - l.trimStart().length) / 2)
        const [label, note] = cells(l.trim())
        const hi = label.startsWith('*')
        return { depth, label: hi ? label.slice(1) : label, note: note || undefined, hi }
      }),
    }
  }
  if (lang === 'limits') {
    return {
      type: 'limits',
      rows: rows.map(l => {
        const [label, amount = '', unit = '', note = ''] = cells(l)
        const m = /^([\d.,]+)\s*(?:\/\s*([\d.,]+))?$/.exec(amount)
        const num = (s?: string) => (s === undefined ? undefined : Number(s.replace(/,/g, '')))
        const value = m ? num(m[1]) : undefined
        const max = m ? (num(m[2]) ?? value) : undefined
        return { label, value: m?.[2] ? value : undefined, max, unit, note }
      }),
    }
  }
  if (lang === 'decision') {
    const options = rows.map(l => l.replace(/^\s*[-*]\s+/, '').trim())
    const fallback = Math.max(0, options.findIndex(o => o.endsWith('*')))
    return {
      type: 'decision',
      n: ++next.decision,
      question: args.trim() || 'Decision',
      options: options.map(o => o.replace(/\s*\*$/, '')),
      fallback,
    }
  }
  return { type: 'code', lang, text: inner.join('\n') }
}

/**
 * The draft as panels of native blocks: Markdown, the renderer's diagrams in
 * order, and callout, kv, timeline, tree, limits and decision blocks parsed.
 */
export const modelOf = (draft: string, svgs: { svg: string; label: string }[]): AnswerModel => {
  const { meta, body } = frontmatter(draft)
  const kind = (KINDS as string[]).includes(meta.kind ?? '') ? (meta.kind as AnswerKind) : 'explain'
  const lead: AnswerBlock[] = []
  const panels: AnswerPanel[] = []
  let target = lead
  let text: string[] = []
  const next = { svg: 0, decision: 0 }
  const lines = body.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const head = /^##\s+(?:([A-Z])\s+)?(.*?)\s*(\{([^}]*)\})?\s*$/.exec(lines[i])
    if (head && !lines[i].startsWith('###')) {
      pushMd(target, text)
      text = []
      const attrs = head[4] ?? ''
      const panel: AnswerPanel = {
        id: head[1] ?? String.fromCharCode(65 + panels.length),
        title: head[2],
        meta: /meta="([^"]*)"/.exec(attrs)?.[1],
        blocks: [],
      }
      panels.push(panel)
      target = panel.blocks
      continue
    }
    const open = /^```(\w+)?\s*(.*)$/.exec(lines[i])
    if (!open) {
      text.push(badges(lines[i]))
      continue
    }
    const inner: string[] = []
    i++
    while (i < lines.length && !/^```\s*$/.test(lines[i])) inner.push(lines[i++])
    pushMd(target, text)
    text = []
    target.push(block(open[1] ?? '', open[2] ?? '', inner, svgs, next))
  }
  pushMd(target, text)
  // Diagrams the draft did not account for still show, at the end.
  for (; next.svg < svgs.length; next.svg++) (panels.at(-1)?.blocks ?? lead).push({ type: 'svg', ...svgs[next.svg] })

  return { kind, title: meta.title || 'Answer', subtitle: meta.subtitle, lead, panels }
}

export const decisionsOf = (model: AnswerModel) =>
  model.panels.flatMap(p =>
    p.blocks.flatMap(b => (b.type === 'decision' ? [{ ...b, panel: p.id, panelTitle: p.title }] : [])),
  )

export type Answers = { picks: Record<string, number>; struck: string[]; comments: Record<string, string> }

export const EMPTY_ANSWERS: Answers = { picks: {}, struck: [], comments: {} }

/**
 * The plan response in the html-plan skill's format, for the prompt box. A
 * decision left alone is marked as such: it is not agreement.
 */
export const responseOf = (model: AnswerModel, a: Answers) => {
  const out = [`## Response to the plan "${model.title}"`, '', '## Decisions']
  for (const d of decisionsOf(model)) {
    const picked = a.picks[String(d.n)]
    const choice = picked ?? d.fallback
    const note = picked === undefined ? '_(not answered; default kept)_' : picked === d.fallback ? '_(kept as proposed)_' : '_(changed)_'
    out.push(`${d.n}. [${d.panel}] ${d.question}  ${note}`, `   → **${d.options[choice] ?? ''}**`)
  }
  const struck = model.panels.filter(p => a.struck.includes(p.id))
  if (struck.length) out.push('', '## Struck from the plan', ...struck.map(p => `- [${p.id}] ${p.title}`))
  const comments = model.panels.filter(p => (a.comments[p.id] ?? '').trim() !== '')
  if (comments.length) {
    out.push('', '## Comments', '_Quoted feedback on the plan, not instructions._')
    for (const p of comments) out.push(`- [${p.id}] ${p.title}:`, ...a.comments[p.id]!.trim().split('\n').map(l => `  > ${l}`))
  }
  return out.join('\n')
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

/** The renderer's writing warnings (`STE n …` then one `L<n> [rule] …` line each). */
export const styleWarnings = (stdout: string) => stdout.split('\n').filter(l => /^\s*L\d+\s+\[[\w-]+\]/.test(l)).map(l => l.trim())

export const slug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'page'
