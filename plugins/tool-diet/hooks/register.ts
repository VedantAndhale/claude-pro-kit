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

// Where a tool comes from, as a person would name it: `built-in`, an MCP
// server's own name (`claude.ai Claude Docs`), or the plugin's name.
export const sourceOf = (provider: unknown): string => {
  const name = (provider as { plugin?: string } | undefined)?.plugin ?? 'other'
  if (name === 'engine') return 'built-in'
  const source = name.startsWith('mcp:') ? name.slice(4) : name
  // Some connectors reach a plugin only as an id; name those plainly.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(source) ? 'a connector' : source
}

// An MCP tool's own name without the `mcp__<server>__` prefix.
const toolName = (tool: string) => (tool.startsWith('mcp__') ? tool.split('__').slice(2).join('__') || tool : tool)

const SHOWN_PER_SOURCE = 2
const SHOWN_SOURCES = 3

// `19 from Claude Browser: browser_batch, computer +17 more · 10 built-in: Artifact, ListAgents +8 more · +2 more sources`
export const summarize = (moved: Map<string, string>): string => {
  const groups = new Map<string, string[]>()
  for (const [tool, source] of moved) groups.set(source, [...(groups.get(source) ?? []), toolName(tool)])
  const sorted = [...groups].sort((a, b) => b[1].length - a[1].length)
  const rest = sorted.length - SHOWN_SOURCES
  return sorted
    .slice(0, SHOWN_SOURCES)
    .map(([source, tools]) => {
      const names = tools.sort().slice(0, SHOWN_PER_SOURCE).join(', ')
      const more = tools.length > SHOWN_PER_SOURCE ? ` +${tools.length - SHOWN_PER_SOURCE} more` : ''
      const label = source === 'built-in' ? 'built-in' : `from ${source}`
      return `${tools.length} ${label}: ${names}${more}`
    })
    .concat(rest > 0 ? [`+${rest} more ${rest === 1 ? 'source' : 'sources'}`] : [])
    .join(' · ')
}

export const register: Register = on => {
  // This session's number, and what it moved (tool -> source): for the status line and /tool-diet.
  let session = 0
  const moved = new Map<string, string>()

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
    // Already on demand, or another plugin explicitly keeps it listed (answer-pane
    // lists show_page so Claude can choose a page on its own): leave it.
    if (e.isDeferred || described.isDeferred !== undefined) return described
    if (!shouldDefer(e.tool, await recall($))) return described

    moved.set(e.tool, sourceOf(e.provider))
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

    $.ui.toast(
      memory.isOff
        ? 'Tool diet is off. /tool-diet on to turn it back on.'
        : moved.size === 0
          ? 'Tool diet: every tool is loaded this session.'
          : `${moved.size} tools on demand. ${summarize(moved)}`,
      { timeoutMs: 15_000 },
    )
    return {}
  })
}
