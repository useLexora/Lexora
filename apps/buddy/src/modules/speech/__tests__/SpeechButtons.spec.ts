// @vitest-environment jsdom
import type { SpeechCatalog, SpeechPreferences } from '@buddy-shared/speech/speechApi'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'

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

beforeEach(() => {
  vi.resetModules()
  request.mockReset()
})
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

async function mountButtons() {
  const [{ default: Recorder }, { default: ReadAloud }] = await Promise.all([
    import('../widgets/SpeechRecorderButton.vue'),
    import('../widgets/SpeechReadAloud.vue'),
  ])
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

it('waits for preferences, respects each switch and preserves loaded buttons on remount', async () => {
  const resolveInitial = catalogRequest()
  const first = await mountButtons()
  expect(first.visible()).toEqual({ record: false, read: false })
  await resolveInitial({ inputEnabled: false, outputEnabled: true })
  expect(first.visible()).toEqual({ record: false, read: true })
  first.unmount()

  const resolveRefresh = catalogRequest()
  const second = await mountButtons()
  expect(second.visible()).toEqual({ record: false, read: true })
  await resolveRefresh({ inputEnabled: true, outputEnabled: false })
  expect(second.visible()).toEqual({ record: true, read: false })
})

it('does not flash stale buttons when leaving settings before its refresh completes', async () => {
  const resolveInitial = catalogRequest()
  const first = await mountButtons()
  await resolveInitial({})
  expect(first.visible()).toEqual({ record: true, read: true })

  const resolveInterrupted = catalogRequest()
  for (const listener of settingsListeners)
    listener()
  first.unmount()

  const resolveCurrent = catalogRequest()
  const second = await mountButtons()
  expect(second.visible()).toEqual({ record: false, read: false })
  await resolveInterrupted({})
  expect(second.visible()).toEqual({ record: false, read: false })
  await resolveCurrent({ inputEnabled: false, outputEnabled: false })
  expect(second.visible()).toEqual({ record: false, read: false })
})
