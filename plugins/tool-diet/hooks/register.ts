import type { EngineInterface, Register } from 'claude-code'

// Every tool listed in front sends its whole description and schema with every
// request; a deferred one is listed by name and loaded through ToolSearch when
// the model asks for it. This moves the tools you have not used lately to the
// deferred list. The choice is made once per tool per session (an answer that
// changed mid-session would spend the prompt cache) and applies from the next
// session after a change.

// Never deferred: the tools almost every task uses, and ToolSearch itself.
export const CORE = new Set([
  'Bash',
  'PowerShell',
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'Agent',
  'Task',
  'Skill',
  'ToolSearch',
  'TodoWrite',
  'AskUserQuestion',
])

// A tool used in any of the last RECENT sessions stays loaded.
export const RECENT = 5

type Memory = {
  /** How many sessions the mod has seen start. */
  sessions: number
  /** The session number each tool was last used in. */
  lastUsed: Record<string, number>
  /** Tools the person asked to keep loaded. */
  keep: string[]
  isOff: boolean
}

const EMPTY: Memory = { sessions: 0, lastUsed: {}, keep: [], isOff: false }

async function recall($: EngineInterface): Promise<Memory> {
  const saved = (await $.store.get('memory')) as Partial<Memory> | undefined
  return { ...EMPTY, ...saved }
}

async function remember($: EngineInterface, memory: Memory) {
  await $.store.set('memory', memory)
}

export const shouldDefer = (tool: string, memory: Memory): boolean => {
  if (memory.isOff || CORE.has(tool) || memory.keep.includes(tool)) return false
  const last = memory.lastUsed[tool]
  return last === undefined || last <= memory.sessions - RECENT
}

export const register: Register = on => {
  // This session's number, and what it moved: for the status line and /tool-diet.
  let session = 0
  const moved = new Set<string>()

  on('session.start', async ($, e, next) => {
    const memory = await recall($)
    memory.sessions += 1
    session = memory.sessions
    await remember($, memory)
    await $.command.register({
      name: 'tool-diet',
      description: 'Tool diet: /tool-diet · keep <tool> · unkeep <tool> · on · off',
    })

    return next(e)
  })

  on('tool.describe', async ($, e, next) => {
    const described = await next(e)
    if (e.isDeferred || described.isDeferred) return described
    if (!shouldDefer(e.tool, await recall($))) return described

    moved.add(e.tool)
    $.ui.status(`${moved.size} ${moved.size === 1 ? 'tool' : 'tools'} on demand`)
    return { ...described, isDeferred: true }
  })

  on('tool.call', async ($, e, next) => {
    if (session > 0) {
      const memory = await recall($)
      if (memory.lastUsed[e.tool] !== session) {
        memory.lastUsed[e.tool] = session
        await remember($, memory)
      }
    }

    return next(e)
  })

  // Answered with a toast and no text, so the command adds nothing to the conversation.
  on('command.run', { command: 'tool-diet' }, async ($, e) => {
    const [verb, tool] = e.args.trim().split(/\s+/)
    const memory = await recall($)

    if ((verb === 'keep' || verb === 'unkeep') && tool) {
      memory.keep = verb === 'keep' ? [...new Set([...memory.keep, tool])] : memory.keep.filter(t => t !== tool)
      await remember($, memory)
      $.ui.toast(`Tool diet: ${tool} ${verb === 'keep' ? 'stays loaded' : 'may move on demand'} from the next session`)
      return {}
    }
    if (verb === 'on' || verb === 'off') {
      memory.isOff = verb === 'off'
      await remember($, memory)
      $.ui.toast(`Tool diet ${verb} from the next session`)
      return {}
    }

    const list = [...moved].sort().join(', ')
    $.ui.toast(
      memory.isOff
        ? 'Tool diet is off. /tool-diet on to turn it back on.'
        : moved.size === 0
          ? 'Tool diet: every tool is loaded this session.'
          : `On demand this session: ${list}. /tool-diet keep <tool> to keep one loaded.`,
      { timeoutMs: 15_000 },
    )
    return {}
  })
}
