import type { EngineInterface, Register } from 'claude-code'

// Two GitHub accounts logged into gh, one active: a push to a repository the
// other account owns fails, and Claude spends turns on `gh auth status` and
// `gh auth switch`. Before a shell command runs, each `git push|pull|fetch|
// clone|ls-remote` and `gh ...` step is matched to the repository's owner
// (from the URL in the command, `-R owner/repo`, or the folder's remotes),
// and the owner to the one logged-in account that is that owner or a member
// of it. When that account is not gh's active one, the step alone runs with
// its token: `GH_TOKEN="$(gh auth token --user ACCOUNT)"`, so the token itself
// never appears in the command or its output. Nothing is guessed: no owner, no
// single matching account, or anything unclear leaves the command as typed.

const SHELLS = new Set(['Bash', 'PowerShell'])

const GIT_SUBS = new Set(['push', 'pull', 'fetch', 'clone', 'ls-remote'])

// gh subcommands that never reach a repository, or manage the accounts themselves.
const GH_SKIP = new Set(['auth', 'config', 'alias', 'completion', 'help', 'version', 'extension', 'ext', 'status'])

// Options of git push/pull/fetch/clone/ls-remote that take the next token as their value.
const GIT_VALUE_OPTIONS = new Set([
  '-o', '--push-option', '--repo', '--receive-pack', '--exec', '--upload-pack', '-u', '--depth', '-j', '--jobs',
  '--shallow-since', '--shallow-exclude', '--deepen', '--negotiation-tip', '--server-option', '-s', '--strategy',
  '-X', '--strategy-option', '-b', '--branch', '--origin', '--reference', '--reference-if-able',
  '--separate-git-dir', '--template', '-c', '--config', '--filter', '--bundle-uri', '--ref-format', '--sort',
])

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/

const CREDENTIAL = "-c credential.helper= -c 'credential.helper=!gh auth git-credential'"

export type Account = { login: string, active: boolean, fromEnv: boolean }

export type Owner = { owner: string, https: boolean }

// What a step needs to find its repository's owner.
export type Step = {
  kind: 'git' | 'gh'
  sub: string
  // Named in the command itself; `null` when the command names something that is not GitHub.
  named?: Owner | null
  // A remote name given to git; undefined means the folder's remotes decide.
  remote?: string
  // `git -C dir`.
  dir?: string
}

// Splits at top-level `&&`, `||`, `;` and newlines, outside quotes; the
// separators are kept at odd indexes. Undefined for an unclosed quote.
export function segments(command: string): string[] | undefined {
  const out: string[] = []
  let cur = ''
  let quote: string | undefined
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (quote !== undefined) {
      cur += c
      if (c === quote) quote = undefined
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      cur += c
      continue
    }
    const two = command.slice(i, i + 2)
    if (two === '&&' || two === '||') {
      out.push(cur, two)
      cur = ''
      i++
      continue
    }
    if (c === ';' || c === '\n') {
      out.push(cur, c)
      cur = ''
      continue
    }
    cur += c
  }
  if (quote !== undefined) return undefined
  out.push(cur)
  return out
}

function unquoted(text: string): string {
  return text.replace(/'[^']*'|"[^"]*"/g, '""')
}

// Words of one step, quotes removed, up to the first pipe or redirect.
export function words(segment: string): string[] {
  const out: string[] = []
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g
  let cur: string | undefined
  let last = -1
  for (let m = re.exec(segment); m !== null; m = re.exec(segment)) {
    const piece = m[1] ?? m[2] ?? m[3]
    if (m[3] !== undefined && /^(\d?>|<|\||&)/.test(m[3])) break
    if (cur !== undefined && m.index === last) cur += piece
    else {
      if (cur !== undefined) out.push(cur)
      cur = piece
    }
    last = m.index + m[0].length
  }
  if (cur !== undefined) out.push(cur)
  return out
}

