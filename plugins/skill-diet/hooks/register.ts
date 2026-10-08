import type { EngineInterface, Register } from 'claude-code'

// Every request carries the skill listing: each skill's name and its whole
// description, often several hundred characters each. This keeps the skills
// you used lately in this project listed in full and lists the rest by name
// only; the Skill tool still loads any of them, and typing /name still works.
// The choice is made once per session (a listing that changed mid-session
// would spend the prompt cache) and applies from the next session after a change.

// A skill used, or first seen, in any of the last RECENT sessions of this project stays listed.
export const RECENT = 5

type Project = {
  /** How many sessions the mod has seen start in this project. */
  sessions: number
  /** The session number each skill was last used in. */
  lastUsed: Record<string, number>
  /** The session number each skill was first listed in; 0 for skills there before the mod. */
  firstSeen: Record<string, number>
}

type Memory = {
  projects: Record<string, Project>
  /** Skills the person asked to keep listed in full, in every project. */
  keep: string[]
  isOff: boolean
}

const EMPTY: Memory = { projects: {}, keep: [], isOff: false }
const EMPTY_PROJECT: Project = { sessions: 0, lastUsed: {}, firstSeen: {} }

async function recall($: EngineInterface): Promise<Memory> {
  const saved = (await $.store.get('memory')) as Partial<Memory> | undefined
  return { ...EMPTY, ...saved }
}

async function remember($: EngineInterface, memory: Memory) {
  await $.store.set('memory', memory)
}

// `anthropic-skills:docs` and `docs` name the same skill; so do `apps/web:deploy` and `deploy`.
const bare = (skill: string) => skill.slice(skill.lastIndexOf(':') + 1)

const lastUse = (skill: string, project: Project): number | undefined => {
  const uses = [project.lastUsed[skill], project.lastUsed[bare(skill)]].filter((n): n is number => n !== undefined)
  return uses.length ? Math.max(...uses) : undefined
}

export const shouldHide = (skill: string, project: Project, memory: Pick<Memory, 'keep' | 'isOff'>): boolean => {
  if (memory.isOff || memory.keep.includes(skill) || memory.keep.includes(bare(skill))) return false
  const recent = Math.max(lastUse(skill, project) ?? 0, project.firstSeen[skill] ?? 0)
  return recent === 0 || recent <= project.sessions - RECENT
}

export type Entry = { name: string; text: string }

// The listing as the engine writes it: a header, then one `- name: description`
// entry per skill, a description sometimes running over several lines.
export const parseListing = (text: string): { head: string[]; entries: Entry[]; tail: string[] } => {
  const head: string[] = []
  const entries: Entry[] = []
  for (const line of text.split('\n')) {
    const match = /^- (\S+?): /.exec(line)
    if (match) entries.push({ name: match[1]!, text: line })
    else if (entries.length) entries[entries.length - 1]!.text += `\n${line}`
    else head.push(line)
  }
  // Trailing blank lines belong to the listing, not the last description.
  const tail: string[] = []
  const last = entries.at(-1)
  if (last) {
    const lines = last.text.split('\n')
    while (lines.length > 1 && lines.at(-1)!.trim() === '') tail.unshift(lines.pop()!)
    last.text = lines.join('\n')
  }
  return { head, entries, tail }
}

export const NAMES_ONLY = 'These skills are listed by name only; when one fits the task, load it with the Skill tool as usual:'

export const rewriteListing = (text: string, hide: (skill: string) => boolean): { text: string; hidden: string[] } => {
  const { head, entries, tail } = parseListing(text)
  const hidden = entries.filter(e => hide(e.name)).map(e => e.name)
  if (!hidden.length) return { text, hidden }
  const kept = entries.filter(e => !hide(e.name)).map(e => e.text)
  const names = `${NAMES_ONLY} ${hidden.join(', ')}`
  return { text: [...head, ...kept, '', names, ...tail].join('\n'), hidden }
}

async function recordUse($: EngineInterface, cwd: string, skill: string) {
  if (!cwd) return
  const memory = await recall($)
  const saved = { ...EMPTY_PROJECT, ...memory.projects[cwd] }
  if (saved.lastUsed[skill] === saved.sessions) return
  saved.lastUsed[skill] = saved.sessions
  memory.projects[cwd] = saved
  await remember($, memory)
}

