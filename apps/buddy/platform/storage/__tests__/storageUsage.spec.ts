import type { StorageUsageCategoryId, StorageUsageDetailId } from '../../../shared/storage/storageApi'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { expect, it } from 'vitest'
import { measureStorage } from '../storageTree'

it('classifies each file once and keeps category totals equal to their details', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lexora-usage-'))
  const fixtures: Array<[string, StorageUsageCategoryId, StorageUsageDetailId | null]> = [
    ['device/chromium/Cache/Cache_Data/data', 'cache', 'webCache'],
    ['device/chromium/Code Cache/js/data', 'cache', 'codeCache'],
    ['device/electron/GPUCache/data', 'cache', 'graphicsCache'],
    ['.runtime/cache/chromium/ShaderCache/data', 'cache', 'graphicsCache'],
    ['device/chromium/Partitions/browser/Cache/data', 'browser', 'webCache'],
    ['.runtime/cache/chromium/Partitions/browser/Code Cache/data', 'browser', 'codeCache'],
    ['device/electron/Partitions/browser/DawnWebGPUCache/data', 'browser', 'graphicsCache'],
    ['cache/data', 'cache', 'other'],
    ['device/chromium/Partitions/browser/Local Storage/data', 'browser', 'siteData'],
    ['device/chromium/IndexedDB/data', 'browser', 'siteData'],
    ['device/state/window-state.json', 'device', null],
    ['buddy/secrets/fixture', 'device', null],
    ['config.toml', 'device', null],
    ['buddy/workbench.json', 'device', null],
    ['buddy/workbench.previous.json', 'device', null],
    ['device/crashes/pending/data', 'logs', 'crashes'],
    ['device/chromium/Crashpad/data', 'logs', 'crashes'],
    ['.runtime/state/crashes/data', 'logs', 'crashes'],
    ['device/state/logs/data', 'logs', 'application'],
    ['logs/data', 'logs', 'application'],
    ['buddy/spaces/example/workspace/Cache/data', 'data', 'workspace'],
    ['buddy/conversations/example/workspace/skills/data', 'data', 'workspace'],
    ['buddy/conversations/example/artifacts/legacy.txt', 'data', 'workspace'],
    ['buddy/buddy.sqlite3', 'data', 'database'],
    ['buddy/buddy.sqlite3-wal', 'data', 'database'],
    ['buddy/buddy.sqlite3-shm', 'data', 'database'],
    ['buddy/conversations/example/session/branch/tree.jsonl', 'data', 'sessions'],
    ['buddy/conversations/example/events/run.jsonl', 'data', 'sessions'],
    ['buddy/conversations/example/inputs/message/attachment.txt', 'data', 'attachments'],
    ['buddy/conversations/example/image-inputs/image.json', 'data', 'attachments'],
    ['buddy/conversations/example/media/images/hash', 'data', 'attachments'],
    ['buddy/drafts/example/attachments/upload.txt', 'data', 'attachments'],
    ['buddy/conversations/example/changes/run/before.txt', 'data', 'changes'],
    ['buddy/unrecognized.json', 'data', 'other'],
    ['recovery/data', 'exports', 'recovery'],
    ['exports/snapshots/example/files/buddy/buddy.sqlite3', 'exports', 'snapshots'],
    ['exports/manual/data', 'exports', 'other'],
    ['buddy/extensions/packages/plugin/Cache/file', 'plugins', 'packages'],
    ['buddy/extensions/data/plugin/state.json', 'plugins', 'pluginData'],
    ['buddy/extensions/installed.json', 'plugins', 'configuration'],
    ['buddy/spaces/example/skills/fixture/SKILL.md', 'skills', null],
    ['buddy/agent/skills/fixture/SKILL.md', 'skills', null],
    ['buddy/skills/fixture/SKILL.md', 'skills', null],
  ]
  try {
    for (const [index, [file]] of fixtures.entries()) {
      await mkdir(dirname(join(root, file)), { recursive: true })
      await writeFile(join(root, file), 'x'.repeat(index))
    }
    const result = await measureStorage(root)
    expect(result.missing).toBe(0)
    for (const category of result.categories) {
      const expected = fixtures.flatMap(([, id, detail], index) => id === category.id ? [{ bytes: index, detail }] : [])
      expect(category.files).toBe(expected.length)
      expect(category.bytes).toBe(expected.reduce((sum, file) => sum + file.bytes, 0))
      for (const detail of category.details) {
        const files = expected.filter(file => file.detail === detail.id)
        expect(detail.files).toBe(files.length)
        expect(detail.bytes).toBe(files.reduce((sum, file) => sum + file.bytes, 0))
      }
      if (category.details.length) {
        expect(category.details.reduce((sum, detail) => sum + detail.bytes, 0)).toBe(category.bytes)
        expect(category.details.reduce((sum, detail) => sum + detail.files, 0)).toBe(category.files)
      }
    }
    expect(result.categories.reduce((total, item) => total + item.bytes, 0)).toBe(fixtures.length * (fixtures.length - 1) / 2)
    expect(result.categories.reduce((total, item) => total + item.files, 0)).toBe(fixtures.length)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.skipIf(process.platform === 'win32')('does not follow links into external working directories or count transient profile locks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lexora-usage-links-'))
  const root = join(directory, 'data')
  try {
    await mkdir(join(root, 'device/chromium'), { recursive: true })
    await writeFile(join(directory, 'external.txt'), 'external-file-content')
    await writeFile(join(root, 'device/chromium/SingletonLock'), 'transient')
    await symlink(join(directory, 'external.txt'), join(root, 'linked-file'))
    await symlink(directory, join(root, 'linked-directory'))
    const result = await measureStorage(root)
    expect(result.categories.reduce((sum, category) => sum + category.bytes, 0)).toBe(0)
    expect(result.categories.reduce((sum, category) => sum + category.files, 0)).toBe(2)
    expect(result.categories.find(category => category.id === 'data')?.details.find(detail => detail.id === 'other')?.files).toBe(2)
  }
  finally {
    await rm(directory, { recursive: true, force: true })
  }
})
