// @vitest-environment jsdom
import type { Ref, VNode } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, onBeforeUnmount, shallowRef } from 'vue'
import BuddyChatPanelGroup from '../BuddyChatPanelGroup.vue'
import { provideChatTranscriptPresentation, provideChatTranscriptRowState, useChatTranscriptValue } from '../chatTranscriptPresentation'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

const Row = defineComponent({
  props: { rowKey: { type: String, required: true } },
  setup(props, { slots }) {
    provideChatTranscriptRowState(() => props.rowKey)
    return () => h('section', { 'data-row': props.rowKey }, slots.default?.())
  },
})

const Disclosure = defineComponent({
  props: { name: { type: String, default: 'expanded' } },
  setup(props) {
    const expanded = useChatTranscriptValue(() => props.name, false)
    return () => h('button', {
      'aria-expanded': expanded.value,
      'onClick': () => expanded.value = !expanded.value,
    }, props.name)
  },
})

function mountTranscript(content: () => VNode = () => h(Disclosure), provided = true) {
  const scope = shallowRef('conversation:branch-a')
  const rows = shallowRef(['first', 'second'])
  const visible = shallowRef(['first'])
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp({
    setup() {
      if (provided)
        provideChatTranscriptPresentation(() => scope.value, () => rows.value)
      return () => visible.value.map(id => h(Row, { key: id, rowKey: id }, content))
    },
  })
  app.mount(root)
  cleanups.push(() => {
    app.unmount()
    root.remove()
  })
  const button = (id = 'first') => root.querySelector<HTMLButtonElement>(`[data-row="${id}"] button`)!
  async function remount() {
    const current = visible.value
    visible.value = []
    await nextTick()
    expect(root.childElementCount).toBe(0)
    visible.value = current
    await nextTick()
  }
  return { root, scope, rows, visible, button, remount }
}

