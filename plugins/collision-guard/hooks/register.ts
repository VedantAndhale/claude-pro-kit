import type { EngineInterface, Register } from 'claude-code'

import {
  CANCEL,
  DEFAULTS,
  EDIT_TOOLS,
  PROCEED,
  PROCEED_FILE,
  cancelNote,
  choiceOf,
  describeRecent,
  findCollision,
  keyOf,
  parse,
  prune,
  question,
  recentElsewhere,
} from './guard'
import type { Ledger, Settings } from './guard'

// Before Claude edits a file, checks whether another chat on this machine
// edited the same file within the window, and asks first. Each chat keeps its
// own ledger file, so two chats never write the same file. No model calls and
// no network; the only text Claude ever reads is one line after a Cancel.

const join = (...parts: string[]) => parts.map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p)).join('/')

async function ledgerDir($: EngineInterface): Promise<string | undefined> {
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  const base = config ?? (home === undefined ? undefined : join(home, '.claude'))
  return base === undefined ? undefined : join(base, 'collision-guard')
}

async function settingsOf($: EngineInterface): Promise<Settings> {
  return { ...DEFAULTS, ...((await $.store.get('settings')) as Partial<Settings> | undefined) }
}

// Other chats' ledgers that changed inside the window; older files are skipped
// unread, so a folder of old ledgers costs one listing.
async function readOthers($: EngineInterface, dir: string, own: string, settings: Settings, now: number): Promise<Ledger[]> {
  const entries = await $.fs.list(dir).catch(() => [])
  const fresh = entries.filter(
    e => e.kind === 'file' && e.name.endsWith('.json') && e.name !== `${own}.json` && now - e.mtimeMs <= settings.windowMin * 60_000,
  )
  const ledgers: Ledger[] = []
  for (const e of fresh) {
    const text = await $.fs.read(join(dir, e.name)).catch(() => undefined)
    if (typeof text !== 'string') continue
    try {
      const ledger = JSON.parse(text) as Ledger
      if (ledger && typeof ledger.files === 'object') ledgers.push(ledger)
    } catch {
      // A ledger caught mid-write by the other chat: it is read again on the next edit.
    }
  }
  return ledgers
}

async function realKey($: EngineInterface, path: string) {
  const stat = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
  return { key: keyOf(stat?.realPath ?? path), mtimeMs: stat?.kind === 'file' ? stat.mtimeMs : undefined }
}

// This chat's own state; a reload starts it over and the next edit rebuilds it.
const me = {
  session: '',
  cwd: '',
  dir: undefined as string | undefined,
  ledger: undefined as Ledger | undefined,
  // Files the person said to go ahead with, and the other chat's edit time then.
  approved: new Map<string, number>(),
}

async function ensure($: EngineInterface): Promise<Ledger> {
  if (me.ledger) return me.ledger
  me.session = await $.session.id()
  me.cwd = await $.session.cwd()
  me.dir = await ledgerDir($)
  me.ledger = { session: me.session, cwd: me.cwd, files: {} }
  return me.ledger
}

export const register: Register = on => {

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'collisions',
      description: 'Collision guard: /collisions · /collisions <minutes> · /collisions off|on',
    })
    await ensure($)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (!EDIT_TOOLS.has(e.tool)) return next(e)
    const path = (e as { file_path?: unknown; notebook_path?: unknown }).file_path ?? (e as { notebook_path?: unknown }).notebook_path
    if (typeof path !== 'string') return next(e)

    const own = await ensure($)
    const settings = await settingsOf($)
    if (settings.isOff || me.dir === undefined) return next(e)

    const now = await $.clock.now()
    const { key, mtimeMs } = await realKey($, path)
    const others = await readOthers($, me.dir, me.session, settings, now)
    const hit = findCollision(others, key, now, settings)

    if (hit && me.approved.get(key) !== hit.at) {
      let answer: string | undefined
      try {
        answer = await $.ui.ask(question(path, hit, now, mtimeMs), {
          options: [PROCEED, PROCEED_FILE, CANCEL],
          header: 'Collision',
        })
      } catch {
        // Nobody to ask (a -p run, a dismissed dialog): the edit goes ahead.
        $.ui.status('collision not asked: another chat edited a file this chat changed')
      }
      if (answer !== undefined) {
        const choice = choiceOf(answer)
        if (choice === 'cancel') return { deny: cancelNote(path, hit, now) }
        if (choice === 'file') me.approved.set(key, hit.at)
      }
    }

    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      const after = await realKey($, path)
      own.files[after.key] = { at: await $.clock.now(), mtimeMs: after.mtimeMs ?? 0, path }
      me.ledger = prune(own, now, settings)
      await $.fs.write(join(me.dir, `${me.session}.json`), JSON.stringify(me.ledger)).catch(() => undefined)
    }
    const chats = new Set(others.filter(l => recentElsewhere([l], me.cwd, now, settings).length > 0).map(l => l.session)).size
    $.ui.status(chats > 0 ? `${chats} other ${chats === 1 ? 'chat' : 'chats'} active here` : undefined)
    return ran
  })

  // Answered with a toast and no text, so the command adds nothing to the conversation.
  on('command.run', { command: 'collisions' }, async ($, e) => {
    await ensure($)
    const current = await settingsOf($)
    const changed = parse(e.args, current)
    if (changed) await $.store.set('settings', changed)
    const settings = changed ?? current
    const now = await $.clock.now()
    const others = me.dir ? await readOthers($, me.dir, me.session, settings, now) : []
    const shown = describeRecent(recentElsewhere(others, me.cwd, now, settings), now, settings)
    $.ui.toast(changed && !changed.isOff ? `Collision guard: asks about edits from the last ${settings.windowMin} min. ${shown}` : shown, {
      timeoutMs: 12_000,
    })
    return {}
  })
}
