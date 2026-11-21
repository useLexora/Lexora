// @vitest-environment jsdom
import type { ReaderActionInput, ReaderOutput } from '../readerProtocol'
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, shallowRef } from 'vue'
import { provideChatTranscriptPresentation, provideChatTranscriptRowState } from '../../modules/tasks/reader'
import ReaderArtifacts from '../ReaderArtifacts.vue'
import { readerTurnWindowKey } from '../readerLoadingPolicy'
import { readerLanguageKey } from '../readerStrings'

const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup())
  vi.unstubAllGlobals()
})

function mount(turnWindow = false) {
  const output = shallowRef<ReaderOutput>({ failed: false, items: [{ id: 'artifact:file', name: 'portrait.png', revision: '1', description: 'PNG · 12 KB', available: true, image: true, thumbnail: null }] })
  const visible = shallowRef(true)
  const actions: ReaderActionInput[] = []
  const row = defineComponent({
    setup() {
      provideChatTranscriptRowState(() => 'turn:run')
      return () => h(ReaderArtifacts, { runId: 'run', output: output.value, send: action => actions.push(action) })
    },
  })
  const app = createApp({
    setup() {
      provideChatTranscriptPresentation(() => 'task', () => ['turn:run'])
      return () => visible.value ? h(row) : null
    },
  })
  app.provide(readerTurnWindowKey, shallowRef(turnWindow))
  app.provide(readerLanguageKey, shallowRef('zh'))
  const root = document.createElement('div')
  document.body.append(root)
  app.mount(root)
  cleanups.push(() => {
    app.unmount()
    root.remove()
  })
  return { root, output, visible, actions }
}

it('keeps a collapsed collection closed through updates and virtual row remounts', async () => {
  const { root, output, visible } = mount()
  const heading = () => root.querySelector<HTMLButtonElement>('.artifact-heading')!
  heading().click()
  await nextTick()
  output.value = { ...output.value, items: [...output.value.items, { ...output.value.items[0]!, id: 'artifact:second', name: 'second.png' }] }
  await nextTick()
  expect(heading().textContent).toContain('2')
  expect(heading().getAttribute('aria-expanded')).toBe('false')
  visible.value = false
  await nextTick()
  visible.value = true
  await nextTick()
  expect(heading().getAttribute('aria-expanded')).toBe('false')
  heading().click()
  await nextTick()
  expect(heading().getAttribute('aria-expanded')).toBe('true')
})

it('keeps compact artifact images as actionable references until a local thumbnail is available', async () => {
  let intersect!: () => void
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: (entries: { isIntersecting: boolean }[]) => void) { intersect = () => callback([{ isIntersecting: true }]) }
    observe() {}
    disconnect() {}
  })
  const { root, output, actions } = mount(true)
  await nextTick()
  intersect()
  await nextTick()
  expect(root.textContent).toContain('portrait.png')
  expect(root.querySelector('img')).toBeNull()
  expect(actions).toEqual([])
  const thumbnail = `https://appassets.androidplatform.net/artifacts/${'a'.repeat(64)}.png`
  output.value = { failed: false, items: [{ ...output.value.items[0]!, thumbnail }] }
  await nextTick()
  expect(root.querySelector('img')?.src).toBe(thumbnail)
  root.querySelector<HTMLButtonElement>('.artifact-open')!.click()
  root.querySelector<HTMLButtonElement>('.artifact-more')!.click()
  expect(actions).toEqual([
    { action: 'artifact', runId: 'run', resourceId: 'artifact:file' },
    { action: 'artifact-actions', runId: 'run', resourceId: 'artifact:file' },
  ])
})