// The owner in a GitHub remote URL, and whether git would reach it over https
// (where a credential helper, and so GH_TOKEN, is used at all).
export function githubOwner(url: string): Owner | undefined {
  const https = url.match(/^https?:\/\/(?:[^@/]+@)?github\.com\/([A-Za-z0-9-]+)(?:\/|$)/i)
  if (https !== null) return { owner: https[1], https: true }
  const ssh = url.match(/^(?:ssh:\/\/)?[^@/\s]+@github\.com[:/]([A-Za-z0-9-]+)\//i)
  if (ssh !== null) return { owner: ssh[1], https: false }
  return undefined
}

// `owner/repo`, `github.com/owner/repo` or a URL, as gh's -R takes it.
function repoOwner(value: string): Owner | null {
  const url = githubOwner(value)
  if (url !== undefined) return url
  const m = value.match(/^(?:github\.com\/)?([A-Za-z0-9-]+)\/[A-Za-z0-9._-]+$/i)
  return m !== null ? { owner: m[1], https: true } : null
}

// The first argument that is not an option or an option's value.
function positional(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--') return args[i + 1]
    if (a.startsWith('-')) {
      if (GIT_VALUE_OPTIONS.has(a)) i++
      continue
    }
    return a
  }
  return undefined
}

// What a step needs, or undefined when it is not a step this mod handles.
export function parseStep(segment: string): Step | undefined {
  const w = words(segment)
  if (w[0] === 'git') {
    let i = 1
    let dir: string | undefined
    while (i < w.length && w[i].startsWith('-')) {
      if (w[i] === '-C') {
        dir = w[i + 1]
        i += 2
      } else if (w[i] === '-c') i += 2
      else if (/^--(git-dir|work-tree|namespace)/.test(w[i])) return undefined
      else i++
    }
    const sub = w[i]
    if (sub === undefined || !GIT_SUBS.has(sub)) return undefined
    if (dir !== undefined && /[$~]/.test(dir)) return undefined
    const target = positional(w.slice(i + 1))
    if (sub === 'clone') return { kind: 'git', sub, named: target === undefined ? null : githubOwner(target) ?? null }
    if (target === undefined) return { kind: 'git', sub, dir }
    const url = githubOwner(target)
    if (url !== undefined) return { kind: 'git', sub, named: url, dir }
    if (/[:/\\$]|^\./.test(target)) return { kind: 'git', sub, named: null, dir }
    return { kind: 'git', sub, remote: target, dir }
  }
  if (w[0] === 'gh') {
    const sub = w[1]
    if (sub === undefined || sub.startsWith('-') || GH_SKIP.has(sub)) return undefined
    for (let i = 2; i < w.length; i++) {
      const a = w[i]
      const value = a === '-R' || a === '--repo' ? w[i + 1] : a.startsWith('--repo=') ? a.slice(7) : a.startsWith('-R') && a.length > 2 ? a.slice(2) : undefined
      if (value !== undefined) return { kind: 'gh', sub, named: repoOwner(value) }
    }
    if (sub === 'api') {
      const path = w.slice(2).find(a => !a.startsWith('-'))
      const m = path?.match(/^\/?(?:repos|orgs|users)\/([A-Za-z0-9-]+)(?:\/|$)/)
      if (m) return { kind: 'gh', sub, named: { owner: m[1], https: true } }
    }
    if (sub === 'repo' && w[3] !== undefined && !w[3].startsWith('-')) {
      const named = repoOwner(w[3])
      if (named !== null) return { kind: 'gh', sub, named }
    }
    for (const a of w.slice(2)) {
      const url = githubOwner(a)
      if (url !== undefined) return { kind: 'gh', sub, named: url }
    }
    return { kind: 'gh', sub }
  }
  return undefined
}

// The directory a `cd` step moves to: a string, `null` when it cannot be
// known, undefined when the step is not a directory change.
export function cdTarget(segment: string, base: string): string | null | undefined {
  const w = words(segment)
  if (w.length === 0) return undefined
  const verb = w[0].toLowerCase()
  if (verb === 'pushd' || verb === 'popd' || verb === 'push-location' || verb === 'pop-location') return null
  if (verb !== 'cd' && verb !== 'set-location' && verb !== 'sl' && verb !== 'chdir') return undefined
  const args = w.slice(1).filter(a => a.toLowerCase() !== '-path' && a.toLowerCase() !== '-literalpath')
  if (args.length !== 1) return null
  return resolveDir(base, args[0])
}

