import { describe, expect, test } from 'claude-code/testing'

import { compareVersions, describeUpdates, findUpdates, pluginsDirOf } from '../hooks/register'

const installed = {
  plugins: {
    'pro-hud@claude-pro-kit': [{ version: '0.2.1' }],
    'tool-diet@claude-pro-kit': [{ version: '0.1.2' }],
    'reread-guard@claude-pro-kit': [{ version: '0.1.0' }],
    'pro-hud@other-market': [{ version: '0.0.1' }],
  },
}

const catalog = {
  plugins: [
    { name: 'pro-hud', version: '0.2.2' },
    { name: 'tool-diet', version: '0.1.2' },
    { name: 'reread-guard', version: '0.1.10' },
    { name: 'context-xray', version: '0.1.1' },
  ],
}

describe('kit-updates', () => {
  test('finds the plugins dir of an installed copy', async () => {
    expect(pluginsDirOf('C:\\Users\\me\\.claude\\plugins\\cache\\claude-pro-kit\\pro-hud\\0.2.1')).toBe(
      'C:/Users/me/.claude/plugins',
    )
    expect(pluginsDirOf('/home/me/.claude/plugins/cache/claude-pro-kit/kit-updates/0.1.0')).toBe('/home/me/.claude/plugins')
  })

  test('skips a working copy loaded with --plugin-dir', async () => {
    expect(pluginsDirOf('D:/mods/claude-pro-kit/plugins/kit-updates')).toBeUndefined()
    expect(pluginsDirOf('/home/me/.claude/plugins/cache/other-market/x/1.0.0')).toBeUndefined()
  })

  test('compares versions numerically', async () => {
    expect(compareVersions('0.1.10', '0.1.9')).toBe(1)
    expect(compareVersions('0.2.0', '0.2.0')).toBe(0)
    expect(compareVersions('0.2', '0.2.1')).toBe(-1)
  })

  test('lists only installed kit mods with a newer version', async () => {
    expect(findUpdates(installed, catalog)).toEqual([
      { name: 'pro-hud', from: '0.2.1', to: '0.2.2' },
      { name: 'reread-guard', from: '0.1.0', to: '0.1.10' },
    ])
  })

  test('finds nothing when everything is current', async () => {
    expect(findUpdates(installed, { plugins: [{ name: 'pro-hud', version: '0.2.1' }] })).toEqual([])
  })

  test('describes the updates with exact versions', async () => {
    expect(describeUpdates([{ name: 'pro-hud', from: '0.2.1', to: '0.2.2' }])).toBe(
      'claude-pro-kit: an update available (pro-hud 0.2.1 → 0.2.2). Run /kit-update.',
    )
  })
})
