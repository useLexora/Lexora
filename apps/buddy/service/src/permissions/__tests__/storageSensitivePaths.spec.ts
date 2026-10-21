import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createBuddyServiceEnvironment } from '../../../../electron/main/runtime/buddyServiceEnvironment'
import { profileStorageProtection } from '../../../../platform/storage/ProfileLocations'
import { createSensitivePathMatcher, resolveSensitivePathRoots } from '../sensitivePaths'

it('protects retained credentials without restricting entire historical directories or inspecting old volumes', () => {
  const root = join(tmpdir(), 'lexora-sensitive-fixture')
  const home = join(root, 'home')
  const original = join(home, '.lexora')
  const activeRoot = join(root, 'volume', 'profile')
  const retained = join(root, 'volume', '.profile.retained-fixture')
  const bootstrapRoot = join(home, '.lexora-locations', 'fixture')
  const protection = profileStorageProtection({ activeRoot, defaultRoot: original, bootstrapRoot, leaseDirectory: join(home, '.lexora-locations', 'locks'), legacyRoots: [join(home, 'legacy-browser')], history: [{ id: 'fixture', kind: 'relocate', source: original, target: activeRoot, retainedTarget: retained, completedAt: '2026-01-01' }] })
  const environment = createBuddyServiceEnvironment({}, join(activeRoot, 'buddy'), undefined, undefined, protection)
  const sensitive = createSensitivePathMatcher({ home, environment })
  for (const path of [join(bootstrapRoot, 'location.json'), join(original, 'device', 'chromium', 'Cookies'), join(retained, 'buddy', 'secrets', 'credential'), join(activeRoot, 'device', 'chromium', 'Cookies'), join(activeRoot, 'storage.json'), join(home, 'legacy-browser', 'Cookies')])
    expect(sensitive.matches(path), path).toBe(true)
  expect(protection.sandboxRoots).toEqual(expect.arrayContaining([join(original, 'device'), activeRoot, join(retained, 'buddy', 'secrets'), join(home, '.lexora-locations')]))
  for (const path of [original, retained]) {
    expect(protection.sandboxRoots).not.toContain(path)
    expect(sensitive.matches(join(path, 'notes.txt'))).toBe(false)
    expect(sensitive.matches(join(path, 'buddy', 'conversations', 'task', 'workspace', 'output.txt'))).toBe(false)
  }
  expect(sensitive.matches(join(activeRoot, 'buddy', 'conversations', 'task', 'workspace', 'output.txt'))).toBe(false)
})

it('protects both the OS home and a separate tool home with an empty ambient HOME fallback', () => {
  vi.stubEnv('HOME', '')
  try {
    expect(resolveSensitivePathRoots({ environment: { HOME: '' } })).toContain(join(userInfo().homedir, '.ssh'))
    const home = join(tmpdir(), 'toolchain-home-fixture')
    const other = join(tmpdir(), 'toolchain-alternate-home')
    const cargo = join(tmpdir(), 'toolchain-cargo')
    const npmrc = join(tmpdir(), 'toolchain-npm-config')
    const matcher = createSensitivePathMatcher({ home, environment: { HOME: other, CARGO_HOME: cargo, NPM_CONFIG_USERCONFIG: npmrc } })
    for (const path of [join(home, '.ssh', 'id_ed25519'), join(other, '.netrc'), join(cargo, 'credentials.toml'), npmrc])
      expect(matcher.matches(path), path).toBe(true)
    expect(matcher.matches(join(other, '.config', 'mise', 'config.toml'))).toBe(false)
  }
  finally {
    vi.unstubAllEnvs()
  }
})

it('protects agent credentials without classifying all configuration and skills as secrets', () => {
  const home = join(tmpdir(), 'credential-matcher')
  const matcher = createSensitivePathMatcher({ home, environment: {} })
  for (const path of ['.codex/auth.json', '.claude/.credentials.json', '.pi/agent/auth.json', '.docker/config.json', '.ssh/id_ed25519', '.netrc', '_netrc'])
    expect(matcher.matches(join(home, path)), path).toBe(true)
  for (const path of ['.codex/config.toml', '.codex/skills/example/SKILL.md', '.claude/settings.json', '.pi/agent/settings.json', 'project/.env', 'project/test.pem', 'project/.netrc', 'project/_netrc'])
    expect(matcher.matches(join(home, path)), path).toBe(false)
})
