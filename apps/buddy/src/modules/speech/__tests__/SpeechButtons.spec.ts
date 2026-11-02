// @vitest-environment jsdom
import type { SpeechCatalog, SpeechPreferences } from '@buddy-shared/speech/speechApi'
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import ReadAloud from '../widgets/SpeechReadAloud.vue'
import Recorder from '../widgets/SpeechRecorderButton.vue'

const { request, settingsListeners } = vi.hoisted(() => ({
  request: vi.fn<() => Promise<SpeechCatalog>>(),
  settingsListeners: new Set<() => void>(),
}))
vi.mock('@/platform/desktop/desktopApi', () => ({
  requireDesktopApi: () => ({
    app: { onHidden: () => () => {}, onBeforeQuit: () => () => {} },
    speech: { catalog: request, onChanged: () => () => {} },
    settings: {
      onChanged: (listener: () => void) => {
        settingsListeners.add(listener)
        return () => settingsListeners.delete(listener)
      },
    },
  }),
}))

const cleanups = new Set<() => void>()

afterEach(() => {
  for (const cleanup of cleanups)
    cleanup()
  settingsListeners.clear()
})

function catalogRequest() {
  const pending = Promise.withResolvers<SpeechCatalog>()
  request.mockReturnValue(pending.promise)
  return async (preferences: SpeechPreferences) => {
    pending.resolve({ providers: [], preferences })
    await pending.promise
    await nextTick()
  }
}

function mountButtons() {
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp({ render: () => h('div', [
    h(Recorder, { language: 'zh-CN' }),
    h(ReadAloud, { language: 'zh-CN', text: 'Hello', owner: 'message' }),
  ]) })
  const unmount = () => {
    app.unmount()
    root.remove()
    cleanups.delete(unmount)
  }
  app.mount(root)
  cleanups.add(unmount)
  const visible = () => ({
    record: root.querySelector('[data-testid="speech-record"]') !== null,
    read: root.querySelector('[data-testid="speech-read-message"]') !== null,
  })
  return { visible, unmount }
}

it('keeps speech buttons consistent across loading, remounts and interrupted settings refreshes', async () => {
  const resolveInitial = catalogRequest()
  const first = mountButtons()
  expect(first.visible()).toEqual({ record: false, read: false })
  await resolveInitial({ inputEnabled: false, outputEnabled: true })
  expect(first.visible()).toEqual({ record: false, read: true })
  first.unmount()

  const resolveRefresh = catalogRequest()
  const second = mountButtons()
  expect(second.visible()).toEqual({ record: false, read: true })
  await resolveRefresh({ inputEnabled: true, outputEnabled: false })
  expect(second.visible()).toEqual({ record: true, read: false })

  const resolveInterrupted = catalogRequest()
  for (const listener of settingsListeners)
    listener()
  second.unmount()

  const resolveCurrent = catalogRequest()
  const third = mountButtons()
  expect(third.visible()).toEqual({ record: false, read: false })
  await resolveInterrupted({})
  expect(third.visible()).toEqual({ record: false, read: false })
  await resolveCurrent({ inputEnabled: false, outputEnabled: false })
  expect(third.visible()).toEqual({ record: false, read: false })
})
