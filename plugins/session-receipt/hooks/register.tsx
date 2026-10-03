import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { ReceiptTurn } from '../types'

// Every turn of the session with the tokens its model requests reported:
// uncached input, cached input and output, the main thread and its subagents
// together. Built only from the usage the API returns; nothing is estimated
// and nothing is sent to the model.

const PANE = 'session-receipt'
const TOP = 5
const MAX_TURNS = 500

const turns = atom({ plugin: 'session-receipt', key: 'turns' } as const, [] as ReceiptTurn[])

const tokens = (n: number) => n.toLocaleString('en-US')

export const duration = (ms: number) => {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

export const firstLine = (text: string) => {
  const line = text.trim().split('\n')[0]
  return line.length > 60 ? `${line.slice(0, 59)}…` : line
}

/** What a turn spent at full price: everything but cache reads. */
export const spent = (t: ReceiptTurn) => t.newTok + t.outTok

export const totals = (list: ReceiptTurn[]) =>
  list.reduce(
    (sum, t) => ({
      newTok: sum.newTok + t.newTok,
      cacheTok: sum.cacheTok + t.cacheTok,
      outTok: sum.outTok + t.outTok,
      agentTok: sum.agentTok + t.agentTok,
      tools: sum.tools + t.tools,
    }),
    { newTok: 0, cacheTok: 0, outTok: 0, agentTok: 0, tools: 0 },
  )

export const costliest = (list: ReceiptTurn[], n = TOP) =>
  [...list].filter(t => spent(t) > 0).sort((a, b) => spent(b) - spent(a)).slice(0, n)

export const row = (t: ReceiptTurn) =>
  `#${t.n}  ${tokens(t.newTok)} new · ${tokens(t.cacheTok)} cached · ${tokens(t.outTok)} out` +
  `${t.agentTok > 0 ? ` (${tokens(t.agentTok)} subagents)` : ''} · ${t.tools} tools` +
  `${t.isRunning ? ' · running' : t.ms !== undefined ? ` · ${duration(t.ms)}` : ''}`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'receipt',
      description: 'Session receipt: the exact tokens every turn of this session spent',
    })
    return next(e)
  })

  // Answered with no text: opening the pane adds nothing to the conversation.
  on('command.run', { command: 'receipt' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Session receipt' })
    return {}
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, turns, list =>
        [
          ...list,
          {
            n: (list.at(-1)?.n ?? 0) + 1,
            prompt: firstLine(e.text),
            isRunning: true,
            tools: 0,
            newTok: 0,
            cacheTok: 0,
            outTok: 0,
            agentTok: 0,
          },
        ].slice(-MAX_TURNS),
      )
    }
    return next(e)
  })

  const onCurrent = (fn: (t: ReceiptTurn) => ReceiptTurn) => (list: ReceiptTurn[]) => {
    const last = list.at(-1)
    return last?.isRunning ? [...list.slice(0, -1), fn(last)] : list
  }

  on('tool.call', async ($, e, next) => {
    await update($, turns, onCurrent(t => ({ ...t, tools: t.tools + 1 })))
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const step = yield* next(e)
    const u = step.usage
    if (u) {
      const newTok = u.input_tokens + (u.cache_creation_input_tokens ?? 0)
      const cacheTok = u.cache_read_input_tokens ?? 0
      const isAgent = e.agentId !== undefined
      await update(
        $,
        turns,
        onCurrent(t => ({
          ...t,
          newTok: t.newTok + newTok,
          cacheTok: t.cacheTok + cacheTok,
          outTok: t.outTok + u.output_tokens,
          agentTok: t.agentTok + (isAgent ? newTok + cacheTok + u.output_tokens : 0),
        })),
      )
    }
    return step
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, turns, onCurrent(t => ({ ...t, isRunning: false, ms: e.durationMs })))
    }
    return next(e)
  })

  // /clear starts a fresh conversation, and a fresh receipt.
  on('session.end', async ($, e, next) => {
    await update($, turns, () => [])
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, turns)
    if (list.length === 0) return <Text dimColor>No turns yet. Each turn appears here as it runs.</Text>

    const sum = totals(list)
    const top = costliest(list)
    const room = Math.max(3, (e.viewport?.rows ?? 30) - top.length * 2 - 10)

    return (
      <Box flexDirection="column">
        <Text bold>
          {list.length} {list.length === 1 ? 'turn' : 'turns'} · {tokens(sum.newTok)} new · {tokens(sum.cacheTok)} cached ·{' '}
          {tokens(sum.outTok)} out
        </Text>
        <Text dimColor>
          {sum.tools} tool calls{sum.agentTok > 0 ? ` · ${tokens(sum.agentTok)} tokens by subagents` : ''} · new and out are
          full price, cached is read from the prompt cache
        </Text>
        <Text> </Text>
        <Text bold>Costliest turns (new + out)</Text>
        {top.map(t => (
          <Box flexDirection="column">
            <Text>{row(t)}</Text>
            <Text dimColor>   {t.prompt}</Text>
          </Box>
        ))}
        <Text> </Text>
        <Text bold>All turns</Text>
        {list.slice(-room).map(t => (
          <Text dimColor={!t.isRunning}>
            {row(t)} · {t.prompt}
          </Text>
        ))}
      </Box>
    )
  })
}
