import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register } from 'claude-code'

// Typing "status" while Claude waits on background work re-sends the whole
// conversation just to ask how it is going. peek answers it locally: the
// prompt is dropped and a pane lists each background shell and subagent with
// its exact elapsed time and the last lines of its output. A percent bar is
// drawn only from a percent the task printed itself; nothing is estimated and
// nothing is sent to the model.

const PANE = 'peek'
const TAIL_LINES = 3
const CLIP = 70
const RECENT_MS = 10 * 60_000
const TICK_MS = 1_000
const MAX_READ = 4 * 1024 * 1024
const MAX_TRACKED = 100
const BAR_CELLS = 20

const SHELLS = new Set(['Bash', 'PowerShell'])
const LIVE_AGENT = new Set(['pending', 'running', 'waiting'])

const tick = atom({ plugin: 'peek', key: 'tick' } as const, 0)

export type Shell = {
  id: string
  command: string
  startedAt: number
  path?: string
  /** The loop that started it: a subagent's id, absent on the main loop. */
  loop?: string
  /** Claude Code ends it with its caller's final answer: no notification follows. */
  endsWithCaller?: boolean
  endedAt?: number
  status?: string
}

export type Agent = { id: string; description: string; startedAt?: number; endedAt?: number; ms?: number; status?: string }

// ---- Pure helpers (exported for the tests) ----

export const isStatus = (text: string) => text.trim().toLowerCase() === 'status'

