// @vitest-environment jsdom
import type { LexoraConfig, LexoraConfigPatch, LexoraDesktopApi } from '@buddy-electron/shared/desktopApi'
import type { NotificationSoundImportResult } from '@buddy-shared/notifications/notificationSound'
import { join } from 'node:path'
import { LexoraConfigStore } from '@buddy-electron/main/config/LexoraConfigStore'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { NMessageProvider } from 'naive-ui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, shallowRef } from 'vue'
import DesktopNotificationSoundSettings from '../DesktopNotificationSoundSettings.vue'

const desktop = vi.hoisted(() => ({ api: null as Pick<LexoraDesktopApi, 'notificationSounds'> | null }))
vi.mock('@/platform/desktop/desktopApi', () => ({ requireDesktopApi: () => desktop.api }))
const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup())
  vi.useRealTimers()
})
const customSound = { id: '437702fc-39da-47bc-a921-836d12cf22ce', name: 'Quiet morning.wav', mimeType: 'audio/wav' as const, durationMs: 2400 }

async function mount(options: { selected?: string, enabled?: boolean, legacy?: boolean } = {}) {
  const directory = await createTemporaryDirectory('notification-sound-ui-')
  const store = new LexoraConfigStore({ configPath: join(directory, 'config.toml') })
  const initial = await store.read()
  initial.desktop.notificationsEnabled = options.enabled ?? true
  initial.desktop.notificationSound = { selected: options.selected ?? 'system', volume: 0.6, sounds: [customSound] }
  if (options.legacy)
    Reflect.deleteProperty(initial.desktop, 'notificationSound')
  const config = shallowRef<LexoraConfig>(initial)
  const language = shallowRef<'zh-CN' | 'en-US'>('zh-CN')
  let succeeds = true
  const updateSettings = vi.fn(async (patch: LexoraConfigPatch) => {
    if (!succeeds)
      return false
    config.value = {
      ...config.value,
      desktop: { ...config.value.desktop, notificationSound: { ...config.value.desktop.notificationSound, ...patch.desktop?.notificationSound } },
    }
    return true
  })
  let playing: string | null = null
  const api: LexoraDesktopApi['notificationSounds'] = {
    import: vi.fn(async (): Promise<NotificationSoundImportResult> => ({ status: 'cancelled' })),
    remove: vi.fn(async (id) => {
      const current = config.value.desktop.notificationSound
      config.value = {
        ...config.value,
        desktop: {
          ...config.value.desktop,
          notificationSound: { ...current, selected: current.selected === id ? 'system' : current.selected, sounds: current.sounds.filter(sound => sound.id !== id) },
        },
      }
    }),
    preview: vi.fn(async (id) => {
      playing = id
      return { durationMs: id === 'bell' ? 900 : id === 'drop' ? 600 : customSound.durationMs }
    }),
    stopPreview: vi.fn(async () => { playing = null }),
  }
  desktop.api = { notificationSounds: api }
  const root = document.createElement('div')
  document.body.append(root)
  const visible = shallowRef(true)
  const app = createApp(() => h(NMessageProvider, { duration: 0 }, {
    default: () => visible.value ? h(DesktopNotificationSoundSettings, { config: config.value, language: language.value, error: null, updateSettings }) : null,
  }))
  app.mount(root)
  cleanups.push(() => {
    app.unmount()
    root.remove()
  })
  return {
    root,
    config,
    language,
    visible,
    api,
    updateSettings,
    playing: () => playing,
    failSave: () => { succeeds = false },
    allowSave: () => { succeeds = true },
    row: (id: string) => root.querySelector<HTMLElement>(`[data-sound-id="${id}"]`)!,
  }
}

function button(root: ParentNode, label: string) {
  const result = [...root.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label)
  expect(result, `Button ${label}`).toBeDefined()
  return result!
}
function radio(root: ParentNode) {
  return root.querySelector<HTMLInputElement>('input[type=radio]')!
}
function messages() {
  return [...document.querySelectorAll('.n-message')].map(node => node.textContent)
}
async function settle() {
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
}

async function stepVolume(root: HTMLElement) {
  const slider = root.querySelector<HTMLElement>('[role=slider]')!
  slider.focus()
  await nextTick()
  slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  await settle()
}

