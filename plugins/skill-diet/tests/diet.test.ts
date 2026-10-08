import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { NAMES_ONLY, RECENT, parseListing, rewriteListing, shouldHide } from '../hooks/register'

const LISTING = [
  'The following skills are available for use with the Skill tool:',
  '',
  '- hyperframes: Mandatory entry point for any video request.',
  '- anthropic-skills:docs: docs (editable docs people share and comment on)',
  '- simplify: Review the changed code',
  '  for reuse and efficiency.',
  '',
].join('\n')

const project = (patch: Partial<{ sessions: number; lastUsed: Record<string, number>; firstSeen: Record<string, number> }> = {}) => ({
  sessions: 10,
  lastUsed: {},
  firstSeen: {},
  ...patch,
})
const settings = { keep: [] as string[], isOff: false }

describe('parseListing', () => {
  test('reads plugin-qualified names and descriptions over several lines', () => {
    const { head, entries, tail } = parseListing(LISTING)
    expect(head).toEqual(['The following skills are available for use with the Skill tool:', ''])
    expect(entries.map(e => e.name)).toEqual(['hyperframes', 'anthropic-skills:docs', 'simplify'])
    expect(entries[2]!.text).toBe('- simplify: Review the changed code\n  for reuse and efficiency.')
    expect(tail).toEqual([''])
  })
})

describe('shouldHide', () => {
  test('hides a skill never used or seen since the mod started', () => {
    expect(shouldHide('hyperframes', project(), settings)).toBe(true)
  })

  test(`keeps a skill used in the last ${RECENT} sessions, by full or bare name`, () => {
    expect(shouldHide('simplify', project({ lastUsed: { simplify: 6 } }), settings)).toBe(false)
    expect(shouldHide('simplify', project({ lastUsed: { simplify: 5 } }), settings)).toBe(true)
    expect(shouldHide('anthropic-skills:docs', project({ lastUsed: { docs: 9 } }), settings)).toBe(false)
  })

  test('gives a newly listed skill the same grace as a used one', () => {
    expect(shouldHide('fresh', project({ firstSeen: { fresh: 8 } }), settings)).toBe(false)
  })

  test('keeps a pinned skill, and everything when off', () => {
    expect(shouldHide('hyperframes', project(), { keep: ['hyperframes'], isOff: false })).toBe(false)
    expect(shouldHide('hyperframes', project(), { keep: [], isOff: true })).toBe(false)
  })
})

describe('rewriteListing', () => {
  test('drops hidden descriptions and lists their names on one line', () => {
    const { text, hidden } = rewriteListing(LISTING, name => name !== 'simplify')
    expect(hidden).toEqual(['hyperframes', 'anthropic-skills:docs'])
    expect(text).toBe(
      [
        'The following skills are available for use with the Skill tool:',
        '',
        '- simplify: Review the changed code',
        '  for reuse and efficiency.',
        '',
        `${NAMES_ONLY} hyperframes, anthropic-skills:docs`,
        '',
      ].join('\n'),
    )
  })

  test('leaves the listing untouched when nothing is hidden', () => {
    expect(rewriteListing(LISTING, () => false).text).toBe(LISTING)
  })
})

// An in-memory store and a stand-in for the engine's own listing.
const engine = (on: On) => {
  const store = new Map<string, unknown>()
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('command.register', () => ({ value: undefined }))
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  on('skill.prompt', ($, e) => ({ text: e.text }))
  return { store, toasts, statuses }
}

const listing = { type: 'skill_listing', text: LISTING, origin: { kind: 'engine' } } as never

describe('skill-diet', () => {
  test('lists unused skills by name only from the first session', async ($, on) => {
    const { statuses } = engine(on)
    await $.session.start({ source: 'startup', cwd: 'C:/repo' } as never)

    const { text } = await $.prompt.attachment(listing)
    expect(text).toContain(`${NAMES_ONLY} hyperframes, anthropic-skills:docs, simplify`)
    expect(text).not.toContain('Mandatory entry point')
    expect(statuses.at(-1)).toBe(`3 skills by name only, ${LISTING.length - text!.length} characters off`)
  })

  test('lists a used skill in full from the next session, in that project only', async ($, on) => {
    engine(on)
    await $.session.start({ source: 'startup', cwd: 'C:/repo' } as never)
    await $.prompt.attachment(listing)
    await $.skill.prompt({ skill: 'simplify', text: 'Review it.' } as never)

    // Same session: the listing does not change mid-session.
    expect((await $.prompt.attachment(listing)).text).not.toContain('- simplify:')

    await $.session.start({ source: 'startup', cwd: 'C:/repo' } as never)
    expect((await $.prompt.attachment(listing)).text).toContain('- simplify: Review the changed code')

    await $.session.start({ source: 'startup', cwd: 'C:/other' } as never)
    expect((await $.prompt.attachment(listing)).text).not.toContain('- simplify:')
  })

  test('a skill installed after the first session stays listed while it is new', async ($, on) => {
    engine(on)
    await $.session.start({ source: 'startup', cwd: 'C:/repo' } as never)
    await $.prompt.attachment(listing)
    await $.session.start({ source: 'startup', cwd: 'C:/repo' } as never)

    const added = { type: 'skill_listing', text: `${LISTING}- fresh: A skill just installed.\n`, origin: { kind: 'engine' } } as never
    expect((await $.prompt.attachment(added)).text).toContain('- fresh: A skill just installed.')
  })

  test('/skill-diet answers with a toast and no transcript text', async ($, on) => {
    const { toasts } = engine(on)
    await $.session.start({ source: 'startup', cwd: 'C:/repo' } as never)
    await $.prompt.attachment(listing)

    const ran = await $.command.run({ command: 'skill-diet', args: '' } as never)
    expect(ran.text).toBeUndefined()
    expect(toasts.at(-1)).toMatch(/^3 skills by name only, [\d,]+ characters off the skill listing\. anthropic-skills:docs, hyperframes, simplify$/)
  })

  test('/skill-diet keep pins a skill for later sessions', async ($, on) => {
    engine(on)
    await $.session.start({ source: 'startup', cwd: 'C:/repo' } as never)
    await $.command.run({ command: 'skill-diet', args: 'keep hyperframes' } as never)
    await $.session.start({ source: 'startup', cwd: 'C:/repo' } as never)

    expect((await $.prompt.attachment(listing)).text).toContain('- hyperframes: Mandatory entry point')
  })
})
