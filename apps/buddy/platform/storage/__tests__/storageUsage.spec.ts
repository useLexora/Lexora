import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { measureStorage } from '../storageTree'

it('counts browser caches separately from site data without changing the total or classifying user files by name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lexora-usage-'))
  const fixtures = [
    ['device/chromium/Cache/Cache_Data/data', 'cache'],
    ['device/chromium/Code Cache/js/data', 'cache'],
    ['device/chromium/Partitions/browser/Cache/data', 'browserCache'],
    ['device/electron/GPUCache/data', 'cache'],
    ['.runtime/cache/chromium/Partitions/browser/Code Cache/data', 'browserCache'],
    ['cache/data', 'cache'],
    ['device/chromium/Partitions/browser/Local Storage/data', 'browser'],
    ['device/chromium/IndexedDB/data', 'browser'],
    ['device/state/window-state.json', 'device'],
    ['buddy/secrets/fixture', 'device'],
    ['device/crashes/pending/data', 'logs'],
    ['device/chromium/Crashpad/data', 'logs'],
    ['logs/data', 'logs'],
    ['buddy/spaces/example/workspace/Cache/data', 'data'],
    ['recovery/data', 'recovery'],
    ['exports/data', 'exports'],
    ['config.toml', 'device'],
    ['buddy/extensions/data/plugin/state.json', 'plugins'],
    ['buddy/spaces/example/skills/fixture/SKILL.md', 'skills'],
    ['buddy/agent/skills/fixture/SKILL.md', 'skills'],
  ] as const
  try {
    for (const [file] of fixtures) {
      await mkdir(dirname(join(root, file)), { recursive: true })
      await writeFile(join(root, file), 'fixture')
    }
    const result = await measureStorage(root)
    expect(result.missing).toBe(0)
    for (const category of result.categories) {
      const files = fixtures.filter(([, id]) => id === category.id).length
      expect(category).toEqual({ id: category.id, files, bytes: files * 7 })
    }
    expect(result.categories.reduce((total, item) => total + item.bytes, 0)).toBe(fixtures.length * 7)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
