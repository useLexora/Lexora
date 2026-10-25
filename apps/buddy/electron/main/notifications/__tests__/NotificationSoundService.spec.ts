import type { NotificationSoundPreferences } from '../../../../shared/notifications/notificationSound'
import type { NotificationAudioOwner } from '../NotificationAudioPlayer'
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { BUILTIN_NOTIFICATION_SOUNDS, NOTIFICATION_SOUND_MAX_BYTES } from '../../../../shared/notifications/notificationSound'
import { readBuiltinNotificationSound } from '../builtinNotificationSounds'
import { NotificationSoundService } from '../NotificationSoundService'

function fixture() {
  const state = {
    preferences: { selected: 'bell', volume: 0.6, sounds: [] } as NotificationSoundPreferences,
    time: 10_000,
    eligible: true,
    gate: Promise.resolve(),
  }
  const output: { owner: NotificationAudioOwner, volume: number, size: number }[] = []
  const service = new NotificationSoundService({
    getPreferences: () => state.preferences,
    now: () => state.time,
    library: {
      async read() {
        await state.gate
        return readBuiltinNotificationSound('bell')
      },
    },
    player: {
      async play(bytes, _mimeType, volume, owner, isCurrent) {
        await state.gate
        if (!isCurrent())
          return 0
        output.push({ owner, volume, size: bytes.byteLength })
        return 900
      },
      stop: async () => {},
      dispose() {},
    },
  })
  return { service, state, output, play: () => service.playNotification(() => state.eligible) }
}

describe('notification sound playback', () => {
  it('loads three distinct bounded WAV recordings with matching catalog durations', async () => {
    const recordings = new Set<string>()
    for (const { id, durationMs } of BUILTIN_NOTIFICATION_SOUNDS) {
      const bytes = Buffer.from(await readBuiltinNotificationSound(id))
      expect(bytes.toString('ascii', 0, 4)).toBe('RIFF')
      expect(bytes.toString('ascii', 8, 16)).toBe('WAVEfmt ')
      expect(bytes.byteLength).toBeLessThan(NOTIFICATION_SOUND_MAX_BYTES)
      expect(Math.ceil(bytes.readUInt32LE(40) / bytes.readUInt32LE(28) * 1000)).toBe(durationMs)
      recordings.add(bytes.toString('base64'))
    }
    expect(recordings.size).toBe(3)
  })

  it('lets explicit tests bypass the automatic notification cooldown', async () => {
    const f = fixture()
    await f.play()
    await f.service.playNotification(() => true, { throttle: false })
    expect(f.output).toHaveLength(2)
    await f.play()
    expect(f.output).toHaveLength(2)
  })

  it('coalesces concurrent notifications and preserves later eligible playback', async () => {
    const f = fixture()
    await Promise.all([f.play(), f.play(), f.play()])
    expect(f.output).toEqual([{ owner: 'notification', volume: 0.6, size: 235238 }])
    f.state.time += 2400
    await f.play()
    expect(f.output).toHaveLength(1)
    f.state.time += 100
    await f.play()
    expect(f.output).toHaveLength(2)
  })

  it('never starts automatic audio when the policy denies, volume is zero or system audio is selected', async () => {
    const f = fixture()
    f.state.eligible = false
    await f.play()
    f.state.eligible = true
    f.state.preferences.volume = 0
    await f.play()
    f.state.preferences.volume = 0.6
    f.state.preferences.selected = 'system'
    await f.play()
    expect(f.output).toEqual([])
    await f.service.preview('drop')
    expect(f.output).toEqual([{ owner: 'preview', volume: 0.6, size: 449384 }])
  })

  it.each(['policy', 'selection', 'settings', 'dispose'])('rejects delayed playback after %s changes', async (change) => {
    const f = fixture()
    const gate = Promise.withResolvers<void>()
    f.state.gate = gate.promise
    const playing = f.play()
    if (change === 'policy')
      f.state.eligible = false
    if (change === 'selection')
      f.state.preferences.selected = 'drop'
    if (change === 'settings')
      await f.service.settingsChanged()
    if (change === 'dispose')
      f.service.dispose()
    gate.resolve()
    await playing
    expect(f.output).toEqual([])
  })

  it('cancels an in-flight preview without silencing a newer preview', async () => {
    const f = fixture()
    const gate = Promise.withResolvers<void>()
    f.state.gate = gate.promise
    const old = f.service.preview('bell')
    await f.service.stopPreview()
    const current = f.service.preview('drop')
    gate.resolve()
    expect(await old).toEqual({ durationMs: 0 })
    expect(await current).toEqual({ durationMs: 900 })
    expect(f.output).toEqual([{ owner: 'preview', volume: 0.6, size: 449384 }])
  })
})