describe('notification sound settings', () => {
  it('defaults old preferences to system and renders localized presets without a system preview', async () => {
    const fixture = await mount({ legacy: true })
    expect(radio(fixture.row('system')).checked).toBe(true)
    expect(fixture.row('system').querySelector('button')).toBeNull()
    expect(fixture.row('bell').textContent).toContain('0.8 秒')
    expect(fixture.row('drop').textContent).toContain('1.6 秒')
    expect(fixture.row('ambient').textContent).toContain('柔和提示3.2 秒')
    expect(fixture.root.textContent).toContain('60%')
    expect(fixture.root.querySelector('[role=slider]')?.getAttribute('aria-disabled')).toBe('true')
    fixture.language.value = 'en-US'
    await nextTick()
    expect(fixture.row('system').textContent).toContain('Follow system')
    expect(fixture.row('bell').textContent).toContain('Simple')
    expect(button(fixture.root, 'Import sound')).toBeTruthy()
  })

  it('keeps saved selection and volume after failures, reports once and supports retry', async () => {
    const fixture = await mount()
    fixture.failSave()
    radio(fixture.row('bell')).click()
    await vi.waitFor(() => expect(messages()).toHaveLength(1))
    expect(radio(fixture.row('system')).checked).toBe(true)
    expect(fixture.config.value.desktop.notificationSound.selected).toBe('system')
    fixture.allowSave()
    radio(fixture.row('bell')).click()
    await vi.waitFor(() => expect(radio(fixture.row('bell')).checked).toBe(true))
    expect(fixture.config.value.desktop.notificationSound.sounds).toEqual([customSound])
    fixture.failSave()
    await stepVolume(fixture.root)
    await vi.waitFor(() => expect(messages()).toHaveLength(2))
    expect(fixture.root.querySelector('[role=slider]')?.getAttribute('aria-valuenow')).toBe('60')
    expect(fixture.config.value.desktop.notificationSound.volume).toBe(0.6)
    fixture.allowSave()
    await stepVolume(fixture.root)
    await vi.waitFor(() => expect(fixture.config.value.desktop.notificationSound.volume).toBe(0.61))
    expect(fixture.root.querySelector('[role=slider]')?.getAttribute('aria-valuenow')).toBe('61')
    expect(messages()).toHaveLength(2)
  })

  it('disables only preference edits when notifications are off and imports without selecting or playing', async () => {
    const fixture = await mount({ enabled: false, selected: 'bell' })
    expect([...fixture.root.querySelectorAll<HTMLInputElement>('input[type=radio]')].every(node => node.disabled)).toBe(true)
    expect(fixture.root.querySelector('[role=slider]')?.getAttribute('aria-disabled')).toBe('true')
    const imported = { ...customSound, id: 'aed7ef4e-e55c-45b4-9707-a74592e5b90e', name: 'New sound.mp3', mimeType: 'audio/mpeg' as const }
    vi.mocked(fixture.api.import).mockImplementationOnce(async () => {
      fixture.config.value = { ...fixture.config.value, desktop: { ...fixture.config.value.desktop, notificationSound: { ...fixture.config.value.desktop.notificationSound, sounds: [customSound, imported] } } }
      return { status: 'imported', id: imported.id }
    })
    button(fixture.root, '导入音效').click()
    await vi.waitFor(() => expect(fixture.row(imported.id).textContent).toContain(imported.name))
    expect(fixture.config.value.desktop.notificationSound.selected).toBe('bell')
    expect(fixture.playing()).toBeNull()
    expect(fixture.root.querySelector('input[type=file]')).toBeNull()
    button(fixture.row('drop'), '试听').click()
    await vi.waitFor(() => expect(fixture.playing()).toBe('drop'))
    button(fixture.row('drop'), '停止').click()
    await vi.waitFor(() => expect(fixture.playing()).toBeNull())
    button(fixture.row(imported.id), '删除').click()
    await vi.waitFor(() => expect(fixture.row(imported.id)).toBeNull())
    expect(fixture.config.value.desktop.notificationSound.selected).toBe('bell')
    fixture.config.value = { ...fixture.config.value, desktop: { ...fixture.config.value.desktop, notificationsEnabled: true } }
    await nextTick()
    expect(radio(fixture.row('bell')).checked).toBe(true)
    expect(radio(fixture.row('bell')).disabled).toBe(false)
  })

  it('leaves imports cancelled without feedback and explains all failure reasons safely', async () => {
    const fixture = await mount()
    button(fixture.root, '导入音效').click()
    await settle()
    expect(messages()).toEqual([])
    for (const reason of ['size', 'type', 'duration', 'read', 'save'] as const) {
      vi.mocked(fixture.api.import).mockResolvedValueOnce({ status: 'failed', reason })
      button(fixture.root, '导入音效').click()
      await settle()
    }
    expect(messages()).toHaveLength(5)
    expect(messages().join(' ')).toContain('5 MiB')
    expect(messages().join(' ')).toContain('10 秒')
    expect(fixture.config.value.desktop.notificationSound).toEqual({ selected: 'system', volume: 0.6, sounds: [customSound] })
  })

  it('confirms deletion of the selected sound and restores system only after a successful removal', async () => {
    const fixture = await mount({ selected: customSound.id })
    button(fixture.row(customSound.id), '删除').click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('通知音效将恢复为跟随系统'))
    expect(fixture.config.value.desktop.notificationSound.selected).toBe(customSound.id)
    button(document.querySelector('.n-popconfirm')!, '取消').click()
    await settle()
    expect(fixture.row(customSound.id)).toBeTruthy()
    button(fixture.row(customSound.id), '删除').click()
    await settle()
    button(document.querySelector('.n-popconfirm')!, '删除').click()
    await vi.waitFor(() => expect(fixture.row(customSound.id)).toBeNull())
    expect(radio(fixture.row('system')).checked).toBe(true)
  })

  it('keeps one preview, ignores superseded failures and stops on leaving without late feedback', async () => {
    const fixture = await mount()
    const late = Promise.withResolvers<{ durationMs: number }>()
    vi.mocked(fixture.api.preview).mockImplementationOnce(() => late.promise)
    button(fixture.row('bell'), '试听').click()
    await settle()
    expect(button(fixture.row('bell'), '停止')).toBeTruthy()
    button(fixture.row('drop'), '试听').click()
    await vi.waitFor(() => expect(fixture.playing()).toBe('drop'))
    late.reject(new Error('private-audio-path'))
    await settle()
    expect(fixture.playing()).toBe('drop')
    expect(messages()).toEqual([])
    expect(button(fixture.row('drop'), '停止')).toBeTruthy()
    fixture.visible.value = false
    await nextTick()
    await settle()
    expect(fixture.playing()).toBeNull()
    const imported = Promise.withResolvers<NotificationSoundImportResult>()
    fixture.visible.value = true
    await nextTick()
    vi.mocked(fixture.api.import).mockReturnValueOnce(imported.promise)
    button(fixture.root, '导入音效').click()
    fixture.visible.value = false
    await nextTick()
    imported.resolve({ status: 'failed', reason: 'read' })
    await settle()
    expect(messages()).toEqual([])
  })

  it('keeps the library after delete failure and retries without losing the selected sound', async () => {
    const fixture = await mount({ selected: 'bell' })
    vi.mocked(fixture.api.remove).mockRejectedValueOnce(new Error('private-audio-path'))
    button(fixture.row(customSound.id), '删除').click()
    await vi.waitFor(() => expect(messages()).toHaveLength(1))
    expect(messages()[0]).toContain('删除音效失败')
    expect(document.body.textContent).not.toContain('private-audio-path')
    expect(fixture.row(customSound.id)).toBeTruthy()
    expect(radio(fixture.row('bell')).checked).toBe(true)
    button(fixture.row(customSound.id), '删除').click()
    await vi.waitFor(() => expect(fixture.row(customSound.id)).toBeNull())
    expect(messages()).toHaveLength(1)
  })

  it('does not stop a new page preview or report stale save failures after leaving', async () => {
    const fixture = await mount()
    const latePreview = Promise.withResolvers<{ durationMs: number }>()
    const lateSave = Promise.withResolvers<boolean>()
    vi.mocked(fixture.api.preview).mockReturnValueOnce(latePreview.promise)
    fixture.updateSettings.mockReturnValueOnce(lateSave.promise)
    button(fixture.row('bell'), '试听').click()
    radio(fixture.row('bell')).click()
    await settle()
    fixture.visible.value = false
    await nextTick()
    await settle()
    fixture.visible.value = true
    await nextTick()
    button(fixture.row('drop'), '试听').click()
    await vi.waitFor(() => expect(fixture.playing()).toBe('drop'))
    latePreview.resolve({ durationMs: 900 })
    lateSave.resolve(false)
    await settle()
    expect(fixture.playing()).toBe('drop')
    expect(button(fixture.row('drop'), '停止')).toBeTruthy()
    expect(button(fixture.row('bell'), '试听')).toBeTruthy()
    expect(messages()).toEqual([])
    expect(radio(fixture.row('system')).checked).toBe(true)
  })

  it('clears preview state after its duration and ignores late success after stop', async () => {
    const fixture = await mount()
    vi.useFakeTimers()
    button(fixture.row('drop'), '试听').click()
    await settle()
    await vi.advanceTimersByTimeAsync(600)
    await nextTick()
    expect(button(fixture.row('drop'), '试听')).toBeTruthy()
    const late = Promise.withResolvers<{ durationMs: number }>()
    vi.mocked(fixture.api.preview).mockReturnValueOnce(late.promise)
    button(fixture.row('bell'), '试听').click()
    await settle()
    button(fixture.row('bell'), '停止').click()
    await settle()
    late.resolve({ durationMs: 900 })
    await settle()
    expect(button(fixture.row('bell'), '试听')).toBeTruthy()
    expect(fixture.playing()).toBeNull()
    expect(messages()).toEqual([])
  })
})
