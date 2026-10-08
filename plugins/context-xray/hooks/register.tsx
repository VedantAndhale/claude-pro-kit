import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextBreakdown } from 'claude-code'

import type { XrayRow, XraySnapshot } from '../types'

// The exact breakdown /context computes: one token-count request per tool and
// memory file, so it runs when the pane opens or Refresh is pressed, never in
// the background. Nothing it shows is estimated.

const PANE = 'context-xray'
const TOP = 10

const snapshot = atom({ plugin: 'context-xray', key: 'snapshot' } as const, null as XraySnapshot | null)
const isMeasuring = atom({ plugin: 'context-xray', key: 'isMeasuring' } as const, false)
const error = atom({ plugin: 'context-xray', key: 'error' } as const, null as string | null)

const BAR_FILL = '#D97757'
const BAR_DEFERRED = '#8B8B8B'
const BAR_WIDTH = 140
const BAR_HEIGHT = 6

const tokens = (n: number) => n.toLocaleString('en-US')
const pct = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '0%')
const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path
const byTokens = <T extends { tokens: number }>(rows: T[]) => [...rows].sort((a, b) => b.tokens - a.tokens)

// The markup is wider than any pane and stretches without keeping its aspect,
// so the bar takes whatever width its slot has left and never pushes the
// figures beside it out of view.
const barSvg = (part: number, whole: number, fill: string) => {
  const w = whole <= 0 || part <= 0 ? 0 : Math.max(1.5, Math.min(BAR_WIDTH, (part / whole) * BAR_WIDTH))
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="${BAR_HEIGHT}" viewBox="0 0 ${BAR_WIDTH} ${BAR_HEIGHT}" preserveAspectRatio="none">` +
    `<rect width="${BAR_WIDTH}" height="${BAR_HEIGHT}" fill="rgb(128,128,128)" fill-opacity="0.28"/>` +
    (w > 0 ? `<rect width="${w.toFixed(2)}" height="${BAR_HEIGHT}" fill="${fill}"/>` : '') +
    `</svg>`
  )
}

const shortTool = (name: string, server: string) => {
  const tool = name.startsWith('mcp__') ? name.split('__').slice(2).join('__') || name : name
  return `${server} · ${tool}`
}

const textBar = (part: number, whole: number, cells = 16) => {
  const n = whole <= 0 ? 0 : Math.max(part > 0 ? 1 : 0, Math.round((part / whole) * cells))
  return '━'.repeat(Math.min(cells, n)) + '─'.repeat(Math.max(0, cells - n))
}

export const toSnapshot = (b: SessionContextBreakdown, at: number): XraySnapshot => {
  const rows = (kind: string) =>
    byTokens(b.categories.filter(c => c.kind === kind).map(c => ({ name: c.name, tokens: c.tokens })))
  const sum = (kind: string) => b.categories.filter(c => c.kind === kind).reduce((n, c) => n + c.tokens, 0)

  return {
    at,
    model: b.model,
    totalTokens: b.totalTokens,
    maxTokens: b.rawMaxTokens,
    percentage: b.percentage,
    used: rows('used'),
    deferred: rows('deferred'),
    free: sum('free'),
    buffer: sum('buffer'),
    mcpLoaded: byTokens(b.mcpTools.filter(t => t.isLoaded).map(t => ({ name: t.name, server: t.serverName, tokens: t.tokens }))),
    mcpDeferredCount: b.mcpTools.filter(t => !t.isLoaded).length,
    memoryFiles: byTokens(b.memoryFiles.map(f => ({ name: f.path, type: f.type, tokens: f.tokens }))),
    skills: b.skills && { tokens: b.skills.tokens, included: b.skills.includedSkills, total: b.skills.totalSkills },
    commands: b.slashCommands && {
      tokens: b.slashCommands.tokens,
      included: b.slashCommands.includedCommands,
      total: b.slashCommands.totalCommands,
    },
    agents: byTokens(b.agents.map(a => ({ name: a.agentType, tokens: a.tokens }))),
  }
}

async function measure($: EngineInterface) {
  if (await read($, isMeasuring)) return
  await update($, isMeasuring, () => true)
  try {
    const usage = await $.session.usage({ breakdown: 'full' })
    const b = usage.context.breakdown
    if (!b) throw new Error('no breakdown: the session has no context to measure yet')
    const at = await $.clock.now()
    await update($, snapshot, () => toSnapshot(b, at))
    await update($, error, () => null)
  } catch (e) {
    await update($, error, () => (e instanceof Error ? e.message : String(e)))
  } finally {
    await update($, isMeasuring, () => false)
  }
}

/** Context fills at which the pane opens by itself, once per crossing. */
export const MARKS = [60, 80]

/** The marks crossed between two readings, highest first. */
export const crossedMarks = (before: number | undefined, now: number) =>
  MARKS.filter(m => (before ?? 0) < m && now >= m).reverse()

let lastPct: number | undefined

export const register: Register = on => {
  // Opens itself when the context crosses 60% and 80%: that is when trimming it pays.
  on('session.measure', async ($, e, next) => {
    const pct = e.context.percent
    if (pct !== undefined) {
      const hit = crossedMarks(lastPct, pct)[0]
      lastPct = pct
      const isAuto = ((await $.store.get('auto')) as boolean | undefined) ?? true
      if (hit !== undefined && isAuto) {
        await $.ui.open({ id: PANE, title: `Context X-ray · ${pct}% full` })
        void measure($)
        $.ui.toast(`Context is ${pct}% full. The X-ray pane shows what fills it; /compact or a handoff (/handoff) shrinks it.`)
      }
    }
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'xray',
      description: 'Context X-ray: the exact breakdown of what fills the context window · /xray auto on|off',
    })

    return next(e)
  })

  // Answered with no text: opening the pane adds nothing to the conversation.
  on('command.run', { command: 'xray' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'auto on' || arg === 'auto off') {
      await $.store.set('auto', arg === 'auto on')
      $.ui.toast(arg === 'auto on' ? 'Context X-ray opens by itself at 60% and 80% context.' : 'Context X-ray opens only with /xray.')
      return {}
    }
    await $.ui.open({ id: PANE, title: 'Context X-ray' })
    void measure($)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = await read($, snapshot)
    const busy = await read($, isMeasuring)
    const failed = await read($, error)
    const now = await $.clock.now()
    const svg = e.surface !== 'terminal' && e.surface !== 'mobile'
    const Svg = svg ? $.ui.resolve(e).Svg : undefined

    // Columns sized to the pane: label, figure, share, then the bar in what is
    // left, so a narrow pane shrinks the bar and never cuts a figure.
    const cols = e.props.bodyColumns
    const NUM = 10
    const PCT = 7
    const labelWidth = Math.max(10, Math.min(26, Math.floor(cols * 0.42)))
    const barCells = cols - labelWidth - NUM - PCT - 1

    const bar = (part: number, whole: number, fill = BAR_FILL) => {
      if (barCells < 4) return null
      return Svg ? (
        <Box flexGrow={1} flexShrink={1} marginLeft={1}>
          <Svg source={barSvg(part, whole, fill)} alt={pct(part, whole)} height={BAR_HEIGHT} />
        </Box>
      ) : (
        <Box marginLeft={1}>
          <Text color={fill === BAR_FILL ? 'claude' : undefined} dimColor={fill !== BAR_FILL}>
            {textBar(part, whole, Math.min(20, barCells))}
          </Text>
        </Box>
      )
    }

    const row = (key: string, label: string, part: number, whole: number, fill?: string) => (
      <Box key={key} flexDirection="row" alignItems="center">
        <Box width={labelWidth} flexShrink={0}>
          <Text wrap="truncate-end">{label}</Text>
        </Box>
        <Box width={NUM} flexShrink={0} justifyContent="flex-end">
          <Text bold>{tokens(part)}</Text>
        </Box>
        <Box width={PCT} flexShrink={0} justifyContent="flex-end">
          <Text dimColor>{pct(part, whole)}</Text>
        </Box>
        {bar(part, whole, fill)}
      </Box>
    )

    const heading = (text: string, note?: string) => (
      <Box flexDirection="column" marginTop={1}>
        <Text bold wrap="truncate-end">{text}</Text>
        {note && <Text dimColor wrap="truncate-end">{note}</Text>}
      </Box>
    )

    const header = (
      <Box flexDirection="row" justifyContent="space-between" alignItems="flex-start">
        <Box flexDirection="column" flexShrink={1}>
          <Text dimColor wrap="truncate-end">
            {busy ? 'Measuring…' : s ? `Measured ${Math.max(0, Math.round((now - s.at) / 1000))}s ago` : ''}
          </Text>
          {s && <Text dimColor wrap="truncate-end">{s.model}</Text>}
        </Box>
        <Button key="refresh" label="Refresh" hotkey="r" onPress={() => measure($)} />
      </Box>
    )

    if (!s) {
      return (
        <Box flexDirection="column">
          {header}
          <Text dimColor>{failed ?? 'Measuring the context window…'}</Text>
        </Box>
      )
    }

    const used = s.totalTokens
    return (
      <Box flexDirection="column">
        {header}
        {failed && <Text color="error">{failed}</Text>}

        <Box flexDirection="row" flexWrap="wrap" marginTop={1}>
          <Text bold>{`${tokens(used)} `}</Text>
          <Text dimColor>{`of ${tokens(s.maxTokens)} tokens`}</Text>
          <Text dimColor>{` · ${s.percentage}% full`}</Text>
        </Box>

        {heading('Sent with every request')}
        {s.used.map(c => row(`u:${c.name}`, c.name, c.tokens, used))}

        {s.deferred.length > 0 && heading('Loaded on demand', 'listed by name, schema fetched when used')}
        {s.deferred.map(c => row(`d:${c.name}`, c.name, c.tokens, used, BAR_DEFERRED))}

        {s.mcpLoaded.length > 0 &&
          heading('MCP tools loaded every request', `${s.mcpLoaded.length} loaded · ${s.mcpDeferredCount} on demand`)}
        {s.mcpLoaded.slice(0, TOP).map((t: XrayRow & { server: string }) => row(`m:${t.name}`, shortTool(t.name, t.server), t.tokens, used))}

        {s.memoryFiles.length > 0 && heading('Memory files')}
        {s.memoryFiles.map(f => row(`f:${f.name}`, baseName(f.name), f.tokens, used))}

        {(s.skills || s.commands || s.agents.length > 0) && heading('Listings')}
        {s.skills && row('skills', `Skills (${s.skills.included}/${s.skills.total})`, s.skills.tokens, used)}
        {s.commands && row('commands', `Commands (${s.commands.included}/${s.commands.total})`, s.commands.tokens, used)}
        {s.agents.slice(0, TOP).map(a => row(`a:${a.name}`, `Agent: ${a.name}`, a.tokens, used))}

        <Box flexDirection="row" marginTop={1}>
          <Text dimColor>{`Free ${tokens(s.free)} · compaction buffer ${tokens(s.buffer)}`}</Text>
        </Box>
      </Box>
    )
  })
}
