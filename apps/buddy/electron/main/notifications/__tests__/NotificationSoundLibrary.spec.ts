import type { LexoraConfig, LexoraConfigPatch } from '../../../shared/desktopApi'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { describe, expect, it } from 'vitest'
import { notificationSoundPath } from '../../../../platform/storage/notificationSoundFiles'
import { DEFAULT_NOTIFICATION_SOUND_PREFERENCES, NOTIFICATION_SOUND_MAX_BYTES } from '../../../../shared/notifications/notificationSound'
import { LexoraConfigStore } from '../../config/LexoraConfigStore'
import { NotificationSoundLibrary } from '../NotificationSoundLibrary'

const metadata = { name: 'Custom sound', mimeType: 'audio/wav' as const, durationMs: 900 }
const bytes = Buffer.from([82, 73, 70, 70])
async function fixture(applyConfig: (config: LexoraConfig) => void | Promise<void> = () => {}) {
  const root = await createTemporaryDirectory('notification-sounds-')
  const home = join(root, 'buddy')
  const configPath = join(root, 'config.toml')
  const configStore = new LexoraConfigStore({ configPath })
  return { root, home, configPath, configStore, library: new NotificationSoundLibrary({ home, configStore, applyConfig }) }
}

describe('managed notification sounds', () => {
  it('migrates old settings without rewriting and persists partial updates and assets across restart', async () => {
    const f = await fixture()
    const previous = '[desktop]\nnotifications_enabled=false\nfuture=true\n'
    await writeFile(f.configPath, previous)
    expect((await f.configStore.read()).desktop.notificationSound).toEqual(DEFAULT_NOTIFICATION_SOUND_PREFERENCES)
    expect(await readFile(f.configPath, 'utf8')).toBe(previous)
    const asset = await f.library.add(bytes, metadata)
    expect((await f.configStore.read()).desktop.notificationSound).toEqual({ ...DEFAULT_NOTIFICATION_SOUND_PREFERENCES, sounds: [asset] })
    await f.configStore.update({ desktop: { notificationSound: { selected: asset.id } } })
    await f.configStore.update({ desktop: { notificationSound: { volume: 0.25 } } })
    const restarted = await new LexoraConfigStore({ configPath: f.configPath }).read()
    expect(restarted.desktop.notificationSound).toEqual({ selected: asset.id, volume: 0.25, sounds: [asset] })
    expect(restarted.desktop.notificationsEnabled).toBe(false)
    expect(await readFile(f.configPath, 'utf8')).toContain('future = true')
    expect(await f.library.read(asset.id)).toEqual(bytes)
    expect(await readdir(join(f.home, 'notification-sounds'))).toEqual([`${asset.id}.audio`])
  })

  it('serializes simultaneous library and preference writes without dropping either change', async () => {
    const f = await fixture()
    const [first, second] = await Promise.all([
      f.library.add(bytes, metadata),
      f.library.add(bytes, { ...metadata, name: 'Other' }),
      f.configStore.update({ desktop: { notificationSound: { volume: 0.4 }, language: 'en-US' } }),
    ])
    await f.configStore.update({ desktop: { notificationSound: { selected: first.id } } })
    await Promise.all([f.library.remove(first.id), f.configStore.update({ desktop: { notificationSound: { volume: 0.9 }, profile: { userName: 'Preserved' } } })])
    expect((await f.configStore.read()).desktop).toMatchObject({
      language: 'en-US',
      profile: { userName: 'Preserved' },
      notificationSound: { selected: 'system', volume: 0.9, sounds: [second] },
    })
    expect(await readdir(join(f.home, 'notification-sounds'))).toEqual([`${second.id}.audio`])
  })

  it('rejects unknown selections and asset injection even at the config store boundary', async () => {
    const f = await fixture()
    for (const notificationSound of [{ selected: randomUUID() }, { sounds: [] }, { volume: 2 }])
      await expect(f.configStore.update({ desktop: { notificationSound } } as LexoraConfigPatch)).rejects.toThrow()
    expect((await f.configStore.read()).desktop.notificationSound).toEqual(DEFAULT_NOTIFICATION_SOUND_PREFERENCES)
  })

  it('rolls back failed registration and removal without deleting registered bytes or the source file', async () => {
    let fail = true
    const f = await fixture(() => {
      if (fail)
        throw new Error('APPLY_FAILED')
    })
    await expect(f.library.add(bytes, metadata)).rejects.toThrow()
    expect((await f.configStore.read()).desktop.notificationSound.sounds).toEqual([])
    expect(await readdir(join(f.home, 'notification-sounds'))).toEqual([])
    fail = false
    const source = join(f.root, 'original.wav')
    await writeFile(source, bytes)
    const asset = await f.library.add(await readFile(source), metadata)
    await f.configStore.update({ desktop: { notificationSound: { selected: asset.id } } })
    fail = true
    await expect(f.library.remove(asset.id)).rejects.toThrow()
    expect((await f.configStore.read()).desktop.notificationSound.selected).toBe(asset.id)
    expect(await f.library.read(asset.id)).toEqual(bytes)
    fail = false
    await f.library.remove(asset.id)
    expect((await f.configStore.read()).desktop.notificationSound.selected).toBe('system')
    expect(await readFile(source)).toEqual(bytes)
    await expect(f.library.read(asset.id)).rejects.toThrow('NOTIFICATION_SOUND_NOT_FOUND')
  })

  it('bounds reads and rejects invalid metadata and path traversal', async () => {
    const f = await fixture()
    await expect(f.library.add(new Uint8Array(NOTIFICATION_SOUND_MAX_BYTES + 1), metadata)).rejects.toThrow('NOTIFICATION_SOUND_SIZE')
    await expect(f.library.add(bytes, { ...metadata, durationMs: 10_001 })).rejects.toThrow()
    await expect(f.library.read('../original.wav')).rejects.toThrow()
    await expect(f.library.remove('bell')).rejects.toThrow()
    const asset = await f.library.add(bytes, metadata)
    const handle = await open(notificationSoundPath(f.home, asset.id), 'r+')
    await handle.truncate(NOTIFICATION_SOUND_MAX_BYTES + 1)
    await handle.close()
    await expect(f.library.read(asset.id)).rejects.toThrow('NOTIFICATION_SOUND_SIZE')
  })

  it('refuses symbolic links in the managed directory', async () => {
    const f = await fixture()
    const asset = await f.library.add(bytes, metadata)
    const external = join(f.root, 'external')
    await mkdir(external)
    await writeFile(join(external, `${asset.id}.audio`), bytes)
    await rm(join(f.home, 'notification-sounds'), { recursive: true })
    await symlink(external, join(f.home, 'notification-sounds'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(f.library.read(asset.id)).rejects.toThrow('NOTIFICATION_SOUND_INVALID_DIRECTORY')
    await expect(f.library.add(bytes, metadata)).rejects.toThrow('NOTIFICATION_SOUND_INVALID_DIRECTORY')
    expect(await readFile(join(external, `${asset.id}.audio`))).toEqual(bytes)
  })

  it.skipIf(process.platform === 'win32')('refuses a linked audio file without reading its target', async () => {
    const f = await fixture()
    const asset = await f.library.add(bytes, metadata)
    const path = notificationSoundPath(f.home, asset.id)
    await rm(path)
    const source = join(f.root, 'external.wav')
    await writeFile(source, bytes)
    await symlink(source, path)
    await expect(f.library.read(asset.id)).rejects.toThrow('NOTIFICATION_SOUND_INVALID_FILE')
  })
})
