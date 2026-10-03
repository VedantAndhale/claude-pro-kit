import type { EngineInterface, Register } from 'claude-code'

import { TOOLS, diet, textOf } from './diet'
import type { Block } from './diet'

// Rewrites what the model reads from a long shell result, never what the
// person sees: the transcript row keeps its full output on screen, and the
// whole text is saved to a file the model can Read when the trimmed part matters.

const join = (...parts: string[]) => {
  const sep = parts[0]?.includes('\\') ? '\\' : '/'
  return parts.map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p)).join(sep)
}

// Claude Code names a project's transcript folder after its path, every
// character but letters and digits turned into `-` (D:\mods -> D--mods).
const projectSlug = (path: string) => path.replace(/[^A-Za-z0-9]/g, '-')

async function configDir($: EngineInterface): Promise<string | undefined> {
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  if (config !== undefined) return config
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  return home === undefined ? undefined : join(home, '.claude')
}

// Where the untrimmed outputs go. Preferred: the session's own tool-results folder,
// where Claude Code saves the outputs it spills itself and which Claude may read
// without a permission prompt; used once the session's transcript is found there.
// Fallback: <config dir>/output-diet/<session>.
async function saveDir($: EngineInterface): Promise<string | undefined> {
  const config = await configDir($)
  if (config === undefined) return undefined
  const session = await $.session.id()

  for (const project of new Set([await $.session.root(), await $.session.cwd()])) {
    const folder = join(config, 'projects', projectSlug(project))
    if (await $.fs.exists(join(folder, `${session}.jsonl`)).catch(() => false)) {
      return join(folder, session, 'tool-results')
    }
  }

  return join(config, 'output-diet', session)
}

export const register: Register = on => {
  let trimmed = 0
  let charsKeptOut = 0
  let dir: string | undefined

  on('session.append', { door: 'tool-result' }, async ($, e, next) => {
    if (e.origin.kind !== 'tool' || !TOOLS.has(e.origin.tool)) return next(e)
    dir ??= await saveDir($)
    if (dir === undefined) return next(e)

    let changed = false
    const content: Block[] = []
    for (const block of e.message.content as Block[]) {
      const text = block.type === 'tool_result' ? textOf(block.content) : undefined
      if (text === undefined) {
        content.push(block)
        continue
      }
      const path = join(dir, `output-diet-${String(block.tool_use_id ?? e.uuid)}.txt`)
      const slim = diet(text, path)
      if (slim === undefined) {
        content.push(block)
        continue
      }
      // Only trim once the full text is safely on disk.
      const saved = await $.fs.write(path, text).then(() => true, () => false)
      if (!saved) {
        content.push(block)
        continue
      }
      content.push({ ...block, content: slim })
      changed = true
      trimmed += 1
      charsKeptOut += text.length - slim.length
    }

    if (!changed) return next(e)
    $.ui.status(`${trimmed} trimmed · ${charsKeptOut.toLocaleString('en-US')} chars saved`)

    return next({ ...e, message: { ...e.message, content } })
  })
}
