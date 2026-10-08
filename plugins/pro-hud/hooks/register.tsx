import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { HudContext, HudLimit, HudPrefs, HudTurn } from '../types'

// Desktop app only, and only figures the engine reports or the mod measures
// itself: no estimates, no forecasts, no model calls. The band updates live:
// per tool call, per model request, a 1s clock while a turn runs and a 60s
// clock while idle (for the reset countdowns).

const limits = atom({ plugin: 'pro-hud', key: 'limits' } as const, [] as HudLimit[])
const context = atom({ plugin: 'pro-hud', key: 'context' } as const, {} as HudContext)
const turn = atom({ plugin: 'pro-hud', key: 'turn' } as const, null as HudTurn | null)
const now = atom({ plugin: 'pro-hud', key: 'now' } as const, 0)
const prefs = atom({ plugin: 'pro-hud', key: 'prefs' } as const, {
  band: true,
  spinner: true,
  cards: true,
} as HudPrefs)

const CARD_CACHE = 300
const COMPACT_AT = 80
const WIDE = 110
const LIVE_MS = 1_000
const IDLE_MS = 60_000

// Text uses the app's theme keys. The bars are drawn as SVG, in colors chosen
// to read on the light and the dark theme alike.
const WARN = 'warning'
const CRITICAL = 'error'
const OK = 'success'
const BAR_FILL = '#D97757'
const BAR_WARN = '#E0A23A'
const BAR_CRITICAL = '#E5534B'
const BAR_WIDTH = 120
const BAR_HEIGHT = 6

const LABEL: Record<string, string> = { five_hour: 'Session', seven_day: 'Week', spend_limit: 'Spend' }

const EDITS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit']

const barColor = (pct: number) => (pct >= 95 ? BAR_CRITICAL : pct >= 80 ? BAR_WARN : BAR_FILL)
const textTone = (pct: number) => (pct >= 95 ? CRITICAL : pct >= 80 ? WARN : undefined)

const barSvg = (pct: number) => {
  const r = BAR_HEIGHT / 2
  const fill = pct <= 0 ? 0 : Math.max(BAR_HEIGHT, Math.min(BAR_WIDTH, (pct / 100) * BAR_WIDTH))
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${BAR_WIDTH}" height="${BAR_HEIGHT}" viewBox="0 0 ${BAR_WIDTH} ${BAR_HEIGHT}">` +
    `<rect width="${BAR_WIDTH}" height="${BAR_HEIGHT}" rx="${r}" fill="rgb(128,128,128)" fill-opacity="0.28"/>` +
    (fill > 0 ? `<rect width="${fill.toFixed(1)}" height="${BAR_HEIGHT}" rx="${r}" fill="${barColor(pct)}"/>` : '') +
    `</svg>`
  )
}

const tokens = (n: number) => n.toLocaleString('en-US')

