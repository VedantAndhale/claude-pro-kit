import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { describeMap, githubOwner, parseAccounts, parseStep, pickAccount, rewriteStep, segments } from '../hooks/register.ts'

const PERSONAL = 'VedantAndhale'
const WORK = 'vedant-agntworksai'
const TOKENS: Record<string, string> = { [PERSONAL]: 'gho_personalFAKE', [WORK]: 'gho_workFAKE' }

const CRED = "-c credential.helper= -c 'credential.helper=!gh auth git-credential'"
const asWork = `GH_TOKEN="$(gh auth token --user ${WORK})"`

// `gh auth status --json hosts` as gh 2.96 prints it.
const statusJson = (active: string) => JSON.stringify({
  hosts: {
    'github.com': [PERSONAL, WORK].map(login => ({
      state: 'success', active: login === active, host: 'github.com', login, tokenSource: 'keyring', gitProtocol: 'https',
    })),
  },
})

// `gh auth status` as plain text, as gh 2.96 prints it (tokens masked by gh).
const STATUS_TEXT = [
  'github.com',
  `  ✓ Logged in to github.com account ${PERSONAL} (keyring)`,
  '  - Active account: true',
  '  - Git operations protocol: https',
  "  - Token: gho_************************************",
  '',
  `  ✓ Logged in to github.com account ${WORK} (keyring)`,
  '  - Active account: false',
  '  - Git operations protocol: https',
].join('\n')

// The engine's side: gh and git answered from fixed data, every process and
// shell command recorded, a store, toasts and the status line.
const engine = (on: On, opts: { active?: string, remotes?: Record<string, string>, store?: Record<string, unknown> } = {}) => {
  const active = opts.active ?? PERSONAL
  const remotes = opts.remotes ?? { 'D:/work': 'https://github.com/agntworksai/app.git', 'D:/mine': 'https://github.com/VedantAndhale/notes.git' }
  const orgs: Record<string, string[]> = { [TOKENS[PERSONAL]]: ['some-oss'], [TOKENS[WORK]]: ['agntworksai'] }
  const store = new Map<string, unknown>(Object.entries(opts.store ?? {}))
  const sent = { ran: [] as string[], processes: [] as string[], toasts: [] as string[], status: [] as string[], store }
  const ok = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never

  on('session.cwd', () => ({ value: 'D:/work' }))
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    sent.status.push(String((e as { text?: unknown }).text ?? e))
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    sent.toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', () => ({ value: undefined }))
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    const line = argv.join(' ')
    sent.processes.push(line)
    if (line === 'gh auth status --json hosts') return ok(statusJson(active))
    if (line.startsWith('gh auth token --user ')) return ok(`${TOKENS[argv[4]] ?? ''}\n`, TOKENS[argv[4]] ? 0 : 1)
    if (line.startsWith('gh api user/orgs')) {
      const listed = orgs[e.init?.env?.GH_TOKEN ?? '']
      return listed === undefined ? ok('', 1) : ok(listed.map(o => `${o}\n`).join(''))
    }
    if (line === 'git remote -v') {
      const url = remotes[e.init?.cwd ?? '']
      return url === undefined ? ok('', 128) : ok(`origin\t${url} (fetch)\norigin\t${url} (push)\n`)
    }
    return ok('', 1)
  })
  for (const tool of ['Bash', 'PowerShell'] as const) {
    on('tool.call', { tool }, (_$, e) => {
      sent.ran.push(String(e.command))
      return { result: { stdout: 'ok' } as never }
    })
  }
  return sent
}

const bash = (command: string) => ({ tool: 'Bash' as const, command })
const pwsh = (command: string) => ({ tool: 'PowerShell' as const, command }) as never

const noToken = (sent: { ran: string[], toasts: string[], status: string[] }) => {
  for (const text of [...sent.ran, ...sent.toasts, ...sent.status]) {
    for (const token of Object.values(TOKENS)) expect(text.includes(token)).toBe(false)
  }
}

