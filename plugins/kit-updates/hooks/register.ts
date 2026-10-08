import type { EngineInterface, Register } from 'claude-code'

// Compares the installed claude-pro-kit mods against the marketplace on GitHub
// once per session start and says which ones have a newer version. Nothing is
// sent to the model: the notice is a toast and a dim transcript line.
// /kit-update refreshes the marketplace and updates the outdated mods; the
// engine applies a plugin update on the next restart.

const MARKETPLACE = 'claude-pro-kit'
const CATALOG_URL = 'https://raw.githubusercontent.com/VedantAndhale/claude-pro-kit/main/.claude-plugin/marketplace.json'

export type Update = { name: string; from: string; to: string }

// An installed plugin lives at <plugins dir>/cache/<marketplace>/<name>/<version>.
// A mod loaded from a working copy (--plugin-dir) has no install to compare.
export const pluginsDirOf = (root: string) => {
  const parts = root.split(/[\\/]/)
  const at = parts.lastIndexOf('cache')
  return at > 0 && parts[at + 1] === MARKETPLACE ? parts.slice(0, at).join('/') : undefined
}

export const compareVersions = (a: string, b: string) => {
  const pa = a.split('-')[0].split('.').map(Number)
  const pb = b.split('-')[0].split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return Math.sign(d)
  }
  return 0
}

type Installed = { plugins?: Record<string, { version?: string }[]> }
type Catalog = { plugins?: { name: string; version?: string }[] }

export const findUpdates = (installed: Installed, catalog: Catalog): Update[] =>
  (catalog.plugins ?? []).flatMap(p => {
    const from = installed.plugins?.[`${p.name}@${MARKETPLACE}`]?.[0]?.version
    return from !== undefined && p.version !== undefined && compareVersions(p.version, from) > 0
      ? [{ name: p.name, from, to: p.version }]
      : []
  })

// Mods in the catalog that are not installed and not announced before. The
// first run only records the catalog: a mod someone skipped is never news.
export const findNewMods = (installed: Installed, catalog: Catalog, seen: string[] | undefined) =>
  seen === undefined
    ? []
    : (catalog.plugins ?? [])
        .map(p => p.name)
        .filter(name => !seen.includes(name) && installed.plugins?.[`${name}@${MARKETPLACE}`] === undefined)

export const describeNewMods = (names: string[]) =>
  `${MARKETPLACE}: new ${names.length === 1 ? 'mod' : 'mods'} ${names.join(', ')}. ` +
  `Install with ${names.map(n => `/plugin install ${n}@${MARKETPLACE}`).join(' and ')}.`

export const describeUpdates = (updates: Update[]) =>
  `${MARKETPLACE}: ${updates.length === 1 ? 'an update' : `${updates.length} updates`} available ` +
  `(${updates.map(u => `${u.name} ${u.from} → ${u.to}`).join(', ')}). Run /kit-update.`

async function load($: EngineInterface) {
  const dir = pluginsDirOf($.plugin.root)
  if (dir === undefined) return undefined
  const installed = JSON.parse(await $.fs.read(`${dir}/installed_plugins.json`)) as Installed
  const response = await $.http.fetch(CATALOG_URL)
  if (!response.ok) return undefined
  return { installed, catalog: JSON.parse(response.text) as Catalog }
}

async function check($: EngineInterface): Promise<Update[] | undefined> {
  const got = await load($)
  return got && findUpdates(got.installed, got.catalog)
}

async function notify($: EngineInterface) {
  const got = await load($).catch(() => undefined)
  if (got === undefined) return
  const lines: string[] = []
  const updates = findUpdates(got.installed, got.catalog)
  // On by default: updates to mods you already installed go in by themselves.
  // New mods are only announced unless you opted in with /kit-update auto-new on.
  const isAuto = ((await $.store.get('auto')) as boolean | undefined) ?? true
  const isAutoNew = ((await $.store.get('autoNew')) as boolean | undefined) ?? false
  if (updates.length > 0 && !isAuto) lines.push(describeUpdates(updates))

  const seen = (await $.store.get('seenMods')) as string[] | undefined
  const fresh = findNewMods(got.installed, got.catalog, seen)
  if (fresh.length > 0 && !isAutoNew) lines.push(describeNewMods(fresh))

  // One after the other: both refresh the same marketplace clone.
  void (async () => {
    if (updates.length > 0 && isAuto) await install($)
    if (fresh.length > 0 && isAutoNew) await installNew($, fresh)
  })()
  await $.store.set('seenMods', [...new Set([...(seen ?? []), ...(got.catalog.plugins ?? []).map(p => p.name)])])

  for (const text of lines) {
    $.ui.toast(text)
    $.ui.log(text)
  }
}

