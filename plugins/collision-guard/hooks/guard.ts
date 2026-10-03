// The collision arithmetic: pure, so the tests exercise it directly.

export type Settings = { windowMin: number; isOff: boolean }
export const DEFAULTS: Settings = { windowMin: 30, isOff: false }

/** One chat's record: the files it edited, when, and the file's mtime right after. */
export type Ledger = {
  session: string
  cwd: string
  files: Record<string, { at: number; mtimeMs: number; path?: string }>
}

export type Collision = { session: string; cwd: string; at: number; mtimeMs: number }

export const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

/** One key per file however it is spelled: forward slashes, and lower case on Windows drives. */
export const keyOf = (path: string) => {
  const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[a-z]:\//i.test(slashed) ? slashed.toLowerCase() : slashed
}

/** The most recent edit of `key` by another chat inside the window, if any. */
export const findCollision = (others: Ledger[], key: string, now: number, settings: Settings): Collision | undefined => {
  const windowMs = settings.windowMin * 60_000
  let best: Collision | undefined
  for (const ledger of others) {
    const entry = ledger.files[key]
    if (!entry || now - entry.at > windowMs) continue
    if (!best || entry.at > best.at) best = { session: ledger.session, cwd: ledger.cwd, at: entry.at, mtimeMs: entry.mtimeMs }
  }
  return best
}

export const age = (ms: number) => {
  const m = Math.floor(Math.max(0, ms) / 60_000)
  return m < 1 ? 'less than a minute ago' : m === 1 ? '1 min ago' : `${m} min ago`
}

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path
const folderOf = (cwd: string) => cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd

/** A file whose mtime moved more than 2s past the other chat's edit was changed since. */
export const isChangedSince = (hit: Collision, currentMtimeMs: number | undefined) =>
  currentMtimeMs !== undefined && currentMtimeMs > hit.mtimeMs + 2_000

export const question = (path: string, hit: Collision, now: number, currentMtimeMs: number | undefined) =>
  `${baseName(path)} was ${isChangedSince(hit, currentMtimeMs) ? 'last changed by another chat' : 'changed by another chat'} ` +
  `${age(now - hit.at)}${isChangedSince(hit, currentMtimeMs) ? ', and modified since' : ''} ` +
  `(chat ${hit.session.slice(0, 8)} in ${folderOf(hit.cwd)}). Edit it anyway?`

export const PROCEED = 'Proceed'
export const PROCEED_FILE = 'Proceed for this file'
export const CANCEL = 'Cancel'

export type Choice = 'proceed' | 'file' | 'cancel'

/** Anything but a Proceed label cancels: an unclear answer leaves the file alone. */
export const choiceOf = (answer: string): Choice =>
  answer === PROCEED ? 'proceed' : answer === PROCEED_FILE ? 'file' : 'cancel'

export const cancelNote = (path: string, hit: Collision, now: number) =>
  `${baseName(path)} was changed ${age(now - hit.at)} in another chat; the user chose not to edit it. Re-read it, then ask how to proceed.`

/** Drops entries older than the window, so a ledger stays small. */
export const prune = (ledger: Ledger, now: number, settings: Settings): Ledger => ({
  ...ledger,
  files: Object.fromEntries(Object.entries(ledger.files).filter(([, v]) => now - v.at <= settings.windowMin * 60_000)),
})

/** `/collisions 15`, `/collisions off|on`; undefined for anything else. */
export const parse = (args: string, settings: Settings): Settings | undefined => {
  const a = args.trim().toLowerCase()
  if (a === 'off' || a === 'on') return { ...settings, isOff: a === 'off' }
  if (/^\d+$/.test(a) && Number(a) >= 1 && Number(a) <= 1440) return { ...settings, windowMin: Number(a) }
  return undefined
}

/** The files other chats edited in this folder inside the window, newest first. */
export const recentElsewhere = (others: Ledger[], cwd: string, now: number, settings: Settings) => {
  const here = keyOf(cwd)
  const rows: { file: string; at: number }[] = []
  for (const ledger of others) {
    for (const [file, v] of Object.entries(ledger.files)) {
      if (file.startsWith(`${here}/`) && now - v.at <= settings.windowMin * 60_000) rows.push({ file: v.path ?? file, at: v.at })
    }
  }
  return rows.sort((a, b) => b.at - a.at)
}

export const describeRecent = (rows: { file: string; at: number }[], now: number, settings: Settings) => {
  if (settings.isOff) return 'Collision guard is off. /collisions on to turn it back on.'
  if (rows.length === 0) return `No other chat edited files in this folder in the last ${settings.windowMin} min.`
  const shown = rows.slice(0, 5).map(r => `${baseName(r.file)} ${age(now - r.at)}`)
  const more = rows.length > 5 ? ` +${rows.length - 5} more` : ''
  return `Changed by other chats in the last ${settings.windowMin} min: ${shown.join(' · ')}${more}`
}