export function resolveDir(base: string, path: string): string | null {
  if (path === '-' || /[$~*?%]/.test(path) || path.startsWith('-')) return null
  // Git Bash's `/d/repo` is `D:/repo`, on Windows only.
  const drive = /^[a-zA-Z]:/.test(base) ? path.match(/^\/([a-zA-Z])(\/.*)?$/) : null
  if (drive !== null) return `${drive[1].toUpperCase()}:${drive[2] ?? '/'}`
  if (/^([a-zA-Z]:)?[\\/]/.test(path)) return path
  return `${base.replace(/[\\/]+$/, '')}/${path}`
}

// `gh auth status --json hosts`, or the plain text older gh versions print.
export function parseAccounts(output: string): Account[] {
  try {
    const parsed = JSON.parse(output) as { hosts?: Record<string, { login?: string, active?: boolean, state?: string, tokenSource?: string }[]> }
    const list = parsed.hosts?.['github.com']
    if (Array.isArray(list)) {
      return list
        .filter(a => typeof a.login === 'string' && LOGIN.test(a.login) && (a.state === undefined || a.state === 'success'))
        .map(a => ({ login: a.login as string, active: a.active === true, fromEnv: /TOKEN$/.test(a.tokenSource ?? '') }))
    }
  } catch {
    // Plain text below.
  }
  const out: Account[] = []
  let host = ''
  for (const line of output.split(/\r?\n/)) {
    if (/^\S/.test(line)) host = line.trim()
    const m = line.match(/Logged in to (\S+) account (\S+)(?: \((\S+)\))?/)
    if (m !== null) {
      if (m[1] === 'github.com' && LOGIN.test(m[2])) out.push({ login: m[2], active: false, fromEnv: /TOKEN$/.test(m[3] ?? '') })
      continue
    }
    if (host === 'github.com' && /Active account: true/.test(line) && out.length > 0) out[out.length - 1].active = true
  }
  return out
}

// The account for an owner: the one whose login is the owner, else the one
// account that is a member of it. `orgs` absent checks the login alone; any
// account's orgs unknown means no answer.
export function pickAccount(owner: string, accounts: readonly Account[], orgs?: Readonly<Record<string, readonly string[] | undefined>>): string | undefined {
  const lower = owner.toLowerCase()
  const self = accounts.find(a => a.login.toLowerCase() === lower)
  if (self !== undefined) return self.login
  if (orgs === undefined || accounts.some(a => orgs[a.login] === undefined)) return undefined
  const members = accounts.filter(a => orgs[a.login]?.some(o => o.toLowerCase() === lower))
  return members.length === 1 ? members[0].login : undefined
}

// The step run as `account`; git also asks gh for the credential.
export function rewriteStep(segment: string, kind: 'git' | 'gh', account: string, shell: string): string {
  const lead = segment.match(/^\s*/)?.[0] ?? ''
  const trail = segment.match(/\s*$/)?.[0] ?? ''
  let body = segment.slice(lead.length, segment.length - trail.length)
  if (kind === 'git') body = `git ${CREDENTIAL}${body.slice(3)}`
  if (shell === 'PowerShell') {
    return `${lead}$ghAccountPrev = $env:GH_TOKEN; try { $env:GH_TOKEN = (gh auth token --user ${account}); ${body} } finally { $env:GH_TOKEN = $ghAccountPrev }${trail}`
  }
  return `${lead}GH_TOKEN="$(gh auth token --user ${account})" ${body}${trail}`
}

// Commands this mod leaves whole: a token already chosen, or shell syntax
// (subshells, substitutions, blocks) where steps and folders cannot be read exactly.
export function untouchable(command: string, shell: string): boolean {
  if (/GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN/.test(command)) return true
  const bare = unquoted(command)
  return shell === 'PowerShell' ? /[{}()`]/.test(bare) : /[()`{}]|\$\(/.test(bare)
}

type Remote = { name: string, fetch?: string, push?: string }

export function parseRemotes(output: string): Remote[] {
  const byName = new Map<string, Remote>()
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/)
    if (m === null) continue
    const remote = byName.get(m[1]) ?? { name: m[1] }
    remote[m[3] as 'fetch' | 'push'] = m[2]
    byName.set(m[1], remote)
  }
  return [...byName.values()]
}

