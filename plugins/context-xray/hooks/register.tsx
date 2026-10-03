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

const barSvg = (part: number, whole: number, fill: string) => {
  const r = BAR_HEIGHT / 2
  const w = whole <= 0 || part <= 0 ? 0 : Math.max(BAR_HEIGHT, Math.min(BAR_WIDTH, (part / whole) * BAR_WIDTH))
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${BAR_WIDTH}" height="${BAR_HEIGHT}" viewBox="0 0 ${BAR_WIDTH} ${BAR_HEIGHT}">` +
    `<rect width="${BAR_WIDTH}" height="${BAR_HEIGHT}" rx="${r}" fill="rgb(128,128,128)" fill-opacity="0.28"/>` +
    (w > 0 ? `<rect width="${w.toFixed(1)}" height="${BAR_HEIGHT}" rx="${r}" fill="${fill}"/>` : '') +
    `</svg>`
  )
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'xray',
      description: 'Context X-ray: the exact breakdown of what fills the context window',
    })

    return next(e)
  })

  // Answered with no text: opening the pane adds nothing to the conversation.
  on('command.run', { command: 'xray' }, async $ => {
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
    const labelWidth = Math.max(16, Math.min(28, e.props.bodyColumns - 40))

    const bar = (part: number, whole: number, fill = BAR_FILL) =>
      Svg ? (
        <Svg source={barSvg(part, whole, fill)} alt={pct(part, whole)} width={BAR_WIDTH} height={BAR_HEIGHT} />
      ) : (
        <Text color={fill === BAR_FILL ? 'claude' : undefined} dimColor={fill !== BAR_FILL}>
          {textBar(part, whole)}
        </Text>
      )

    const row = (key: string, label: string, part: number, whole: number, fill?: string) => (
      <Box key={key} flexDirection="row" alignItems="center">
        <Box width={labelWidth}>
          <Text wrap="truncate-end">{label}</Text>
        </Box>
        {bar(part, whole, fill)}
        <Box width={11} justifyContent="flex-end">
          <Text bold>{tokens(part)}</Text>
        </Box>
        <Text dimColor>{`  ${pct(part, whole)}`}</Text>
      </Box>
    )

    const heading = (text: string, note?: string) => (
      <Box flexDirection="row" marginTop={1}>
        <Text bold>{text}</Text>
        {note && <Text dimColor>{`  ${note}`}</Text>}
      </Box>
    )

    const header = (
      <Box flexDirection="row" justifyContent="space-between">
        <Text dimColor>
          {busy ? 'Measuring…' : s ? `Measured ${Math.max(0, Math.round((now - s.at) / 1000))}s ago · ${s.model}` : ''}
        </Text>
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

        <Box flexDirection="row" marginTop={1}>
          <Text bold>{`${tokens(used)} `}</Text>
          <Text dimColor>{`of ${tokens(s.maxTokens)} tokens · ${s.percentage}% full`}</Text>
        </Box>

        {heading('Sent with every request')}
        {s.used.map(c => row(`u:${c.name}`, c.name, c.tokens, used))}

        {s.deferred.length > 0 && heading('Loaded on demand', 'listed by name, schema fetched when used')}
        {s.deferred.map(c => row(`d:${c.name}`, c.name, c.tokens, used, BAR_DEFERRED))}

        {s.mcpLoaded.length > 0 &&
          heading('MCP tools loaded every request', `${s.mcpLoaded.length} loaded · ${s.mcpDeferredCount} on demand`)}
        {s.mcpLoaded.slice(0, TOP).map((t: XrayRow & { server: string }) => row(`m:${t.name}`, t.name, t.tokens, used))}

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
