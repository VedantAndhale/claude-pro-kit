import type { EngineInterface, Register } from 'claude-code'

// Holds a prompt back once the 5-hour or weekly usage reading Claude Code
// reports is at or over your limit, before the turn spends anything. Sending
// the same prompt again goes through. The readings are the exact percentages
// the usage meters show; nothing is estimated and nothing is sent to the model.

const DEFAULT_LIMIT = 90

export type Reading = { kind: string; pct: number; resetsAt?: string }
export type Settings = { limit: number; isOn: boolean }

const NAMES: Record<string, string> = { five_hour: '5-hour', seven_day: 'weekly' }

export const untilReset = (resetsAt: string | undefined, now: number) => {
  const at = resetsAt === undefined ? NaN : Date.parse(resetsAt)
  if (Number.isNaN(at) || at <= now) return undefined
  const m = Math.ceil((at - now) / 60_000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`
}

/** The windows at or over the limit, highest first. */
export const overLimit = (readings: Reading[], limit: number) =>
  readings.filter(r => r.kind in NAMES && r.pct >= limit).sort((a, b) => b.pct - a.pct)

export const holdText = (over: Reading[], limit: number, now: number) => {
  const parts = over.map(r => {
    const reset = untilReset(r.resetsAt, now)
    return `${NAMES[r.kind]} usage at ${r.pct}%${reset ? `, resets in ${reset}` : ''}`
  })
  return `budget-guard: ${parts.join('; ')} (your limit is ${limit}%). Send the same message again to go ahead, or /budget off.`
}

export const parseCommand = (args: string, current: Settings): Settings | string | undefined => {
  const arg = args.trim().toLowerCase()
  if (arg === '') return undefined
  if (arg === 'off') return { ...current, isOn: false }
  if (arg === 'on') return { ...current, isOn: true }
  const n = Number(arg.replace(/%$/, ''))
  if (Number.isInteger(n) && n >= 1 && n <= 100) return { limit: n, isOn: true }
  return 'Use /budget <1-100>, /budget on or /budget off.'
}

const describe = (s: Settings, readings: Reading[]) => {
  const now = readings
    .filter(r => r.kind in NAMES)
    .map(r => `${NAMES[r.kind]} ${r.pct}%`)
    .join(', ')
  return `budget-guard ${s.isOn ? `on at ${s.limit}%` : 'off'}${now ? ` · now ${now}` : ''}`
}

let settings: Settings = { limit: DEFAULT_LIMIT, isOn: true }
let readings: Reading[] = []
let heldText: string | undefined

async function save($: EngineInterface) {
  await $.store.set('settings', settings)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const saved = (await $.store.get('settings')) as Partial<Settings> | undefined
    if (saved) settings = { ...settings, ...saved }
    heldText = undefined
    await $.command.register({
      name: 'budget',
      description: 'Budget guard: /budget shows it · /budget <1-100> sets the limit · /budget on|off',
    })
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const list = e.rateLimits.map(l => ({ kind: l.kind, pct: l.percentUsed, resetsAt: l.resetsAt }))
    if (list.length > 0) readings = list
    return next(e)
  })

  // Answered as a toast: changing the limit adds nothing to the conversation.
  on('command.run', { command: 'budget' }, async ($, e) => {
    const parsed = parseCommand(e.args ?? '', settings)
    if (typeof parsed === 'string') {
      $.ui.toast(parsed)
      return {}
    }
    if (parsed) {
      settings = parsed
      await save($)
    }
    $.ui.toast(describe(settings, readings))
    return {}
  })

  on('prompt.submit', async ($, e, next) => {
    if (!settings.isOn) return next(e)
    const over = overLimit(readings, settings.limit)
    if (over.length === 0 || heldText === e.text) {
      heldText = undefined
      return next(e)
    }
    heldText = e.text
    return { drop: holdText(over, settings.limit, await $.clock.now()) }
  })
}
