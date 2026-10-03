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

export const describeUpdates = (updates: Update[]) =>
  `${MARKETPLACE}: ${updates.length === 1 ? 'an update' : `${updates.length} updates`} available ` +
  `(${updates.map(u => `${u.name} ${u.from} → ${u.to}`).join(', ')}). Run /kit-update.`

async function check($: EngineInterface): Promise<Update[] | undefined> {
  const dir = pluginsDirOf($.plugin.root)
  if (dir === undefined) return undefined
  const installed = JSON.parse(await $.fs.read(`${dir}/installed_plugins.json`)) as Installed
  const response = await $.http.fetch(CATALOG_URL)
  if (!response.ok) return undefined
  return findUpdates(installed, JSON.parse(response.text) as Catalog)
}

async function notify($: EngineInterface) {
  const updates = await check($).catch(() => undefined)
  if (updates === undefined || updates.length === 0) return
  const text = describeUpdates(updates)
  $.ui.toast(text)
  $.ui.log(text)
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'kit-update',
      description: 'Update the installed claude-pro-kit mods to their latest versions',
    })
    void notify($)
    return next(e)
  })

  // Answered with no text: the outcome is shown, not added to the conversation.
  on('command.run', { command: 'kit-update' }, async $ => {
    $.ui.toast(`${MARKETPLACE}: checking for updates…`)
    await install($)
    return {}
  })
}