describe('gh-account helpers', () => {
  test('reads both gh auth status formats', () => {
    const expected = [
      { login: PERSONAL, active: true, fromEnv: false },
      { login: WORK, active: false, fromEnv: false },
    ]
    expect(parseAccounts(statusJson(PERSONAL))).toEqual(expected)
    expect(parseAccounts(STATUS_TEXT)).toEqual(expected)
  })

  test('finds the owner in GitHub URLs only', () => {
    expect(githubOwner('https://github.com/agntworksai/app.git')).toEqual({ owner: 'agntworksai', https: true })
    expect(githubOwner('git@github.com:VedantAndhale/notes.git')).toEqual({ owner: 'VedantAndhale', https: false })
    expect(githubOwner('https://gitlab.com/agntworksai/app.git')).toBe(undefined)
  })

  test('picks the login, else the one member, never a guess', () => {
    const list = parseAccounts(statusJson(PERSONAL))
    expect(pickAccount('vedantandhale', list)).toBe(PERSONAL)
    expect(pickAccount('agntworksai', list)).toBe(undefined)
    expect(pickAccount('agntworksai', list, { [PERSONAL]: [], [WORK]: ['agntworksai'] })).toBe(WORK)
    expect(pickAccount('shared', list, { [PERSONAL]: ['shared'], [WORK]: ['shared'] })).toBe(undefined)
    expect(pickAccount('agntworksai', list, { [PERSONAL]: [], [WORK]: undefined })).toBe(undefined)
  })

  test('parses the steps it handles and skips gh auth', () => {
    expect(parseStep('gh auth status')).toBe(undefined)
    expect(parseStep('gh auth switch --user x')).toBe(undefined)
    expect(parseStep('git status')).toBe(undefined)
    expect(parseStep('git push origin main')).toEqual({ kind: 'git', sub: 'push', remote: 'origin', dir: undefined })
    expect(parseStep('git clone https://github.com/agntworksai/app.git')?.named).toEqual({ owner: 'agntworksai', https: true })
    expect(parseStep('gh pr list -R agntworksai/app')?.named).toEqual({ owner: 'agntworksai', https: true })
    expect(parseStep('gh issue list --repo=agntworksai/app')?.named).toEqual({ owner: 'agntworksai', https: true })
  })

  test('splits chains outside quotes', () => {
    expect(segments('git commit -m "a && b" && git push')).toEqual(['git commit -m "a && b" ', '&&', ' git push'])
    expect(segments('echo "open')).toBe(undefined)
  })

  test('writes the Bash and PowerShell forms', () => {
    expect(rewriteStep(' git push', 'git', WORK, 'Bash')).toBe(` ${asWork} git ${CRED} push`)
    expect(rewriteStep('gh pr list', 'gh', WORK, 'Bash')).toBe(`${asWork} gh pr list`)
    expect(rewriteStep('gh pr list', 'gh', WORK, 'PowerShell')).toBe(
      `$ghAccountPrev = $env:GH_TOKEN; try { $env:GH_TOKEN = (gh auth token --user ${WORK}); gh pr list } finally { $env:GH_TOKEN = $ghAccountPrev }`,
    )
  })

  test('describes the learned map', () => {
    expect(describeMap({})).toBe('gh-account: nothing learned yet')
    expect(describeMap({ agntworksai: WORK, 'some-oss': PERSONAL })).toBe(`gh-account: agntworksai -> ${WORK}, some-oss -> ${PERSONAL}`)
  })
})

