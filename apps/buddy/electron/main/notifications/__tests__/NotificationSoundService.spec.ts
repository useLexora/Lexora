import type { NotificationSoundPreferences } from '../../../../shared/notifications/notificationSound'
import type { NotificationAudioOwner } from '../NotificationAudioPlayer'
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { createBuiltinNotificationSound } from '../builtinNotificationSounds'
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
        return createBuiltinNotificationSound('bell')
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
  it('produces bounded PCM sounds with finite samples and matching WAV durations', () => {
    for (const [id, duration] of [['bell', 900], ['drop', 600]] as const) {
      const bytes = Buffer.from(createBuiltinNotificationSound(id))
      expect(bytes.toString('ascii', 0, 4)).toBe('RIFF')
      expect(bytes.toString('ascii', 8, 16)).toBe('WAVEfmt ')
      expect(bytes.readUInt32LE(40)).toBe(bytes.length - 44)
      expect((bytes.length - 44) / bytes.readUInt32LE(28) * 1000).toBe(duration)
      expect(bytes.subarray(44).some(byte => byte !== 0)).toBe(true)
      expect(bytes.readInt16LE(44)).toBe(0)
      expect(Math.abs(bytes.readInt16LE(bytes.length - 2))).toBeLessThan(5)
    }
  })

  it('coalesces concurrent notifications and preserves later eligible playback', async () => {
    const f = fixture()
    await Promise.all([f.play(), f.play(), f.play()])
    expect(f.output).toEqual([{ owner: 'notification', volume: 0.6, size: 43244 }])
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
    expect(f.output).toEqual([{ owner: 'preview', volume: 0.6, size: 28844 }])
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
    expect(f.output).toEqual([{ owner: 'preview', volume: 0.6, size: 28844 }])
  })
})