// The owner a step reaches from the folder's remotes: the named remote, or
// every remote when none is named, and then only if they all agree.
export function remoteOwner(step: Step, remotes: readonly Remote[]): Owner | undefined {
  const urlOf = (r: Remote) => (step.sub === 'push' ? r.push ?? r.fetch : r.fetch ?? r.push)
  if (step.remote !== undefined) {
    const r = remotes.find(x => x.name === step.remote)
    const url = r === undefined ? undefined : urlOf(r)
    return url === undefined ? undefined : githubOwner(url)
  }
  const owners = remotes.map(r => {
    const url = urlOf(r)
    return url === undefined ? undefined : githubOwner(url)
  })
  if (owners.length === 0 || owners.some(o => o === undefined)) return undefined
  const first = owners[0] as Owner
  const same = owners.every(o => o!.owner.toLowerCase() === first.owner.toLowerCase() && o!.https === first.https)
  return same ? first : undefined
}

export function describeMap(map: Readonly<Record<string, string>>): string {
  const pairs = Object.entries(map).sort(([a], [b]) => a.localeCompare(b))
  if (pairs.length === 0) return 'gh-account: nothing learned yet'
  return `gh-account: ${pairs.map(([owner, account]) => `${owner} -> ${account}`).join(', ')}`
}

export function describeSent(sent: ReadonlyMap<string, number>): string {
  return [...sent].map(([account, n]) => `${n} ${n === 1 ? 'command' : 'commands'} sent as ${account}`).join(' · ')
}

const STORE_KEY = 'owners'

// What one session has read: accounts, remotes per folder, orgs per account,
// owners no account matched, and how many commands went out as whom.
type State = {
  accounts?: Promise<Account[]>
  remotes: Map<string, Promise<Remote[] | undefined>>
  orgs: Map<string, Promise<string[] | undefined>>
  misses: Set<string>
  sent: Map<string, number>
}

function run($: EngineInterface, argv: string[], init: { cwd?: string, env?: Record<string, string> } = {}) {
  return $.process.run(argv, { ...init, timeoutMs: 15_000 }).catch(() => ({ exitCode: 1, stdout: '', stderr: '' }))
}

function listAccounts($: EngineInterface, state: State): Promise<Account[]> {
  state.accounts ??= (async () => {
    const json = await run($, ['gh', 'auth', 'status', '--json', 'hosts'])
    if (json.exitCode === 0) {
      const found = parseAccounts(json.stdout)
      if (found.length > 0) return found
    }
    const text = await run($, ['gh', 'auth', 'status'])
    return parseAccounts(`${text.stdout}\n${text.stderr}`)
  })()
  return state.accounts
}

function remotesOf($: EngineInterface, state: State, dir: string): Promise<Remote[] | undefined> {
  let found = state.remotes.get(dir)
  if (found === undefined) {
    found = run($, ['git', 'remote', '-v'], { cwd: dir }).then(r => (r.exitCode === 0 ? parseRemotes(r.stdout) : undefined))
    state.remotes.set(dir, found)
  }
  return found
}

// The token stays inside this call: handed to `gh api` as its environment only.
function orgsOf($: EngineInterface, state: State, login: string): Promise<string[] | undefined> {
  let found = state.orgs.get(login)
  if (found === undefined) {
    found = (async () => {
      const token = await run($, ['gh', 'auth', 'token', '--user', login])
      const value = token.stdout.trim()
      if (token.exitCode !== 0 || value === '') return undefined
      const listed = await run($, ['gh', 'api', 'user/orgs', '--paginate', '--jq', '.[].login'], { env: { GH_TOKEN: value } })
      return listed.exitCode === 0 ? listed.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean) : undefined
    })()
    state.orgs.set(login, found)
  }
  return found
}

async function learned($: EngineInterface): Promise<Record<string, string>> {
  return ((await $.store.get(STORE_KEY)) ?? {}) as Record<string, string>
}

