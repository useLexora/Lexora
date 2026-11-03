// @vitest-environment jsdom
import type { SpeechCatalog, SpeechEvent, SpeechStart } from '@buddy-shared/speech/speechApi'
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import ReadAloud from '../widgets/SpeechReadAloud.vue'

const fixture = vi.hoisted(() => ({
  listeners: new Set<(event: SpeechEvent) => void>(),
  requests: [] as SpeechStart[],
  players: [] as { loaded: PromiseWithResolvers<void>, ended: PromiseWithResolvers<void> }[],
  catalog: {
    preferences: { outputEnabled: true, output: 'model', synthesize: { id: 'test-voice' } },
    providers: [{ id: 'test-voice', title: 'Test voice', revision: '1', kind: 'speech.synthesize', streamingInput: false, streamingOutput: true, supported: true }],
  } satisfies SpeechCatalog,
}))

vi.mock('@/platform/desktop/desktopApi', () => ({
  requireDesktopApi: () => ({
    app: { onHidden: () => () => {}, onBeforeQuit: () => () => {} },
    settings: { onChanged: () => () => {} },
    speech: {
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
  const phase = () => root.querySelector('[data-speech-phase]')?.getAttribute('data-speech-phase')
  return { root, button, phase }
}

function audio(id: string) {
  for (const listener of fixture.listeners)
    listener({ id, type: 'event', sequence: 0, payload: { type: 'audio', bytes: new Uint8Array(4), sampleRate: 24000, sequence: 0, sampleFormat: 'f32le', channels: 1 } })
}
function end(id: string, status: 'completed' | 'failed') {
  for (const listener of fixture.listeners)
    listener({ id, type: 'ended', status, ...(status === 'failed' ? { error: 'SPEECH_PLAYBACK_FAILED' } : {}) })
}

it('keeps the speaker while distinguishing generation, audio loading, playback and completion', async () => {
  const { root, button, phase } = await mount()
  const speaker = () => root.querySelector('svg > path')?.getAttribute('d')
  const initialSpeaker = speaker()
  button.click()
  await nextTick()
  expect(phase()).toBe('generating')
  expect(button.getAttribute('aria-label')).toBe('正在生成语音 · 点击取消')
  expect(root.querySelector('.speech-read-aloud__spinner')).not.toBeNull()
  expect(speaker()).toBe(initialSpeaker)

  audio(fixture.requests[0]!.id)
  await nextTick()
  expect(phase()).toBe('loading')
  expect(button.getAttribute('aria-label')).toBe('正在加载音频 · 点击取消')
  fixture.players[0]!.loaded.resolve()
  await vi.waitFor(() => expect(phase()).toBe('playing'))
  expect(button.getAttribute('aria-label')).toBe('正在朗读 · 点击停止')
  expect(root.querySelector('.speech-read-aloud__waves')).not.toBeNull()
  expect(root.querySelector('.speech-read-aloud__spinner')).toBeNull()
  expect(speaker()).toBe(initialSpeaker)

  end(fixture.requests[0]!.id, 'completed')
  fixture.players[0]!.ended.resolve()
  await vi.waitFor(() => expect(phase()).toBe('idle'))
  expect(button.getAttribute('aria-label')).toBe('朗读回复')
  expect(speaker()).toBe(initialSpeaker)
})

it('cancels preparation and ignores late audio completion after starting another request', async () => {
  const { button, phase } = await mount()
  button.click()
  await nextTick()
  audio(fixture.requests[0]!.id)
  await nextTick()
  expect(phase()).toBe('loading')
  button.click()
  await nextTick()
  expect(phase()).toBe('idle')
  button.click()
  await nextTick()
  expect(phase()).toBe('generating')
  fixture.players[0]!.loaded.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
  await nextTick()
  expect(phase()).toBe('generating')
  audio(fixture.requests[1]!.id)
  fixture.players[1]!.loaded.resolve()
  await vi.waitFor(() => expect(phase()).toBe('playing'))
  button.click()
  await nextTick()
  expect(phase()).toBe('idle')
})

it('restores the speaker and allows retry after failure', async () => {
  const { root, button, phase } = await mount()
  button.click()
  await nextTick()
  end(fixture.requests[0]!.id, 'failed')
  await vi.waitFor(() => expect(phase()).toBe('idle'))
  expect(button.disabled).toBe(false)
  expect(button.getAttribute('aria-label')).toContain('朗读已中断')
  expect(root.querySelector('.speech-read-aloud__spinner')).toBeNull()
  expect(root.querySelector('svg > path')).not.toBeNull()
  button.click()
  await nextTick()
  expect(phase()).toBe('generating')
})
