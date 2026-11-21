// @vitest-environment jsdom
import type { ReaderActionInput, ReaderUpdate } from '../readerProtocol'
import { expect, it } from 'vitest'
import { createApp, h, nextTick, shallowRef } from 'vue'
import { readerBodyPageKey } from '../readerBodyPages'
import ReaderLiveBody from '../ReaderLiveBody.vue'
import { readerLanguageKey } from '../readerStrings'

it('holds the requested body version while newer text arrives and discards mismatched or malformed pages', async () => {
  const source = shallowRef({ id: 'live', text: 'tail', textRange: { revision: '5', start: 196, end: 200, total: 200 } })
  const result = shallowRef<ReaderUpdate['bodyPage']>()
  const actions: ReaderActionInput[] = []
  const app = createApp({ render: () => h(ReaderLiveBody, { message: source.value, send: action => actions.push(action) }) })
  app.provide(readerLanguageKey, shallowRef('en'))
  app.provide(readerBodyPageKey, result)
  const root = document.createElement('div')
  app.mount(root)
  const body = () => root.querySelector('.plain-message')!.textContent
  const click = (title: string) => [...root.querySelectorAll('button')].find(button => button.textContent?.includes(title))!.click()
  try {
    click('Read previous')
    expect(actions).toEqual([{ action: 'body-before', id: 'live', before: 196, revision: '5' }])
    source.value = { id: 'live', text: 'more', textRange: { revision: '8', start: 200, end: 204, total: 204 } }
    const valid = { id: 'live', before: 196, revision: '5', page: { range: { revision: '5', start: 192, end: 196, total: 200 }, text: 'prev' } }
    result.value = { ...valid, id: 'other' }
    await nextTick()
    expect(body()).toBe('tail')
    result.value = { ...valid, page: { ...valid.page, text: 'wrong offset' } }
    await nextTick()
    expect(root.textContent).toContain('Could not load')
    expect(body()).toBe('tail')
    click('Read previous')
    result.value = valid
    await nextTick()
    expect(body()).toBe('prev')
    click('Show latest')
    await nextTick()
    expect(body()).toBe('more')
    click('Read previous')
    result.value = { id: 'live', before: 200, revision: '8', page: { range: { revision: '8', start: 0, end: 200, total: 204 }, text: 'l'.repeat(200) } }
    await nextTick()
    const revision = `s:${'a'.repeat(64)}`
    source.value = { id: 'live', text: 'done', textRange: { revision, start: 202, end: 206, total: 206 } }
    await nextTick()
    expect(actions.at(-1)).toEqual({ action: 'body-after', id: 'live', after: 0, revision })
    expect(body()).toBe('done')
    result.value = { id: 'live', after: 0, revision, page: { range: { revision, start: 0, end: 5, total: 206 }, text: 'final' } }
    await nextTick()
    expect(body()).toBe('final')
    click('Read next section')
    expect(actions.at(-1)).toEqual({ action: 'body-after', id: 'live', after: 5, revision })
    click('Go to ending')
    await nextTick()
    expect(body()).toBe('done')
    click('Read from the start')
    expect(actions.at(-1)).toEqual({ action: 'body-after', id: 'live', after: 0, revision })
  }
  finally { app.unmount() }
})