async function install($: EngineInterface) {
  const updates = await check($).catch(() => undefined)
  if (updates === undefined) {
    $.ui.log(`${MARKETPLACE}: could not check for updates (no installed copy found, or GitHub unreachable).`)
    return
  }
  if (updates.length === 0) {
    $.ui.log(`${MARKETPLACE}: every installed mod is up to date.`)
    return
  }

  const run = (argv: string[]) => $.process.run(argv, { timeoutMs: 120_000 }).catch(err => ({ exitCode: 1, stdout: '', stderr: String(err) }))

  const refreshed = await run(['claude', 'plugin', 'marketplace', 'update', MARKETPLACE])
  if (refreshed.exitCode !== 0) {
    $.ui.log(`${MARKETPLACE}: marketplace refresh failed: ${refreshed.stderr.trim() || refreshed.stdout.trim()}`)
    return
  }

  const done: string[] = []
  const failed: string[] = []
  for (const u of updates) {
    const result = await run(['claude', 'plugin', 'update', `${u.name}@${MARKETPLACE}`])
    if (result.exitCode === 0) done.push(`${u.name} ${u.to}`)
    else failed.push(`${u.name} (${result.stderr.trim() || result.stdout.trim()})`)
  }

  if (done.length > 0) $.ui.log(`${MARKETPLACE}: updated ${done.join(', ')}. Restart Claude Code to load the new versions.`)
  if (failed.length > 0) $.ui.log(`${MARKETPLACE}: update failed for ${failed.join(', ')}.`)
  $.ui.toast(failed.length === 0 ? `${MARKETPLACE}: updated. Restart to apply.` : `${MARKETPLACE}: some updates failed, see the transcript.`)
}

// Installs mods that joined the kit since the last check. Only mods never seen
// before: one you uninstalled is not put back.
async function installNew($: EngineInterface, names: string[]) {
  const run = (argv: string[]) => $.process.run(argv, { timeoutMs: 120_000 }).catch(err => ({ exitCode: 1, stdout: '', stderr: String(err) }))

  const refreshed = await run(['claude', 'plugin', 'marketplace', 'update', MARKETPLACE])
  if (refreshed.exitCode !== 0) {
    $.ui.log(`${MARKETPLACE}: marketplace refresh failed: ${refreshed.stderr.trim() || refreshed.stdout.trim()}`)
    return
  }

  const done: string[] = []
  const failed: string[] = []
  for (const name of names) {
    const result = await run(['claude', 'plugin', 'install', `${name}@${MARKETPLACE}`])
    if (result.exitCode === 0) done.push(name)
    else failed.push(`${name} (${result.stderr.trim() || result.stdout.trim()})`)
  }

  if (done.length > 0) {
    const text = `${MARKETPLACE}: installed new ${done.length === 1 ? 'mod' : 'mods'} ${done.join(', ')}. Restart Claude Code to load ${done.length === 1 ? 'it' : 'them'}.`
    $.ui.toast(text)
    $.ui.log(text)
  }
  if (failed.length > 0) $.ui.log(`${MARKETPLACE}: install failed for ${failed.join(', ')}.`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'kit-update',
      description: 'Update the installed claude-pro-kit mods now · /kit-update auto on|off · /kit-update auto-new on|off',
    })
    void notify($)
    return next(e)
  })

  // Answered with no text: the outcome is shown, not added to the conversation.
  on('command.run', { command: 'kit-update' }, async ($, e) => {
    const [a, b] = (e.args ?? '').trim().toLowerCase().split(/\s+/)
    if (a === 'auto' && (b === 'on' || b === 'off')) {
      await $.store.set('auto', b === 'on')
      $.ui.toast(b === 'on' ? `${MARKETPLACE}: updates install by themselves at session start.` : `${MARKETPLACE}: updates are announced; /kit-update installs them.`)
      return {}
    }
    if (a === 'auto-new' && (b === 'on' || b === 'off')) {
      await $.store.set('autoNew', b === 'on')
      $.ui.toast(b === 'on' ? `${MARKETPLACE}: new mods install by themselves at session start.` : `${MARKETPLACE}: new mods are announced; installing one stays your choice.`)
      return {}
    }
    $.ui.toast(`${MARKETPLACE}: checking for updates…`)
    await install($)
    return {}
  })
}
