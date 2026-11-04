// @vitest-environment jsdom
import type { SpeechCatalog, SpeechEvent, SpeechStart } from '@buddy-shared/speech/speechApi'
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import ReadAloud from '../widgets/SpeechReadAloud.vue'

const fixture = vi.hoisted(() => ({
  prepare: vi.fn<() => Promise<boolean>>(),
  listeners: new Set<(event: SpeechEvent) => void>(),
  requests: [] as SpeechStart[],
  players: [] as { loaded: PromiseWithResolvers<void>, ended: PromiseWithResolvers<void> }[],
  catalog: {
    preferences: { outputEnabled: true, output: 'model', synthesize: { id: 'test-voice' } },
    providers: [{ id: 'test-voice', title: 'Test voice', revision: '1', kind: 'speech.synthesize', streamingInput: false, streamingOutput: true, supported: true }],
  } as SpeechCatalog,
}))

vi.mock('@/platform/desktop/desktopApi', () => ({
  requireDesktopApi: () => ({
    app: { onHidden: () => () => {}, onBeforeQuit: () => () => {} },
    settings: { onChanged: () => () => {} },
    speech: {
      prepareSystem: fixture.prepare,
      catalog: async () => fixture.catalog,
      onChanged: () => () => {},
      onEvent: (listener: (event: SpeechEvent) => void) => {
        fixture.listeners.add(listener)
        return () => fixture.listeners.delete(listener)
      },
      start: async (request: SpeechStart) => { fixture.requests.push(request) },
      cancel: async () => {},
      acknowledge: () => {},
    },
  }),
}))

vi.mock('../audio/SpeechPlayback', () => ({
  SpeechPlayback: class {
    loaded = Promise.withResolvers<void>()
    ended = Promise.withResolvers<void>()
    constructor() { fixture.players.push(this) }
    append() { return this.loaded.promise }
    drain() { return this.ended.promise }
    stop() { this.ended.resolve() }
  },
}))

const cleanups = new Set<() => void>()
afterEach(() => {
  for (const cleanup of cleanups) cleanup()
  fixture.listeners.clear()
  fixture.requests.length = 0
  fixture.players.length = 0
  fixture.prepare.mockReset()
  fixture.catalog.preferences = { outputEnabled: true, output: 'model', synthesize: { id: 'test-voice' } }
  vi.unstubAllGlobals()
})

async function mount() {
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp({ render: () => h(ReadAloud, { language: 'zh-CN', text: 'Hello', owner: 'message' }) })
  app.mount(root)
  const cleanup = () => {
    app.unmount()
    root.remove()
    cleanups.delete(cleanup)
  }
  cleanups.add(cleanup)
  await vi.waitFor(() => expect(root.querySelector('button')).not.toBeNull())
  const button = root.querySelector('button')!
  return { button }
}

function audio(id: string) {
  for (const listener of fixture.listeners)
    listener({ id, type: 'event', sequence: 0, payload: { type: 'audio', bytes: new Uint8Array(4), sampleRate: 24000, sequence: 0, sampleFormat: 'f32le', channels: 1 } })
}
function end(id: string, status: 'completed' | 'failed') {
  for (const listener of fixture.listeners)
    listener({ id, type: 'ended', status, ...(status === 'failed' ? { error: 'SPEECH_PLAYBACK_FAILED' } : {}) })
}

it('distinguishes generation, audio loading, playback and completion', async () => {
  const { button } = await mount()
  button.click()
  await nextTick()
  expect(button.getAttribute('aria-label')).toBe('正在生成语音 · 点击取消')

  audio(fixture.requests[0]!.id)
  await nextTick()
  expect(button.getAttribute('aria-label')).toBe('正在加载音频 · 点击取消')
  fixture.players[0]!.loaded.resolve()
  await vi.waitFor(() => expect(button.getAttribute('aria-label')).toBe('正在朗读 · 点击停止'))

  end(fixture.requests[0]!.id, 'completed')
  fixture.players[0]!.ended.resolve()
  await vi.waitFor(() => expect(button.getAttribute('aria-label')).toBe('朗读回复'))
})

it('cancels preparation and ignores late audio completion after starting another request', async () => {
  const { button } = await mount()
  button.click()
  await nextTick()
  audio(fixture.requests[0]!.id)
  await nextTick()
  expect(button.getAttribute('aria-label')).toBe('正在加载音频 · 点击取消')
  button.click()
  await nextTick()
  expect(button.getAttribute('aria-label')).toBe('朗读回复')
  button.click()
  await nextTick()
  expect(button.getAttribute('aria-label')).toBe('正在生成语音 · 点击取消')
  fixture.players[0]!.loaded.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
  await nextTick()
  expect(button.getAttribute('aria-label')).toBe('正在生成语音 · 点击取消')
  audio(fixture.requests[1]!.id)
  fixture.players[1]!.loaded.resolve()
  await vi.waitFor(() => expect(button.getAttribute('aria-label')).toBe('正在朗读 · 点击停止'))
  button.click()
  await nextTick()
  expect(button.getAttribute('aria-label')).toBe('朗读回复')
})

it('reports playback failure and allows retry', async () => {
  const { button } = await mount()
  button.click()
  await nextTick()
  end(fixture.requests[0]!.id, 'failed')
  await vi.waitFor(() => expect(button.getAttribute('aria-label')).toContain('朗读已中断'))
  expect(button.disabled).toBe(false)
  button.click()
  await nextTick()
  expect(button.getAttribute('aria-label')).toBe('正在生成语音 · 点击取消')
})

it('keeps system speech lazy, ignores cancelled preparation and reports unavailable services on retry', async () => {
  fixture.catalog.preferences = { outputEnabled: true, output: 'system' }
  const pending = Promise.withResolvers<boolean>()
  fixture.prepare.mockReturnValueOnce(pending.promise).mockResolvedValue(false)
  const getVoices = vi.fn(() => {
    throw new Error('Native speech must stay untouched')
  })
  vi.stubGlobal('speechSynthesis', { getVoices })
  const { button } = await mount()
  expect(button.disabled).toBe(false)
  expect(fixture.prepare).not.toHaveBeenCalled()
  button.click()
  await nextTick()
  expect(button.getAttribute('aria-label')).toBe('正在准备语音 · 点击取消')
  button.click()
  await nextTick()
  expect(button.getAttribute('aria-label')).toBe('朗读回复')
  pending.resolve(true)
  await pending.promise
  await nextTick()
  expect(button.getAttribute('aria-label')).toBe('朗读回复')
  button.click()
  await vi.waitFor(() => expect(button.getAttribute('aria-label')).toContain('暂无系统声音'))
  expect(getVoices).not.toHaveBeenCalled()
})