const plural =(n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`

export const register: Register = on => {
  // This session's project, its frozen view of usage, and what the listing lost.
  let cwd = ''
  let project: Project = EMPTY_PROJECT
  let settings: Pick<Memory, 'keep' | 'isOff'> = EMPTY
  const hidden = new Set<string>()
  // Characters removed from each distinct listing text, so a listing rendered again is not counted twice.
  const removed = new Map<string, number>()

  const removedChars = () => [...removed.values()].reduce((a, b) => a + b, 0)

  on('session.start', async ($, e, next) => {
    const memory = await recall($)
    cwd = e.cwd
    const saved = memory.projects[cwd]
    const current: Project = { ...EMPTY_PROJECT, ...saved, sessions: (saved?.sessions ?? 0) + 1 }
    memory.projects[cwd] = current
    await remember($, memory)
    // Frozen for the session: usage from now on shows from the next one.
    project = structuredClone(current)
    settings = { keep: memory.keep, isOff: memory.isOff }
    await $.command.register({
      name: 'skill-diet',
      description: 'Skill diet: /skill-diet · keep <skill> · unkeep <skill> · on · off',
    })
    return next(e)
  })

  on('prompt.attachment', { type: 'skill_listing' }, async ($, e, next) => {
    const result = await next(e)
    if (result.text === null || !cwd) return result

    // Skills listed for the first time in this project get the same grace as a used one.
    const names = parseListing(result.text).entries.map(entry => entry.name)
    const unseen = names.filter(name => project.firstSeen[name] === undefined)
    if (unseen.length) {
      const memory = await recall($)
      const saved = { ...EMPTY_PROJECT, ...memory.projects[cwd] }
      // The first listing the mod sees in this project holds skills that were there before it: they count as old.
      const seen = Object.keys(saved.firstSeen).length === 0 ? 0 : project.sessions
      for (const name of unseen) {
        project.firstSeen[name] = seen
        saved.firstSeen[name] ??= seen
      }
      memory.projects[cwd] = saved
      await remember($, memory)
    }

    const rewritten = rewriteListing(result.text, name => shouldHide(name, project, settings))
    for (const name of rewritten.hidden) hidden.add(name)
    removed.set(result.text, result.text.length - rewritten.text.length)
    $.ui.status(hidden.size ? `${plural(hidden.size, 'skill')} by name only, ${plural(removedChars(), 'character')} off` : undefined)
    return { text: rewritten.text }
  })

  // Called through the Skill tool, typed as /name, or preloaded into a subagent: all count as a use.
  // Claude Code's own security plugin can keep skill.prompt from user plugins, so the first two are read where they start.
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    if (e.tool === 'Skill' && typeof e.skill === 'string') await recordUse($, cwd, e.skill)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const typed = /^\/(\S+)/.exec(e.text.trim())?.[1]
    if (typed && (project.firstSeen[typed] !== undefined || Object.keys(project.firstSeen).some(name => bare(name) === typed))) {
      await recordUse($, cwd, typed)
    }
    return next(e)
  })

  on('skill.prompt', async ($, e, next) => {
    await recordUse($, cwd, e.skill)
    return next(e)
  })

  // Answered with a toast and no text, so the command adds nothing to the conversation.
  on('command.run', { command: 'skill-diet' }, async ($, e) => {
    const [verb, skill] = e.args.trim().split(/\s+/)
    const memory = await recall($)

    if ((verb === 'keep' || verb === 'unkeep') && skill) {
      memory.keep = verb === 'keep' ? [...new Set([...memory.keep, skill])] : memory.keep.filter(s => s !== skill)
      await remember($, memory)
      $.ui.toast(`Skill diet: ${skill} ${verb === 'keep' ? 'stays listed in full' : 'may be listed by name only'} from the next session`)
      return {}
    }
    if (verb === 'on' || verb === 'off') {
      memory.isOff = verb === 'off'
      await remember($, memory)
      $.ui.toast(`Skill diet ${verb} from the next session`)
      return {}
    }

    const chars = removedChars()
    const names = [...hidden].sort()
    const shown = names.slice(0, 6).join(', ') + (names.length > 6 ? ` +${names.length - 6} more` : '')
    $.ui.toast(
      memory.isOff
        ? 'Skill diet is off. /skill-diet on to turn it back on.'
        : hidden.size === 0
          ? 'Skill diet: every skill is listed in full this session.'
          : `${plural(hidden.size, 'skill')} by name only, ${plural(chars, 'character')} off the skill listing. ${shown}`,
      { timeoutMs: 15_000 },
    )
    return {}
  })
}
