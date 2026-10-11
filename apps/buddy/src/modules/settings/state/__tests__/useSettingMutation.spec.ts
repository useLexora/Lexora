import { describe, expect, it } from 'vitest'
import { useSettingMutation } from '../useSettingMutation'

describe('setting mutations', () => {
  it('prevents duplicate saves per field without blocking other fields', async () => {
    const gate = Promise.withResolvers<boolean>()
    let language = 'zh-CN'
    let notifications = false
    const mutation = useSettingMutation<'language' | 'notifications'>(async (patch) => {
      if (patch.desktop?.language) {
        await gate.promise
        language = patch.desktop.language
      }
      if (patch.desktop?.notificationsEnabled !== undefined)
        notifications = patch.desktop.notificationsEnabled
      return true
    })
    const saving = mutation.save('language', { desktop: { language: 'en-US' } })
    await expect(mutation.save('language', { desktop: { language: 'zh-CN' } })).resolves.toBe(false)
    await mutation.save('notifications', { desktop: { notificationsEnabled: true } })
    expect(language).toBe('zh-CN')
    expect(notifications).toBe(true)
    expect([...mutation.pending.value]).toEqual(['language'])
    gate.resolve(true)
    await saving
    expect(language).toBe('en-US')
    expect(mutation.pending.value.size).toBe(0)
  })

  it('retains failures independently and clears a field on retry', async () => {
    let canSave = false
    const mutation = useSettingMutation<'language' | 'notifications'>(async () => canSave)
    await mutation.save('language', { desktop: { language: 'en-US' } })
    await mutation.save('notifications', { desktop: { notificationsEnabled: true } })
    expect([...mutation.failed.value]).toEqual(['language', 'notifications'])
    canSave = true
    await mutation.save('language', { desktop: { language: 'zh-CN' } })
    expect([...mutation.failed.value]).toEqual(['notifications'])
    expect(mutation.pending.value.size).toBe(0)
  })

  it('releases pending state when an update rejects', async () => {
    const mutation = useSettingMutation<'language'>(async () => {
      throw new Error('Write failed')
    })
    await expect(mutation.save('language', { desktop: { language: 'en-US' } })).rejects.toThrow('Write failed')
    expect(mutation.pending.value.size).toBe(0)
    expect(mutation.failed.value.has('language')).toBe(true)
  })
})