describe('gh-account hook', () => {
  test('a work-org repo with the personal account active runs as the work account', async ($, on) => {
    const sent = engine(on)
    await $.tool.call(bash('git push origin main'))
    await $.tool.call(bash('gh pr create --fill'))

    expect(sent.ran).toEqual([
      `${asWork} git ${CRED} push origin main`,
      `${asWork} gh pr create --fill`,
    ])
    expect(sent.store.get('owners')).toEqual({ agntworksai: WORK })
    expect(sent.status.at(-1)).toContain(`2 commands sent as ${WORK}`)
    noToken(sent)
  })

  test('no rewrite when the active account already matches', async ($, on) => {
    const sent = engine(on, { active: WORK })
    await $.tool.call(bash('git push'))

    expect(sent.ran).toEqual(['git push'])
    expect(sent.status).toEqual([])
  })

  test('no rewrite when no account is the owner or a member of it', async ($, on) => {
    const sent = engine(on, { remotes: { 'D:/work': 'https://github.com/stranger/lib.git' } })
    await $.tool.call(bash('git pull'))
    await $.tool.call(bash('git fetch'))

    expect(sent.ran).toEqual(['git pull', 'git fetch'])
    expect(sent.store.get('owners')).toBe(undefined)
    // The miss is remembered: the org lists are asked once.
    expect(sent.processes.filter(p => p.startsWith('gh api user/orgs')).length).toBe(2)
  })

  test('gh auth, a chosen GH_TOKEN, ssh remotes and other hosts are left as typed', async ($, on) => {
    const sent = engine(on, { remotes: { 'D:/work': 'git@github.com:agntworksai/app.git' } })
    const commands = [
      'gh auth status',
      'gh auth switch --user vedant-agntworksai',
      'GH_TOKEN=x gh pr list -R agntworksai/app',
      'git push',
      'git clone https://gitlab.com/agntworksai/app.git',
    ]
    for (const command of commands) await $.tool.call(bash(command))

    expect(sent.ran).toEqual(commands)
  })

  test('a chain rewrites only the git push step', async ($, on) => {
    const sent = engine(on)
    await $.tool.call(bash('git add . && git commit -m "ship it" && git push'))

    expect(sent.ran).toEqual([`git add . && git commit -m "ship it" && ${asWork} git ${CRED} push`])
  })

  test('cd in the chain decides the folder', async ($, on) => {
    const sent = engine(on)
    await $.tool.call(bash('cd /d/mine && git push && cd /d/work && git push'))

    expect(sent.ran).toEqual([`cd /d/mine && git push && cd /d/work && ${asWork} git ${CRED} push`])
  })

  test('clone URL and gh -R name the owner themselves', async ($, on) => {
    const sent = engine(on, { remotes: {} })
    await $.tool.call(bash('git clone https://github.com/agntworksai/app.git'))
    await $.tool.call(bash('gh issue list -R agntworksai/app'))

    expect(sent.ran).toEqual([
      `${asWork} git ${CRED} clone https://github.com/agntworksai/app.git`,
      `${asWork} gh issue list -R agntworksai/app`,
    ])
  })

  test('PowerShell runs the step with the token set, then restores it', async ($, on) => {
    const sent = engine(on)
    await $.tool.call(pwsh('git status; git push'))

    expect(sent.ran).toEqual([
      `git status; $ghAccountPrev = $env:GH_TOKEN; try { $env:GH_TOKEN = (gh auth token --user ${WORK}); git ${CRED} push } finally { $env:GH_TOKEN = $ghAccountPrev }`,
    ])
    noToken(sent)
  })

  test('a learned owner skips the org lookup in a later session', async ($, on) => {
    const sent = engine(on, { store: { owners: { agntworksai: WORK } } })
    await $.tool.call(bash('git push'))

    expect(sent.ran).toEqual([`${asWork} git ${CRED} push`])
    expect(sent.processes.some(p => p.startsWith('gh api') || p.startsWith('gh auth token'))).toBe(false)
  })

  test('/gh-account lists the map and forget clears it, as toasts', async ($, on) => {
    const sent = engine(on, { store: { owners: { agntworksai: WORK } } })
    const listed = await $.command.run({ command: 'gh-account', args: '' } as never)
    const forgot = await $.command.run({ command: 'gh-account', args: 'forget' } as never)
    await $.command.run({ command: 'gh-account', args: '' } as never)

    expect(listed).toEqual({})
    expect(forgot).toEqual({})
    expect(sent.toasts).toEqual([
      `gh-account: agntworksai -> ${WORK}`,
      'gh-account: forgot 1 owner',
      'gh-account: nothing learned yet',
    ])
  })
})
