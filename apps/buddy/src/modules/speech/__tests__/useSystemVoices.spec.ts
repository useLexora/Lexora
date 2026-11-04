// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { effectScope, ref } from 'vue'
import { useSystemVoices } from '../useSystemVoices'

const { prepare } = vi.hoisted(() => ({ prepare: vi.fn<() => Promise<boolean>>() }))
vi.mock('@/platform/desktop/desktopApi', () => ({ requireDesktopApi: () => ({ speech: { prepareSystem: prepare } }) }))
const cleanups: (() => void)[] = []
const voice = { voiceURI: 'local', localService: true } as SpeechSynthesisVoice

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.restoreAllMocks()
  prepare.mockReset()
})

function fixture() {
  const events = new EventTarget()
  const synthesis = Object.assign(events, { getVoices: () => [voice] })
  const getter = vi.fn(() => synthesis)
  const descriptor = Object.getOwnPropertyDescriptor(window, 'speechSynthesis')
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, get: getter })
  cleanups.push(() => {
    if (descriptor)
      Object.defineProperty(window, 'speechSynthesis', descriptor)
    else Reflect.deleteProperty(window, 'speechSynthesis')
  })
  const consumer = (initial: boolean) => {
    const enabled = ref(initial)
    const scope = effectScope()
    const state = scope.run(() => useSystemVoices(() => enabled.value))!
    cleanups.push(() => scope.stop())
    return { enabled, ...state, stop: () => scope.stop() }
  }
  return { getter, synthesis, consumer }
}

it('does not enter native speech while inactive or when preparation fails', async () => {
  const { getter, consumer } = fixture()
  prepare.mockResolvedValue(false)
  const state = consumer(false)
  window.dispatchEvent(new Event('focus'))
  expect(state.voices.value).toEqual([])
  expect(prepare).not.toHaveBeenCalled()
  state.enabled.value = true
  await vi.waitFor(() => expect(prepare).toHaveResolvedWith(false))
  expect(state.voices.value).toEqual([])
  expect(getter).not.toHaveBeenCalled()
})

it('clears voices and detaches when disabled, then reloads when enabled', async () => {
  const { synthesis, consumer } = fixture()
  prepare.mockResolvedValue(true)
  const second = consumer(true)
  await vi.waitFor(() => expect(second.voices.value).toEqual([voice]))
  second.enabled.value = false
  synthesis.dispatchEvent(new Event('voiceschanged'))
  expect(second.voices.value).toEqual([])
  second.enabled.value = true
  await vi.waitFor(() => expect(second.voices.value).toEqual([voice]))
})

it('ignores a successful preparation after the consumer disables or unmounts', async () => {
  const { getter, consumer } = fixture()
  const pending = Promise.withResolvers<boolean>()
  prepare.mockReturnValue(pending.promise)
  const state = consumer(true)
  state.enabled.value = false
  state.stop()
  pending.resolve(true)
  await pending.promise
  await Promise.resolve()
  expect(getter).not.toHaveBeenCalled()
  expect(state.voices.value).toEqual([])
})

it('refreshes availability on focus and recovers after the service becomes ready', async () => {
  const { consumer } = fixture()
  prepare.mockResolvedValue(true)
  const state = consumer(true)
  await vi.waitFor(() => expect(state.voices.value).toEqual([voice]))
  prepare.mockResolvedValue(false)
  window.dispatchEvent(new Event('focus'))
  await vi.waitFor(() => expect(state.voices.value).toEqual([]))
  prepare.mockResolvedValue(true)
  window.dispatchEvent(new Event('focus'))
  await vi.waitFor(() => expect(state.voices.value).toEqual([voice]))
})