const span = (ms: number) => {
  const m = Math.max(0, Math.floor(ms / 60_000))
  if (m >= 1440) return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`
  return `${m}m`
}

// 42s, 45m 21s, 1h 05m: seconds while they matter, coarser as a turn grows.
const clock = (ms: number) => {
  const s = Math.floor(Math.max(0, ms) / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}
// A finished turn under a minute keeps its tenths: 17.2s.
const secs = (ms: number) => (ms < 60_000 ? `${(Math.max(0, ms) / 1000).toFixed(1)}s` : clock(ms))

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

const field = (input: unknown, name: string): string | undefined => {
  const value = (input as Record<string, unknown> | null)?.[name]
  return typeof value === 'string' ? value : undefined
}

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path

const summarize = (input: unknown): string => {
  const path = field(input, 'file_path') ?? field(input, 'notebook_path')
  if (path) return baseName(path)
  const text =
    field(input, 'command') ??
    field(input, 'pattern') ??
    field(input, 'description') ??
    field(input, 'url') ??
    field(input, 'query') ??
    field(input, 'prompt') ??
    ''
  const line = text.split('\n')[0]
  return line.length > 60 ? `${line.slice(0, 59)}…` : line
}

// One clock at a time: 1s while a turn runs, 60s while idle.
let ticker: { cancel: () => void } | undefined

function tickEvery($: EngineInterface, ms: number) {
  ticker?.cancel()
  ticker = $.clock.every(ms, () => {
    void $.clock.now().then(t => update($, now, () => t))
  })
}

export const register: Register = on => {
  // Edited paths and measured tool durations live in the module: a reload drops
  // them, and a card without a measured time simply shows none.
  let turnFiles = new Set<string>()
  let lastFive: number | undefined
  let lastWeek: number | undefined
  const durations = new Map<string, number>()

  on('session.start', async ($, e, next) => {
    const saved = (await $.store.get('prefs')) as Partial<HudPrefs> | undefined
    if (saved) await update($, prefs, current => ({ ...current, ...saved }))
    await $.command.register({
      name: 'hud',
      description: 'Pro HUD: /hud all [on|off] · /hud <band|spinner|cards> [on|off]',
    })
    const t = await $.clock.now()
    await update($, now, () => t)
    tickEvery($, IDLE_MS)

    return next(e)
  })

  on('command.run', { command: 'hud' }, async ($, e) => {
    // Answered with a toast and no `text`: a command's text row is something
    // the model reads, and toggling the HUD should cost no tokens at all.
    const [part, value] = e.args.trim().toLowerCase().split(/\s+/)
    const current = await read($, prefs)
    const keys = Object.keys(current) as (keyof HudPrefs)[]
    const describe = (p: HudPrefs) => keys.map(k => `${k} ${p[k] ? 'on' : 'off'}`).join(' · ')
    const save = async (saved: HudPrefs) => {
      await update($, prefs, () => saved)
      await $.store.set('prefs', saved)
    }

    if (part === 'all' || part === 'on' || part === 'off') {
      const flag = part === 'all' ? value !== 'off' : part === 'on'
      const saved = Object.fromEntries(keys.map(k => [k, flag])) as HudPrefs
      await save(saved)
      $.ui.toast(`HUD: ${describe(saved)}`)
      return {}
    }
    if (part && part in current) {
      const key = part as keyof HudPrefs
      const flag = value === 'on' ? true : value === 'off' ? false : !current[key]
      const saved = { ...current, [key]: flag }
      await save(saved)
      $.ui.toast(`HUD: ${describe(saved)}`)
      return {}
    }
    $.ui.toast(`HUD: ${describe(current)} — /hud all on|off · /hud band|spinner|cards on|off`)
    return {}
  })

  on('turn.start', async ($, e, next) => {
    turnFiles = new Set()
    const fiveStart = (await read($, limits)).find(l => l.kind === 'five_hour')?.pct
    const t = await $.clock.now()
    await update($, now, () => t)
    await update($, turn, () => ({
      startedAt: t,
      isRunning: true,
      tools: 0,
      files: 0,
      inTok: 0,
      cacheTok: 0,
      outTok: 0,
      fiveStart,
    }))
    tickEvery($, LIVE_MS)

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const path = field(e, 'file_path') ?? field(e, 'notebook_path')
    if (path && EDITS.includes(e.tool)) turnFiles.add(path)
    const files = turnFiles.size
    await update($, turn, t => (t?.isRunning ? { ...t, tools: t.tools + 1, files } : t))
    const t0 = await $.clock.now()
    const ran = await next(e)
    durations.set(e.tool_use_id, (await $.clock.now()) - t0)
    if (durations.size > CARD_CACHE) durations.delete(durations.keys().next().value as string)

    return ran
  })

  // Each main-thread model request: add its reported usage to the live turn,
  // and its input size is the context's fill as of that request.
  on('turn.step', async function* ($, e, next) {
    const step = yield* next(e)
    const usage = step.usage
    if (e.agentId === undefined && usage) {
      const cacheTok = usage.cache_read_input_tokens ?? 0
      const inTok = usage.input_tokens + cacheTok + (usage.cache_creation_input_tokens ?? 0)
      await update($, turn, t =>
        t?.isRunning
          ? { ...t, inTok: t.inTok + inTok, cacheTok: t.cacheTok + cacheTok, outTok: t.outTok + usage.output_tokens }
          : t,
      )
      await update($, context, c =>
        c.window ? { ...c, tokens: inTok, pct: Math.round((inTok / c.window) * 100) } : c,
      )
    }

    return step
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const usage = e.usage
      await update($, turn, t => {
        if (!t) return t
        const ended: HudTurn = { ...t, isRunning: false, ms: e.durationMs }
        if (!usage) return ended
        const cacheTok = usage.cache_read_input_tokens ?? 0
        return {
          ...ended,
          inTok: usage.input_tokens + cacheTok + (usage.cache_creation_input_tokens ?? 0),
          cacheTok,
          outTok: usage.output_tokens,
        }
      })
      tickEvery($, IDLE_MS)
    }

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const list: HudLimit[] = e.rateLimits.map(l => ({ kind: l.kind, pct: l.percentUsed, resetsAt: l.resetsAt }))
    if (list.length > 0) await update($, limits, () => list)
    await update($, context, () => ({ pct: e.context.percent, tokens: e.context.tokens, window: e.context.window }))

    // A toast when a reading crosses 80% or 90%: once per crossing, whatever
    // order the readings arrive in relative to the turn.
    const five = list.find(l => l.kind === 'five_hour')
    if (five && lastFive !== undefined) {
      const before = lastFive
      for (const mark of [90, 80]) {
        if (before < mark && five.pct >= mark) {
          $.ui.toast(`Session usage at ${five.pct}% — ${mark === 90 ? 'wrap up soon' : 'plan your last few turns'}`)
          break
        }
      }
    }
    if (five) lastFive = five.pct

    // The weekly window drains quietly: say so at 50, 75 and 90%, once each.
    const week = list.find(l => l.kind === 'seven_day')
    if (week && lastWeek !== undefined) {
      for (const mark of [90, 75, 50]) {
        if (lastWeek < mark && week.pct >= mark) {
          $.ui.toast(`Weekly usage at ${week.pct}%. Long chats re-send their whole context on every request; a fresh session (/handoff) keeps each request small.`, { timeoutMs: 12_000 })
          break
        }
      }
    }
    if (week) lastWeek = week.pct

    return next(e)
  })

  // The session reading rides along in the desktop spinner while a turn runs.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (e.surface !== 'desktop' || !(await read($, prefs)).spinner) return next(e)
    const five = (await read($, limits)).find(l => l.kind === 'five_hour')
    if (!five) return next(e)
    const base = e.props.message ?? e.props.word

    return next({ ...e, props: { ...e.props, message: `${base} · session ${five.pct}%` } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'desktop' || e.props.hasSurvey) return next(e)
    if (!(await read($, prefs)).band) return next(e)
    const list = await read($, limits)
    const current = await read($, turn)
    const ctx = await read($, context)
    if (list.length === 0 && !current && ctx.pct === undefined) return next(e)

    const { Box, Text, Svg } = $.ui.resolve(e)
    // Reading `now` subscribes the band to the ticks; the time drawn is the
    // clock's own, so it is right before the first tick too.
    await read($, now)
    const t = await $.clock.now()
    const wide = e.props.bodyColumns >= WIDE

    const meter = (key: string, label: string, pct: number, note?: string) => (
      <Box key={key} flexDirection="row" alignItems="center" marginRight={wide ? 4 : 0}>
        <Box width={wide ? 9 : 10}>
          <Text dimColor>{label}</Text>
        </Box>
        <Svg source={barSvg(pct)} alt={`${label} ${pct}%`} width={BAR_WIDTH} height={BAR_HEIGHT} />
        <Box width={6} justifyContent="flex-end">
          <Text bold color={textTone(pct)}>{`${pct}%`}</Text>
        </Box>
        {note !== undefined && <Text dimColor>{`  ${note}`}</Text>}
      </Box>
    )

    const meters = [
      ...list.map(limit => {
        const resetMs = limit.resetsAt ? Date.parse(limit.resetsAt) - t : undefined
        const note = resetMs !== undefined && resetMs > 0 ? (wide ? span(resetMs) : `resets in ${span(resetMs)}`) : undefined
        return meter(limit.kind, LABEL[limit.kind] ?? limit.kind, limit.pct, note)
      }),
      ...(ctx.pct !== undefined
        ? [meter('context', 'Context', ctx.pct, ctx.tokens !== undefined ? `${tokens(ctx.tokens)} tokens` : undefined)]
        : []),
    ]

    const live = current?.isRunning === true
    // Session points the turn used: the latest reading less the one the turn
    // started from, both as Claude Code reported them.
    const fiveNow = list.find(l => l.kind === 'five_hour')?.pct
    const fiveDelta =
      !live && current?.fiveStart !== undefined && fiveNow !== undefined
        ? Math.round((fiveNow - current.fiveStart) * 10) / 10
        : undefined
    const parts = current
      ? [
          live ? clock(t - current.startedAt) : secs(current.ms ?? 0),
          plural(current.tools, 'tool', 'tools'),
          `${plural(current.files, 'file', 'files')} edited`,
          `${tokens(current.inTok)} in`,
          `${tokens(current.cacheTok)} cached`,
          `${tokens(current.outTok)} out`,
        ]
      : []

    return (
      <Box flexDirection="column">
        <Box flexDirection={wide ? 'row' : 'column'}>{meters}</Box>
        {current && (
          <Box flexDirection="row">
            <Box width={wide ? 9 : 10} flexShrink={0}>
              <Text dimColor={!live} color={live ? WARN : undefined}>{live ? 'This turn' : 'Last turn'}</Text>
            </Box>
            {/* Each figure is its own unit: a narrow band wraps whole figures to
                the next line rather than cutting one off. */}
            <Box flexDirection="row" flexWrap="wrap" flexShrink={1}>
              {parts.map((part, i) => (
                <Text key={`p${i}`} dimColor wrap="end">{`${i === 0 ? '' : '  ·  '}${part}`}</Text>
              ))}
              {fiveDelta !== undefined && (
                <Text key="delta" color={fiveDelta >= 5 ? WARN : undefined} dimColor={fiveDelta < 5} wrap="end">
                  {`  ·  +${fiveDelta}% session`}
                </Text>
              )}
            </Box>
          </Box>
        )}
        {ctx.pct !== undefined && ctx.pct >= COMPACT_AT && (
          <Text color={WARN}>{'Context is filling up — run /compact before starting a large task.'}</Text>
        )}
      </Box>
    )
  })

  // Finished tool calls in the transcript's own idiom: status dot, tool, target, time.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.surface !== 'desktop' || e.props.isRunning || e.props.isInterrupted) return next(e)
    if (!(await read($, prefs)).cards) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const ms = durations.get(e.props.tool_use_id)
    const failed = e.props.isErrored
    const name = e.props.tool.startsWith('mcp__') ? e.props.tool.split('__').slice(1).join(' · ') : e.props.tool

    return (
      <Box flexDirection="row">
        <Text color={failed ? CRITICAL : OK}>{'● '}</Text>
        <Text bold>{name}</Text>
        <Text dimColor wrap="truncate-end">{`  ${summarize(e.props.input)}`}</Text>
        {ms !== undefined && <Text dimColor>{`  ${secs(ms)}`}</Text>}
      </Box>
    )
  })
}
