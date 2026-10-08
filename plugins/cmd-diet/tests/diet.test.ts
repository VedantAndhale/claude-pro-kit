import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { rewrite } from '../hooks/register.ts'

// The engine's side: a shell that records the command it was given, and fails
// with the text the test sets.
const engine = (on: On) => {
  const shell = { ran: [] as string[], error: undefined as string | undefined }
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    shell.ran.push(String(e.command))
    return shell.error !== undefined
      ? { isError: true as const, result: shell.error, text: shell.error }
      : { result: { stdout: 'ok' } as never }
  })
  return shell
}

const bash = (command: string) => ({ tool: 'Bash' as const, command })
const slim = (command: string, shell = 'Bash') => rewrite(command, shell).command

describe('cmd-diet rewrites', () => {
  test('adds quiet flags right after the command', () => {
    expect(slim('git status')).toBe('git status --short --branch')
    expect(slim('python -m pytest tests/ -x')).toBe('python -m pytest -q tests/ -x')
    expect(slim('cargo test -- --nocapture')).toBe('cargo test -q -- --nocapture')
    expect(slim('npm install lodash')).toBe('npm install --no-audit --no-fund lodash')
    expect(slim('mvn -B package')).toBe('mvn -ntp -B package')
    expect(slim('curl https://example.com')).toBe('curl -sS https://example.com')
    expect(slim('docker pull node:20')).toBe('docker pull -q node:20')
  })

  test('rewrites each step of a chain', () => {
    expect(slim('cd app && npm ci && pytest')).toBe('cd app && npm ci --no-audit --no-fund && pytest -q')
    expect(slim('cargo build 2>&1')).toBe('cargo build -q 2>&1')
  })

  test('leaves piped, redirected and substituted commands alone', () => {
    for (const command of ['git status | grep foo', 'pytest > out.txt', 'echo $(git status)', 'cargo build &']) {
      expect(slim(command)).toBe(command)
    }
  })

  test('leaves a chosen output level alone', () => {
    for (const command of ['git status --porcelain', 'pytest -vv', 'cargo build --verbose', 'curl -fsSL https://x', 'npm install --silent']) {
      expect(slim(command)).toBe(command)
    }
  })

  test('does not add a flag that is already there', () => {
    expect(slim('git status -s')).toBe('git status --branch -s')
    expect(slim('pytest -q')).toBe('pytest -q')
  })

  test('leaves curl and wget alone in PowerShell', () => {
    expect(slim('curl https://example.com', 'PowerShell')).toBe('curl https://example.com')
    expect(slim('git status', 'PowerShell')).toBe('git status --short --branch')
  })

  test('ignores operators inside quotes and unclosed quotes', () => {
    expect(slim('git commit -m "a && b"')).toBe('git commit -m "a && b"')
    expect(slim('pytest -k "a or b"')).toBe('pytest -q -k "a or b"')
    expect(slim('pytest "unclosed')).toBe('pytest "unclosed')
  })
})

describe('cmd-diet hook', () => {
  test('runs the quiet form', async ($, on) => {
    const shell = engine(on)
    await $.tool.call(bash('git status'))

    expect(shell.ran).toEqual(['git status --short --branch'])
  })

  test('a failing run keeps the rule on', async ($, on) => {
    const shell = engine(on)
    shell.error = '1 failed, 2 passed'
    await $.tool.call(bash('pytest'))
    await $.tool.call(bash('pytest'))

    expect(shell.ran).toEqual(['pytest -q', 'pytest -q'])
  })

  test('a rejected flag stops that rule, so the retry runs as typed', async ($, on) => {
    const shell = engine(on)
    shell.error = "error: unknown option '-ntp'"
    await $.tool.call(bash('mvn package'))
    shell.error = undefined
    await $.tool.call(bash('mvn package'))
    await $.tool.call(bash('git status'))

    expect(shell.ran).toEqual(['mvn -B -ntp package', 'mvn package', 'git status --short --branch'])
  })
})
