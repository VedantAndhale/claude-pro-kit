import type { Register } from 'claude-code'

// Some commands print pages of progress lines Claude has to read. Before a
// shell command runs, known noisy ones get their own quiet flags, which drop
// the progress lines and keep errors, failures and warnings. Only a plain
// command is touched: one that pipes, redirects or substitutes is left alone,
// since something else reads its output. If a tool rejects a flag (an old
// version), that rule stops for the session and Claude's retry runs as typed.

type Rule = {
  name: string
  // The command's start; flags go right after it, before any `--`.
  prefix: RegExp
  // Each entry is a flag and its spellings; one already present is not added.
  add: string[][]
  // A token that means the person chose the output level: leave the command alone.
  conflicts: RegExp
  bashOnly?: boolean
}

const RULES: Rule[] = [
  {
    name: 'git status',
    prefix: /^git\s+status(?=\s|$)/,
    add: [['--short', '-s'], ['--branch', '-b']],
    conflicts: /^(--porcelain.*|-v+|--verbose|--long|-z)$/,
  },
  {
    name: 'pytest',
    prefix: /^(pytest|py\.test|python3?\s+-m\s+pytest|py\s+-m\s+pytest|uv\s+run\s+pytest)(?=\s|$)/,
    add: [['-q']],
    conflicts: /^(-[a-zA-Z]*[qv][a-zA-Z]*|--quiet|--verbose)$/,
  },
  {
    name: 'cargo',
    prefix: /^cargo\s+(build|b|test|t|check|c|clippy|run|r|doc|bench)(?=\s|$)/,
    add: [['-q', '--quiet']],
    conflicts: /^(-v+|--verbose|--message-format.*)$/,
  },
  {
    name: 'npm install',
    prefix: /^npm\s+(install|i|ci|add)(?=\s|$)/,
    add: [['--no-audit'], ['--no-fund']],
    conflicts: /^(--audit.*|--fund.*|--silent|--loglevel.*|-d+|--verbose)$/,
  },
  {
    name: 'mvn',
    prefix: /^(mvn|mvnw|\.\/mvnw|mvnw\.cmd|\.\\mvnw(\.cmd)?)(?=\s|$)/,
    add: [['-B', '--batch-mode'], ['-ntp', '--no-transfer-progress']],
    conflicts: /^(-q|--quiet|-X|--debug)$/,
  },
  {
    name: 'docker pull',
    prefix: /^docker\s+pull(?=\s|$)/,
    add: [['-q', '--quiet']],
    conflicts: /^$/,
  },
  // In Windows PowerShell, curl and wget name Invoke-WebRequest.
  {
    name: 'curl',
    prefix: /^curl(?=\s|$)/,
    add: [['-sS']],
    conflicts: /^(-[a-zA-Z]*[sv][a-zA-Z]*|-#|--silent|--verbose|--progress-bar|--trace.*)$/,
    bashOnly: true,
  },
  {
    name: 'wget',
    prefix: /^wget(?=\s|$)/,
    add: [['-nv', '--no-verbose']],
    conflicts: /^(-[a-zA-Z]*[qvd][a-zA-Z]*|--quiet|--verbose|--debug)$/,
    bashOnly: true,
  },
]

const SHELLS = new Set(['Bash', 'PowerShell'])

const REJECTED = /unknown|unrecognized|unexpected|invalid|no such option|not recognized|unknown flag/i

// Splits at top-level `&&`, `||`, `;` and newlines, outside quotes.
// Returns undefined for anything it does not fully understand.
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

// Pipes, redirects, background jobs, substitutions and heredocs: leave alone.
const PLUMBING = /[|<>&`]|\$\(/

// `2>&1` still sends everything to Claude, so it does not count as plumbing.
function unquoted(segment: string): string {
  return segment.replace(/'[^']*'|"[^"]*"/g, '""').replace(/\s2>&1(?=\s|$)/g, '')
}

export function rewrite(command: string, shell: string, off: ReadonlySet<string> = new Set()): { command: string, rules: string[] } {
  const parts = segments(command)
  if (parts === undefined) return { command, rules: [] }

  const rules: string[] = []
  const rebuilt = parts.map((part, index) => {
    if (index % 2 === 1 || PLUMBING.test(unquoted(part))) return part
    const lead = part.match(/^\s*/)?.[0] ?? ''
    const body = part.slice(lead.length)
    for (const rule of RULES) {
      if (off.has(rule.name) || (rule.bashOnly === true && shell !== 'Bash')) continue
      const hit = body.match(rule.prefix)
      if (hit === null) continue
      const tokens = unquoted(body).trim().split(/\s+/)
      if (tokens.some(t => rule.conflicts.test(t))) return part
      const flags = rule.add.filter(spellings => !spellings.some(s => tokens.includes(s))).map(s => s[0])
      if (flags.length === 0) return part
      rules.push(rule.name)
      return `${lead}${hit[0]} ${flags.join(' ')}${body.slice(hit[0].length)}`
    }
    return part
  })

  return { command: rebuilt.join(''), rules }
}

export const register: Register = on => {
  const off = new Set<string>()
  let shortened = 0

  on('tool.call', async ($, e, next) => {
    if (!SHELLS.has(e.tool) || typeof e.command !== 'string') return next(e)

    const slim = rewrite(e.command, e.tool, off)
    if (slim.rules.length === 0) return next(e)

    const ran = await next({ ...e, command: slim.command })
    if (ran.deny !== undefined) return ran

    // A tool too old for a flag says so; stop that rule so the retry runs as typed.
    if (ran.isError === true && typeof ran.text === 'string' && REJECTED.test(ran.text)) {
      const added = slim.command.split(/\s+/).filter(t => !e.command.split(/\s+/).includes(t))
      if (added.some(flag => ran.text.includes(flag))) {
        for (const rule of slim.rules) off.add(rule)
        return ran
      }
    }

    shortened += 1
    $.ui.status(`${shortened} ${shortened === 1 ? 'command' : 'commands'} quieted`)

    return ran
  })
}
