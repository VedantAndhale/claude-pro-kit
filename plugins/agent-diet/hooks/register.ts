import type { EngineInterface, Register } from 'claude-code'

// Explore and similar subagents only search and read, yet run on the parent's
// model unless told otherwise. This sets a cheaper model on the spawn for the
// listed agent types. A model Claude names in the Agent call is kept, a fork
// always inherits, and nothing is sent to the model.

const MODELS = ['haiku', 'sonnet', 'opus'] as const

export type Settings = { isOn: boolean; model: string; types: string[] }

export const DEFAULTS: Settings = { isOn: true, model: 'haiku', types: ['Explore'] }

const USAGE = 'Use /agent-diet, /agent-diet on|off, /agent-diet model haiku|sonnet|opus, /agent-diet add|remove <agent type>.'

export const parseCommand = (args: string, current: Settings): Settings | string | undefined => {
  const [verb = '', ...rest] = args.trim().split(/\s+/)
  const value = rest.join(' ')
  switch (verb.toLowerCase()) {
    case '':
      return undefined
    case 'on':
      return { ...current, isOn: true }
    case 'off':
      return { ...current, isOn: false }
    case 'model': {
      const model = value.toLowerCase()
      return (MODELS as readonly string[]).includes(model) ? { ...current, model } : USAGE
    }
    case 'add':
      if (value === '') return USAGE
      return current.types.includes(value) ? current : { ...current, types: [...current.types, value] }
    case 'remove':
      if (value === '') return USAGE
      return { ...current, types: current.types.filter(t => t !== value) }
    default:
      return USAGE
  }
}

/** The model to start the subagent on, or undefined to leave the spawn as it is. */
export const pick = (s: Settings, spawn: { subagentType: string; model?: string; fork?: boolean }) =>
  s.isOn && spawn.model === undefined && spawn.fork !== true && s.types.includes(spawn.subagentType)
    ? s.model
    : undefined

export const describe = (s: Settings, moved: number) =>
  s.isOn
    ? `agent-diet on · ${s.types.join(', ') || 'no agent types'} on ${s.model} · ${moved} this session`
    : 'agent-diet off · subagents run on their usual model'

let settings: Settings = { ...DEFAULTS }
let moved = 0

async function save($: EngineInterface) {
  await $.store.set('settings', settings)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const saved = (await $.store.get('settings')) as Partial<Settings> | undefined
    if (saved) settings = { ...settings, ...saved }
    moved = 0
    await $.command.register({
      name: 'agent-diet',
      description: 'Agent diet: /agent-diet shows it · on|off · model haiku|sonnet|opus · add|remove <agent type>',
    })
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const model = pick(settings, e)
    if (model === undefined) return next(e)

    const started = await next({ ...e, model })
    if (started.deny === undefined) {
      moved += 1
      $.ui.status(`${moved} ${moved === 1 ? 'subagent' : 'subagents'} on ${settings.model}`)
    }
    return started
  })

  // Answered as a toast: changing a setting adds nothing to the conversation.
  on('command.run', { command: 'agent-diet' }, async ($, e) => {
    const parsed = parseCommand(e.args ?? '', settings)
    if (typeof parsed === 'string') {
      $.ui.toast(parsed)
      return {}
    }
    if (parsed) {
      settings = parsed
      await save($)
    }
    $.ui.toast(describe(settings, moved))
    return {}
  })
}