describe('transcript presentation lifetime', () => {
  it('restores a disclosure after its row is actually unmounted', async () => {
    const view = mountTranscript()
    view.button().click()
    await nextTick()
    expect(view.button().getAttribute('aria-expanded')).toBe('true')
    await view.remount()
    expect(view.button().getAttribute('aria-expanded')).toBe('true')
  })

  it('isolates rows and independent transcript providers', async () => {
    const first = mountTranscript()
    const second = mountTranscript()
    first.button().click()
    first.visible.value = ['first', 'second']
    await nextTick()
    expect(first.button().getAttribute('aria-expanded')).toBe('true')
    expect(first.button('second').getAttribute('aria-expanded')).toBe('false')
    expect(second.button().getAttribute('aria-expanded')).toBe('false')
  })

  it('clears mounted and offscreen state when changing branches', async () => {
    const view = mountTranscript()
    view.button().click()
    view.visible.value = ['second']
    await nextTick()
    view.button('second').click()
    view.scope.value = 'conversation:branch-b'
    await nextTick()
    expect(view.button('second').getAttribute('aria-expanded')).toBe('false')
    view.scope.value = 'conversation:branch-a'
    view.visible.value = ['first', 'second']
    await nextTick()
    expect(view.button().getAttribute('aria-expanded')).toBe('false')
    expect(view.button('second').getAttribute('aria-expanded')).toBe('false')
  })

  it('rejects late writes from an old branch even when the new branch reuses the row key', async () => {
    const values: Ref<boolean>[] = []
    const CapturedDisclosure = defineComponent({
      setup() {
        const expanded = useChatTranscriptValue('expanded', false)
        values.push(expanded)
        onBeforeUnmount(() => expanded.value = true)
        return () => h('button', {
          'aria-expanded': expanded.value,
          'onClick': () => expanded.value = !expanded.value,
        })
      },
    })
    const view = mountTranscript(() => h(CapturedDisclosure))
    view.button().click()
    await nextTick()
    const oldValue = values[0]!
    expect(oldValue.value).toBe(true)
    view.scope.value = 'conversation:branch-b'
    await view.remount()
    expect(view.button().getAttribute('aria-expanded')).toBe('false')
    oldValue.value = true
    await nextTick()
    expect(view.button().getAttribute('aria-expanded')).toBe('false')
    view.button().click()
    await nextTick()
    expect(view.button().getAttribute('aria-expanded')).toBe('true')
    expect(oldValue.value).toBe(false)
    oldValue.value = false
    await nextTick()
    expect(view.button().getAttribute('aria-expanded')).toBe('true')
  })

  it('prunes a deleted offscreen row without resetting retained rows', async () => {
    const view = mountTranscript()
    view.button().click()
    view.visible.value = ['second']
    await nextTick()
    view.button('second').click()
    view.rows.value = ['second']
    await nextTick()
    view.rows.value = ['first', 'second']
    view.visible.value = ['first', 'second']
    await nextTick()
    expect(view.button().getAttribute('aria-expanded')).toBe('false')
    expect(view.button('second').getAttribute('aria-expanded')).toBe('true')
  })

  it('tracks changing field keys without leaking the previous field state', async () => {
    const name = shallowRef('activity:first')
    const view = mountTranscript(() => h(Disclosure, { name: name.value }))
    view.button().click()
    name.value = 'activity:second'
    await nextTick()
    expect(view.button().getAttribute('aria-expanded')).toBe('false')
    name.value = 'activity:first'
    await nextTick()
    expect(view.button().getAttribute('aria-expanded')).toBe('true')
  })

  it('tracks a recycled row wrapper without reusing another row state', async () => {
    const rowKey = shallowRef('first')
    const view = mountTranscript(() => h(Row, { rowKey: rowKey.value }, () => h(Disclosure)))
    view.button().click()
    rowKey.value = 'second'
    await nextTick()
    expect(view.button('second').getAttribute('aria-expanded')).toBe('false')
    rowKey.value = 'first'
    await nextTick()
    expect(view.button().getAttribute('aria-expanded')).toBe('true')
  })

  it('preserves replacement maps and clears them on a scope change', async () => {
    const Entries = defineComponent({
      setup() {
        const entries = useChatTranscriptValue('entries', new Map<string, boolean>())
        return () => h('button', {
          onClick: () => entries.value = new Map(entries.value).set('tool', true),
        }, String(entries.value.get('tool') === true))
      },
    })
    const view = mountTranscript(() => h(Entries))
    view.button().click()
    await view.remount()
    expect(view.button().textContent).toBe('true')
    view.scope.value = 'conversation:branch-b'
    await nextTick()
    expect(view.button().textContent).toBe('false')
  })

  it('keeps standalone detail state local when no transcript provider exists', async () => {
    const view = mountTranscript(() => h(Disclosure), false)
    view.button().click()
    await nextTick()
    expect(view.button().getAttribute('aria-expanded')).toBe('true')
    await view.remount()
    expect(view.button().getAttribute('aria-expanded')).toBe('false')
  })

  it('restores the real panel group disclosure after virtual row remounting', async () => {
    const view = mountTranscript(() => h(BuddyChatPanelGroup, {
      language: 'en-US',
      group: {
        id: 'panel-group:first',
        kind: 'panel-group',
        actor: 'user',
        nodes: [
          { id: 'panel:first', kind: 'panel', actor: 'user', action: 'open', status: 'completed' },
          { id: 'panel:second', kind: 'panel', actor: 'user', action: 'close', status: 'completed' },
        ],
      },
    }))
    expect(view.button().getAttribute('aria-expanded')).toBe('false')
    view.button().click()
    await nextTick()
    expect(view.root.querySelectorAll('[data-testid="context-panel-operation"]')).toHaveLength(2)
    await view.remount()
    expect(view.button().getAttribute('aria-expanded')).toBe('true')
    expect(view.root.querySelectorAll('[data-testid="context-panel-operation"]')).toHaveLength(2)
  })
})
