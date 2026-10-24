// @vitest-environment jsdom
import type { LexoraConfigPatch } from '@buddy-electron/shared/desktopApi'
import { Buffer } from 'node:buffer'
import { join } from 'node:path'
import { LexoraConfigStore } from '@buddy-electron/main/config/LexoraConfigStore'
import { WELCOME_COMPANION_IMAGE_MAX_BYTES } from '@buddy-electron/shared/welcomeCompanionImage'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { NMessageProvider } from 'naive-ui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, shallowRef } from 'vue'
import DesktopWelcomeImageSettings from '../DesktopWelcomeImageSettings.vue'

const gifBytes = Buffer.from('47494638396101000100800000000000ffffff21f904000a0000002c000000000100010000020244010021f904000a0000002c00000000010001000002024401003b', 'hex')
const gifUrl = `data:image/gif;base64,${gifBytes.toString('base64')}`
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

async function mount() {
  const directory = await createTemporaryDirectory('welcome-image-settings-')
  const store = new LexoraConfigStore({ configPath: join(directory, 'config.toml') })
  const config = shallowRef(await store.update({ desktop: { chat: { welcomeCompanionImage: 'whale' } } }))
  const disabled = shallowRef(false)
  let saveSucceeds = true
  let decodeSucceeds = true
  vi.stubGlobal('Image', class {
    src = ''
    naturalWidth = 1
    naturalHeight = 1
    async decode() {
      if (!decodeSucceeds)
        throw new Error('Invalid fixture image')
    }

    removeAttribute() {}
  })
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp(() => h(NMessageProvider, { duration: 0 }, {
    default: () => h(DesktopWelcomeImageSettings, {
      config: config.value,
      error: null,
      language: 'zh-CN',
      disabled: disabled.value,
      updateSettings: async (patch: LexoraConfigPatch) => {
        if (!saveSucceeds)
          return false
        config.value = await store.update(patch)
        return true
      },
    }),
  }))
  app.mount(root)
  cleanups.push(() => {
    app.unmount()
    root.remove()
  })
  async function select(file?: File) {
    const input = root.querySelector<HTMLInputElement>('input[type=file]')!
    Object.defineProperty(input, 'files', { configurable: true, value: file ? [file] : [] })
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()
    await vi.waitFor(() => expect(input.disabled).toBe(false))
  }
  return {
    root,
    config,
    select,
    disabled,
    setEnabled: async (enabled: boolean) => {
      config.value = await store.update({ desktop: { chat: { welcomeCompanionEnabled: enabled } } })
      await nextTick()
    },
    failSave: () => { saveSucceeds = false },
    allowSave: () => { saveSucceeds = true },
    failDecode: () => { decodeSucceeds = false },
  }
}

describe('welcome image settings', () => {
  it('keeps the saved selection on cancellation, invalid types, MIME spoofing and oversized files', async () => {
    const fixture = await mount()
    await fixture.select()
    expect(fixture.root.querySelector('[role=alert]')).toBeNull()
    expect(fixture.config.value.desktop.chat.welcomeCompanionImage).toBe('whale')
    for (const file of [
      new File(['<svg/>'], 'image.svg', { type: 'image/svg+xml' }),
      new File(['<svg/>'], 'fake.png', { type: 'image/png' }),
      new File([new Uint8Array(WELCOME_COMPANION_IMAGE_MAX_BYTES + 1)], 'large.gif', { type: 'image/gif' }),
    ]) {
      await fixture.select(file)
      expect(fixture.root.querySelector('[role=alert]')?.textContent).toBeTruthy()
      expect(fixture.config.value.desktop.chat.welcomeCompanionImage).toBe('whale')
    }
  })

  it('preserves GIF bytes, retains the previous choice after save failure and permits retry', async () => {
    const fixture = await mount()
    fixture.failSave()
    const file = new File([new Uint8Array(gifBytes)], 'animated.gif', { type: 'image/gif' })
    await fixture.select(file)
    expect(fixture.config.value.desktop.chat.welcomeCompanionImage).toBe('whale')
    fixture.allowSave()
    await fixture.select(file)
    expect(fixture.config.value.desktop.chat.welcomeCompanionImage).toBe(gifUrl)
    expect(fixture.root.textContent).toContain('自定义 1')
  })

  it('allows uploads while disabled without switching and retains the gallery after selecting a preset', async () => {
    const fixture = await mount()
    await fixture.setEnabled(false)
    const choices = () => [...fixture.root.querySelectorAll<HTMLButtonElement>('.companion-sticker-choice')]
    expect(choices().every(button => button.disabled)).toBe(true)
    await fixture.select(new File([new Uint8Array(gifBytes)], 'animated.gif', { type: 'image/gif' }))
    expect(fixture.config.value.desktop.chat).toMatchObject({
      welcomeCompanionEnabled: false,
      welcomeCompanionImage: 'whale',
      welcomeCompanionImages: [gifUrl],
    })
    choices()[2]!.click()
    await nextTick()
    expect(fixture.config.value.desktop.chat.welcomeCompanionImage).toBe('whale')
    await fixture.setEnabled(true)
    choices()[2]!.click()
    await vi.waitFor(() => expect(fixture.config.value.desktop.chat.welcomeCompanionImage).toBe(gifUrl))
    await vi.waitFor(() => expect(choices()[0]!.disabled).toBe(false))
    choices()[0]!.click()
    await vi.waitFor(() => expect(fixture.config.value.desktop.chat.welcomeCompanionImage).toBe('lexora'))
    expect(fixture.config.value.desktop.chat.welcomeCompanionImages).toEqual([gifUrl])
    fixture.disabled.value = true
    await nextTick()
    await fixture.select(new File([new Uint8Array(gifBytes)], 'same.gif', { type: 'image/gif' }))
    expect(fixture.config.value.desktop.chat).toMatchObject({ welcomeCompanionImage: 'lexora', welcomeCompanionImages: [gifUrl] })
  })

  it('rejects files that fail image decoding or cannot be read without replacing the saved image', async () => {
    const fixture = await mount()
    fixture.failDecode()
    const file = new File([new Uint8Array(gifBytes)], 'invalid.gif', { type: 'image/gif' })
    await fixture.select(file)
    expect(fixture.root.querySelector('[role=alert]')?.textContent).toContain('有效')
    expect(fixture.config.value.desktop.chat.welcomeCompanionImage).toBe('whale')
    vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (this: FileReader) {
      this.dispatchEvent(new Event('error'))
    })
    await fixture.select(file)
    expect(fixture.root.querySelector('[role=alert]')?.textContent).toContain('读取图片失败')
    expect(fixture.config.value.desktop.chat.welcomeCompanionImage).toBe('whale')
  })
})
