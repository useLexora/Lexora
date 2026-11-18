// @vitest-environment jsdom
import type { ReaderActionInput, ReaderOutput } from '../readerProtocol'
import { afterEach, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, shallowRef } from 'vue'
import { provideChatTranscriptPresentation, provideChatTranscriptRowState } from '../../modules/tasks/reader'
import ReaderArtifacts from '../ReaderArtifacts.vue'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

function mount() {
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
  const { root, output, visible, actions } = mount()
  const heading = () => root.querySelector<HTMLButtonElement>('.artifact-heading')!
  expect(heading().textContent).toContain('产物')
  expect(heading().getAttribute('aria-expanded')).toBe('true')
  heading().click()
  await nextTick()
  expect(root.querySelector<HTMLElement>('.artifact-strip')!.style.display).toBe('none')
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
  expect(root.querySelector<HTMLElement>('.artifact-strip')!.style.display).not.toBe('none')
  expect(root.querySelectorAll('.artifact-card')).toHaveLength(2)
  expect(actions).toEqual([])
})

it('routes file opening and the separate action menu to the owning run', () => {
  const { root, actions } = mount()
  root.querySelector<HTMLButtonElement>('.artifact-open')!.click()
  root.querySelector<HTMLButtonElement>('.artifact-more')!.click()
  expect(actions).toEqual([
    { action: 'artifact', runId: 'run', resourceId: 'artifact:file' },
    { action: 'artifact-actions', runId: 'run', resourceId: 'artifact:file' },
  ])
})