/** `4m 12s`, `1h 3m 7s`, `9s`: exact to the second. */
export const elapsed = (ms: number) => {
  const s = Math.floor(Math.max(0, ms) / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h ${m}m ${s % 60}s`
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`
}

export const clip = (text: string, max = CLIP) => {
  const line = text.trim().split(/\r?\n/)[0] ?? ''
  return line.length > max ? `${line.slice(0, max - 3)}...` : line
}

/**
 * The id and output file Claude Code names when a shell goes to the
 * background: "Command running in background with ID: b1x2. Output is being
 * written to: C:\...\tasks\b1x2.output. You will be notified when it completes."
 */
export const parseBackground = (text: string) => {
  const id = /in background with ID:\s*([A-Za-z0-9_-]+)/.exec(text)?.[1]
  const path = /Output is being written to:\s*(.+?)(?=\.\s|\.?\s*$)/m.exec(text)?.[1]?.trim()
  return { id, path }
}

/** Each `<task-notification>` in a text: the task's id and how it ended. */
export const parseNotifications = (text: string) => {
  const found: { id: string; status: string }[] = []
  for (const block of text.split('<task-notification>').slice(1)) {
    const id = /<task-id>\s*([^<\s]+)\s*<\/task-id>/.exec(block)?.[1]
    const status = /<status>\s*([^<]+?)\s*<\/status>/.exec(block)?.[1]
    if (id) found.push({ id, status: status ?? 'ended' })
  }
  return found
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g

/** The last non-empty lines; a carriage return (a progress redraw) starts a line. */
export const tail = (text: string, n = TAIL_LINES) =>
  text
    .replace(ANSI, '')
    .split(/\r\n|\n|\r/)
    .map(l => l.trimEnd())
    .filter(l => l.trim() !== '')
    .slice(-n)

/** The latest percent figure in the lines, as printed; undefined when none. */
export const lastPercent = (lines: readonly string[]) => {
  let pct: number | undefined
  for (const m of lines.join('\n').matchAll(/(\d{1,3}(?:\.\d+)?)\s?%/g)) {
    const n = Number(m[1])
    if (n >= 0 && n <= 100) pct = n
  }
  return pct
}

export const bar = (pct: number, cells = BAR_CELLS) => {
  const full = Math.floor((pct / 100) * cells)
  return `[${'#'.repeat(full)}${'-'.repeat(cells - full)}] ${pct}%`
}

// ---- The mod ----

// Kept in the module, reset at each load and at /clear: a reload forgets the
// tasks it saw, and the pane says so for a subagent it never saw start.
let shells = new Map<string, Shell>()
let agents = new Map<string, Agent>()
let isOpen = false
let ticker: { cancel: () => void } | undefined

const trim = <T,>(map: Map<string, T>) => {
  while (map.size > MAX_TRACKED) map.delete(map.keys().next().value as string)
}

const runningShells = () => [...shells.values()].filter(s => s.endedAt === undefined)

function stopTicker() {
  ticker?.cancel()
  ticker = undefined
}

function forget() {
  shells = new Map()
  agents = new Map()
  isOpen = false
  stopTicker()
}

async function bump($: EngineInterface) {
  const t = await $.clock.now()
  await update($, tick, () => t)
}

async function liveAgents($: EngineInterface): Promise<AgentInfo[]> {
  const list = await $.agent.list().catch(() => [] as AgentInfo[])
  return list.filter(a => LIVE_AGENT.has(a.status))
}

// One clock, only while the pane is open and something runs: the timers
// count up live, and nothing ticks otherwise.
function startTicker($: EngineInterface) {
  if (!isOpen || ticker) return
  // A tick that fails (the session or the plugin went away) stops the clock.
  ticker = $.clock.every(TICK_MS, () => void onTick($).catch(stopTicker))
}

async function onTick($: EngineInterface) {
  if (runningShells().length === 0 && (await liveAgents($)).length === 0) stopTicker()
  await bump($)
}

async function openPane($: EngineInterface) {
  await $.ui.open({ id: PANE, title: 'peek' })
  isOpen = true
  await bump($)
  startTicker($)
}

async function finish($: EngineInterface, id: string, status: string) {
  const at = await $.clock.now()
  const shell = shells.get(id)
  if (shell && shell.endedAt === undefined) {
    shell.endedAt = at
    shell.status = status
  }
  const agent = agents.get(id)
  if (agent && agent.endedAt === undefined) {
    agent.endedAt = at
    agent.status = status
  }
  if (shell || agent) await bump($)
}

async function hearNotifications($: EngineInterface, text: string) {
  for (const n of parseNotifications(text)) await finish($, n.id, n.status)
}

/** The output file's last lines, read through $.fs; a note when there are none. */
async function readTail($: EngineInterface, path: string | undefined): Promise<{ lines?: string[]; note?: string }> {
  if (!path) return { note: 'output file not reported' }
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (!stat) return { note: 'no output file yet' }
  if (stat.size > MAX_READ) return { note: `output is ${stat.size.toLocaleString('en-US')} bytes, too large to tail` }
  const text = await $.fs.read(path).catch(() => undefined)
  if (typeof text !== 'string') return { note: 'output file unreadable' }
  const lines = tail(text)
  return lines.length === 0 ? { note: 'no output yet' } : { lines }
}

export const register: Register = on => {
  forget()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'peek',
      description: 'peek: background shells and subagents, their elapsed time and latest output, in a pane',
    })
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    // The model stopping a task ends it.
    if (e.tool === 'TaskStop') {
      const ran = await next(e)
      const id = e.task_id ?? e.shell_id
      if (ran.deny === undefined && ran.isError !== true && id) await finish($, id, 'killed')
      return ran
    }
    if (!SHELLS.has(e.tool) || typeof e.command !== 'string') return next(e)

    const before = await $.clock.now()
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran

    const record = (ran.result ?? {}) as {
      backgroundTaskId?: string
      backgroundedByUser?: boolean
      timedOutAfterMs?: number
      backgroundEndsWithFinalResponse?: true
    }
    const parsed = parseBackground(ran.text ?? '')
    const id = record.backgroundTaskId ?? parsed.id
    if (!id) return ran

    // run_in_background starts the command as the call returns; Ctrl+B or a
    // timeout moves one that has been running since the call began.
    const movedLater = record.backgroundedByUser === true || record.timedOutAfterMs !== undefined
    shells.set(id, {
      id,
      command: e.command,
      startedAt: movedLater ? before : await $.clock.now(),
      path: parsed.path,
      loop: e.agentId,
      endsWithCaller: record.backgroundEndsWithFinalResponse === true,
    })
    trim(shells)
    await bump($)
    startTicker($)

    return ran
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (spawned.agentId) {
      agents.set(spawned.agentId, { id: spawned.agentId, description: e.description, startedAt: await $.clock.now() })
      trim(agents)
      await bump($)
      startTicker($)
    }
    return spawned
  })

  on('turn.complete', async ($, e, next) => {
    const agent = e.agentId === undefined ? undefined : agents.get(e.agentId)
    if (agent && agent.endedAt === undefined) {
      agent.endedAt = await $.clock.now()
      agent.ms = e.durationMs
      agent.status = e.reason === 'answer' ? 'completed' : e.reason
    }
    // A shell bound to its caller's final answer ends with it, unannounced.
    for (const s of runningShells()) {
      if (s.endsWithCaller && s.loop === e.agentId) await finish($, s.id, 'ended with its caller')
    }
    if (agent) await bump($)
    return next(e)
  })

  // A notification can also start a turn of its own.
  on('turn.start', async ($, e, next) => {
    if (e.text.includes('<task-notification>')) await hearNotifications($, e.text)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.text.includes('<task-notification>')) await hearNotifications($, e.text)
    if (e.origin.kind === 'task-notification' || !isStatus(e.text)) return next(e)

    const n = runningShells().length + (await liveAgents($)).length
    if (n === 0) return next(e)

    await openPane($)
    // Shown to the person only; the prompt never enters the conversation.
    return { drop: `peek: ${n} running, opened in the pane` }
  })

  // Answered with no text: opening the pane adds nothing to the conversation.
  on('command.run', { command: 'peek' }, async $ => {
    await openPane($)
    return {}
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      isOpen = false
      stopTicker()
    }
    return next(e)
  })

  // /clear starts a fresh conversation; its background work is not this one's.
  on('session.end', async ($, e, next) => {
    forget()
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    await read($, tick)
    const now = await $.clock.now()
    const live = await liveAgents($)
    const running = runningShells()
    const recent = <T extends { endedAt?: number }>(list: T[]) =>
      list.filter(t => t.endedAt !== undefined && now - t.endedAt <= RECENT_MS)
    const doneShells = recent([...shells.values()])
    const doneAgents = recent([...agents.values()])
    const count = running.length + live.length

    const rows = await Promise.all(
      running.map(async s => ({ s, out: await readTail($, s.path) })),
    )

    return (
      <Box flexDirection="column">
        <Text bold>{count === 0 ? 'Nothing running in the background.' : `${count} running`}</Text>
        {rows.map(({ s, out }) => {
          const pct = out.lines ? lastPercent(out.lines) : undefined
          return (
            <Box key={`s-${s.id}`} flexDirection="column" marginTop={1}>
              <Box flexDirection="row">
                <Text bold>shell</Text>
                <Text wrap="truncate-end">{`  ${clip(s.command)}  ·  ${elapsed(now - s.startedAt)}`}</Text>
              </Box>
              {pct !== undefined && <Text>{`  ${bar(pct)}  as reported by the task's output`}</Text>}
              {out.lines ? (
                out.lines.map((l, i) => <Text key={`l${i}`} dimColor wrap="truncate-end">{`  ${l}`}</Text>)
              ) : (
                <Text dimColor>{`  ${out.note}`}</Text>
              )}
            </Box>
          )
        })}
        {live.map(a => {
          const seen = agents.get(a.id)?.startedAt
          return (
            <Box key={`a-${a.id}`} flexDirection="column" marginTop={1}>
              <Box flexDirection="row">
                <Text bold>subagent</Text>
                <Text wrap="truncate-end">
                  {`  ${clip(a.description || a.type)}  ·  ${seen === undefined ? 'started before peek loaded' : elapsed(now - seen)}`}
                </Text>
              </Box>
              <Text dimColor>{`  ${a.type} · ${a.status}`}</Text>
            </Box>
          )
        })}
        {doneShells.length + doneAgents.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor bold>Finished in the last 10 minutes</Text>
            {doneShells.map(s => (
              <Text key={`ds-${s.id}`} dimColor>
                {`shell  ${clip(s.command)}  ·  ${s.status}, notified after ${elapsed((s.endedAt ?? now) - s.startedAt)}`}
              </Text>
            ))}
            {doneAgents.map(a => (
              <Text key={`da-${a.id}`} dimColor>
                {`subagent  ${clip(a.description)}  ·  ${a.status}${
                  a.ms !== undefined
                    ? `, ran ${elapsed(a.ms)}`
                    : a.startedAt !== undefined
                      ? `, notified after ${elapsed((a.endedAt ?? now) - a.startedAt)}`
                      : ''
                }`}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
