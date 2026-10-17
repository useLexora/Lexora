// @vitest-environment jsdom
import type { BuddyResourceQuote } from '@buddy-shared/conversation/buddyUserContent'
import { createBuddyUserContent } from '@buddy-shared/conversation/buddyUserContent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, provide, shallowRef } from 'vue'
import ChatInputMaterialStrip from '@/modules/tasks/widgets/materials/ChatInputMaterialStrip.vue'
import ResourceSelectionQuoteMenu from '../ResourceSelectionQuoteMenu.vue'
import { WorkbenchSelectionReferences, workbenchSelectionReferencesKey } from '../workbenchSelectionReferences'

const feedback = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), info: vi.fn() }))
vi.mock('naive-ui', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    useMessage: () => feedback,
    NScrollbar: defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) }),
    NSpin: defineComponent({ setup: () => () => h('span') }),
    NIcon: defineComponent({ setup: (_, { slots }) => () => h('span', slots.default?.()) }),
    NButton: defineComponent({ setup: (_, { slots, attrs }) => () => h('button', attrs, [slots.icon?.(), slots.default?.()]) }),
    NPopover: defineComponent({ setup: (_, { slots }) => () => h('div', [slots.trigger?.(), slots.default?.()]) }),
    NDropdown: defineComponent({ props: ['show', 'options', 'menuProps', 'renderLabel'], emits: ['select'], setup: (props, { emit }) => () => props.show
      ? h('div', props.menuProps(), props.options.flatMap((option: { key: string, label: string, type?: string, disabled?: boolean, children?: { key: string, label: string }[] }) => option.type === 'divider'
          ? [h('hr')]
          : [
              h('button', { disabled: option.disabled, onClick: () => emit('select', option.key) }, props.renderLabel(option)),
              ...option.children?.map(child => h('button', { onClick: () => emit('select', child.key) }, props.renderLabel(child))) ?? [],
            ]))
      : null }),
  }
})
const quote: BuddyResourceQuote = { id: 'q', text: '<script>Do not execute</script>\nFrozen selected text', source: { kind: 'file', title: 'auth.ts', file: { spaceId: 's', directoryId: 'd', revision: 1, path: 'src/auth.ts' }, format: 'source' }, range: { startLineNumber: 24, startColumn: 1, endLineNumber: 38, endColumn: 2 } }
const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup())
})
async function mount(kind: 'menu' | 'strip', removable = true) {
  const root = document.createElement('div')
  document.body.append(root)
  let menu!: InstanceType<typeof ResourceSelectionQuoteMenu>
  const content = shallowRef(createBuddyUserContent('Keep input'))
  const ownerKey = shallowRef('file:one')
  const locate = vi.fn(async () => false)
  const remove = vi.fn()
  const host = new WorkbenchSelectionReferences({ targets: () => [{ id: 'a', label: 'Pane 1 · Task A', identity: 'a:draft:epoch', scope: 'task:a', read: () => content.value, write: value => content.value = value }], source: () => ({ identity: 'file:one', owner: 'task:a' }), locate })
  const app = createApp(defineComponent({ setup() {
    provide(workbenchSelectionReferencesKey, host)
    return () => kind === 'menu'
      ? h(ResourceSelectionQuoteMenu, { ref: value => menu = value as InstanceType<typeof ResourceSelectionQuoteMenu>, viewId: 'file', ownerKey: ownerKey.value, language: 'zh-CN', visible: true })
      : h(ChatInputMaterialStrip, { materials: [{ kind: 'resource_quote', id: quote.id, quote }], language: 'zh-CN', removable, onRemove: material => remove(material.id) })
  } }))
  app.mount(root)
  let mounted = true
  const unmount = () => {
    if (mounted) {
      mounted = false
      app.unmount()
      root.remove()
    }
  }
  cleanups.push(unmount)
  await nextTick()
  return { root, menu, host, content, ownerKey, locate, remove, unmount }
}

describe('resource reference UI', () => {
  it('adds the selected snapshot through the current-conversation action', async () => {
    const f = await mount('menu')
    f.menu.open(quote, 10, 20)
    await nextTick()
    f.root.querySelector('button')!.click()
    await nextTick()
    expect(f.content.value.resourceQuotes).toEqual([quote])
  })

  it('closes the component menu when its source switches or unmounts', async () => {
    const f = await mount('menu')
    f.menu.open(quote, 10, 20)
    await nextTick()
    f.ownerKey.value = 'file:two'
    await nextTick()
    expect(f.root.querySelector('[role="menu"]')).toBeNull()
    f.unmount()
    expect(f.content.value.resourceQuotes).toBeUndefined()
  })

  it('rejects a prepared menu operation when the source view switches', async () => {
    const f = await mount('menu')
    const show = f.menu.prepare(quote, 10, 20)!
    f.ownerKey.value = 'file:two'
    await nextTick()
    show()
    await nextTick()
    expect(f.root.querySelector('[role="menu"]')).toBeNull()
    expect(f.content.value.resourceQuotes).toBeUndefined()
    expect(feedback.warning).toHaveBeenCalled()
  })

  it('keeps a safe frozen preview when locating fails and permits removal', async () => {
    const f = await mount('strip')
    expect(f.root.textContent).toContain('auth.ts · L24–38')
    expect(f.root.querySelector('pre')!.textContent).toBe(quote.text)
    expect(f.root.querySelector('script')).toBeNull()
    f.root.querySelector<HTMLButtonElement>('[aria-label="移除引用"]')!.click()
    expect(f.remove).toHaveBeenCalledWith('q')
    Array.from(f.root.querySelectorAll('button')).find(button => button.textContent === '定位来源')!.click()
    await nextTick()
    expect(f.locate).toHaveBeenCalledWith(quote)
    expect(f.root.textContent).toContain('来源')
    expect(f.root.querySelector('pre')!.textContent).toBe(quote.text)
  })

  it('does not show removal in sent-message history', async () => {
    const f = await mount('strip', false)
    expect(f.root.querySelector('[aria-label="移除引用"]')).toBeNull()
    expect(f.root.querySelector('pre')!.textContent).toBe(quote.text)
  })
})
