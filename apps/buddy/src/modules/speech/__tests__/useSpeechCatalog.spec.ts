import type { SpeechCatalog } from '@buddy-shared/speech/speechApi'
import { expect, it, vi } from 'vitest'
import { effectScope } from 'vue'

const catalog: SpeechCatalog = { providers: [], preferences: { inputEnabled: false } }
vi.mock('@/platform/desktop/desktopApi', () => ({
  requireDesktopApi: () => ({
    speech: { catalog: async () => catalog, onChanged: () => () => {} },
    settings: { onChanged: () => () => {} },
  }),
}))

it('keeps the last catalog when the last consumer unmounts and a new one mounts', async () => {
  vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} })
  const { useSpeechCatalog } = await import('../useSpeechCatalog')
  const first = effectScope()
  const before = first.run(() => useSpeechCatalog())!
  expect(before.loaded.value).toBe(false)
  await vi.waitFor(() => expect(before.loaded.value).toBe(true))
  first.stop()

  const second = effectScope()
  const after = second.run(() => useSpeechCatalog())!
  expect(after.loaded.value).toBe(true)
  expect(after.catalog.value.preferences.inputEnabled).toBe(false)
  second.stop()
})