// The login match first, then an owner learned in an earlier session (still
// logged in), then the org lists; the answer is kept in the store.
async function accountFor($: EngineInterface, state: State, owner: string, list: Account[]): Promise<string | undefined> {
  const key = owner.toLowerCase()
  let chosen = pickAccount(owner, list)
  const map = await learned($)
  if (chosen === undefined && map[key] !== undefined && list.some(a => a.login === map[key])) chosen = map[key]
  if (chosen === undefined && !state.misses.has(key)) {
    const known: Record<string, string[] | undefined> = {}
    for (const a of list) known[a.login] = await orgsOf($, state, a.login)
    chosen = pickAccount(owner, list, known)
  }
  if (chosen === undefined) {
    state.misses.add(key)
    return undefined
  }
  if (map[key] !== chosen) await $.store.set(STORE_KEY, { ...map, [key]: chosen })
  return chosen
}

async function rewriteCommand($: EngineInterface, state: State, command: string, shell: string): Promise<{ command: string, account: string } | undefined> {
  if (untouchable(command, shell)) return undefined
  const parts = segments(command)
  if (parts === undefined) return undefined

  let cwd: string | undefined
  let dir: string | null | undefined
  let list: Account[] | undefined
  let account: string | undefined

  for (let i = 0; i < parts.length; i += 2) {
    const part = parts[i]
    const body = part.trimStart()
    const base = dir === undefined ? (cwd ??= await $.session.cwd()) : dir
    if (base !== null) {
      const moved = cdTarget(body, base)
      if (moved !== undefined) {
        dir = moved
        continue
      }
    } else if (cdTarget(body, '.') !== undefined) continue

    const step = parseStep(body)
    if (step === undefined) continue

    let owner: Owner | undefined
    if (step.named !== undefined) owner = step.named ?? undefined
    else if (base !== null) {
      const where = step.dir === undefined ? base : resolveDir(base, step.dir)
      const found = where === null ? undefined : await remotesOf($, state, where)
      owner = found === undefined ? undefined : remoteOwner(step, found)
    }
    if (owner === undefined || (step.kind === 'git' && !owner.https)) continue

    list ??= await listAccounts($, state)
    if (list.length === 0 || list.some(a => a.fromEnv)) return undefined
    const chosen = await accountFor($, state, owner.owner, list)
    if (chosen === undefined || list.find(a => a.active)?.login === chosen) continue

    parts[i] = rewriteStep(part, step.kind, chosen, shell)
    account = chosen
  }

  return account !== undefined ? { command: parts.join(''), account } : undefined
}

export const register: Register = on => {
  const state: State = { remotes: new Map(), orgs: new Map(), misses: new Set(), sent: new Map() }

  on('session.start', async ($, e, next) => {
    state.accounts = undefined
    state.remotes.clear()
    state.orgs.clear()
    state.misses.clear()
    state.sent.clear()
    await $.command.register({
      name: 'gh-account',
      description: 'gh-account: /gh-account shows which account each GitHub owner uses · forget clears it',
    })
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (!SHELLS.has(e.tool) || typeof e.command !== 'string') return next(e)
    const command = e.command

    const changed = await rewriteCommand($, state, command, e.tool).catch(() => undefined)
    const ran = await next(changed === undefined ? e : { ...e, command: changed.command })

    // An account switch, login or logout, or a remote added or moved: read them again.
    if (/\bgh\s+auth\s+(switch|login|logout|refresh)\b/.test(command)) {
      state.accounts = undefined
      state.orgs.clear()
      state.misses.clear()
    }
    if (/\bgit\b[^;&|\n]*\b(remote|clone|init)\b/.test(command)) state.remotes.clear()

    if (changed !== undefined && ran.deny === undefined) {
      state.sent.set(changed.account, (state.sent.get(changed.account) ?? 0) + 1)
      $.ui.status(describeSent(state.sent))
    }
    return ran
  })

  // Answered as a toast: nothing is added to the conversation.
  on('command.run', { command: 'gh-account' }, async ($, e) => {
    const args = (e.args ?? '').trim()
    if (args === '') {
      $.ui.toast(describeMap(await learned($)))
      return {}
    }
    if (args === 'forget') {
      const count = Object.keys(await learned($)).length
      await $.store.delete(STORE_KEY)
      state.orgs.clear()
      state.misses.clear()
      $.ui.toast(`gh-account: forgot ${count} ${count === 1 ? 'owner' : 'owners'}`)
      return {}
    }
    $.ui.toast('gh-account: use /gh-account to list, /gh-account forget to clear')
    return {}
  })
}
