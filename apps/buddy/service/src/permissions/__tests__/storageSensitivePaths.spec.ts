import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createBuddyServiceEnvironment } from '../../../../electron/main/runtime/buddyServiceEnvironment'
import { profileStorageProtection } from '../../../../platform/storage/ProfileLocations'
import { createSensitivePathMatcher } from '../sensitivePaths'

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
