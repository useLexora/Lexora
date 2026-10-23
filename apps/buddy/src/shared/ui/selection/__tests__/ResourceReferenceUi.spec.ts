// @vitest-environment jsdom
import type { BuddyResourceQuote } from '@buddy-shared/conversation/buddyUserContent'
import type { ResourceSelectionQuote } from '../useResourceSelectionQuote'
import type { SelectionReferenceTarget } from '../workbenchSelectionReferences'
import { createBuddyUserContent } from '@buddy-shared/conversation/buddyUserContent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, provide, shallowRef } from 'vue'
import ChatInputMaterialStrip from '@/modules/tasks/widgets/materials/ChatInputMaterialStrip.vue'
import ResourceSelectionQuoteMenu from '../ResourceSelectionQuoteMenu.vue'
import { useResourceSelectionQuote } from '../useResourceSelectionQuote'
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
async function mount(kind: 'menu' | 'strip', options: { multiple?: boolean, split?: boolean } = {}) {
  const root = document.createElement('div')
  document.body.append(root)
  let selection!: ResourceSelectionQuote
  const content = shallowRef(createBuddyUserContent('Keep input'))
  const extraContent = shallowRef(createBuddyUserContent('Other input'))
  const ownerKey = shallowRef('file:one')
  const visible = shallowRef(true)
  const source = shallowRef({ identity: 'file:one', owner: 'task:a' })
  const locate = vi.fn<(quote: BuddyResourceQuote) => Promise<boolean>>(async () => false)
  const targets = shallowRef<SelectionReferenceTarget[]>([
    ...(options.multiple ? [{ id: 'b', label: 'Pane 2 · Task B', identity: 'b:draft:epoch', scope: 'task:b', read: () => extraContent.value, write: (value: typeof extraContent.value) => extraContent.value = value }] : []),
    { id: 'a', label: 'Pane 1 · Task A', identity: 'a:draft:epoch', scope: 'task:a', read: () => content.value, write: value => content.value = value },
  ])
  const host = new WorkbenchSelectionReferences({
    targets: () => targets.value,
    isSplit: () => options.split ?? !!options.multiple,
  })
  host.registerProvider('test', { captureSource: () => source.value, resolveLocate: quote => () => locate(quote) })
  const surface = defineComponent({ setup() {
    selection = useResourceSelectionQuote({ viewId: () => 'file', ownerKey: () => ownerKey.value, visible: () => visible.value, language: () => 'zh-CN' })
    return () => kind === 'menu'
      ? h(ResourceSelectionQuoteMenu, { selection, language: 'zh-CN' })
      : h(ChatInputMaterialStrip, { materials: [{ kind: 'resource_quote', id: quote.id, quote }], language: 'zh-CN', removable: false })
  } })
  const app = createApp(defineComponent({ setup() {
    provide(workbenchSelectionReferencesKey, host)
    return () => h(surface)
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
  return { root, selection, host, content, extraContent, targets, source, visible, ownerKey, locate, unmount }
}

describe('resource reference UI', () => {
  it('requires a menu choice for a context-menu gesture, even with a sole default target', async () => {
    const f = await mount('menu')
    f.selection.prepare(quote, 10, 20, 'menu')!()
    await nextTick()
    expect(f.content.value.resourceQuotes).toBeUndefined()
    expect(f.root.textContent).toBe('引用')
    f.root.querySelector('button')!.click()
    expect(f.content.value.resourceQuotes).toEqual([quote])
    expect(feedback.success).toHaveBeenCalledWith('已引用到「Pane 1 · Task A」')
  })

  it('executes an explicit quote action directly only for a sole non-split default target', async () => {
    const f = await mount('menu')
    const execute = f.selection.prepare(quote, 10, 20, 'quote')!
    f.content.value = createBuddyUserContent('Latest input')
    execute()
    execute()
    await nextTick()
    expect(f.content.value.resourceQuotes).toEqual([quote])
    expect(f.content.value.body[0]!.content).toContainEqual({ type: 'text', text: 'Latest input' })
    expect(f.root.querySelector('[role="menu"]')).toBeNull()
    expect(feedback.success).toHaveBeenCalledTimes(1)
  })

  it('keeps the associated target first and adds only to the explicitly chosen split pane', async () => {
    const f = await mount('menu', { multiple: true })
    f.selection.prepare(quote, 10, 20, 'quote')!()
    await nextTick()
    const buttons = [...f.root.querySelectorAll('button')]
    expect(buttons.map(button => button.textContent)).toEqual(['引用到「Pane 1 · Task A」', '引用到其他对话', 'Pane 2 · Task B'])
    buttons[2]!.click()
    expect(f.content.value.resourceQuotes).toBeUndefined()
    expect(f.extraContent.value.resourceQuotes).toEqual([quote])
  })

  it.each([false, true])('never substitutes the only writable target for an unavailable owner (split: %s)', async (split) => {
    const f = await mount('menu', { multiple: true, split })
    f.targets.value = f.targets.value.filter(target => target.id === 'b')
    f.selection.prepare(quote, 10, 20, 'quote')!()
    await nextTick()
    expect(f.extraContent.value.resourceQuotes).toBeUndefined()
    const buttons = [...f.root.querySelectorAll('button')]
    expect(buttons.map(button => button.textContent)).toEqual(['引用到对话', 'Pane 2 · Task B'])
    buttons[1]!.click()
    expect(f.extraContent.value.resourceQuotes).toEqual([quote])
  })

  it('names the default target when a split has only one writable pane', async () => {
    const f = await mount('menu', { split: true })
    f.selection.prepare(quote, 10, 20, 'quote')!()
    await nextTick()
    expect(f.content.value.resourceQuotes).toBeUndefined()
    expect(f.root.textContent).toBe('引用到「Pane 1 · Task A」')
  })

  it.each(['owner', 'hidden', 'source'])('rejects a prepared action after %s changes', async (change) => {
    const f = await mount('menu')
    const execute = f.selection.prepare(quote, 10, 20, 'quote')!
    if (change === 'owner') {
      f.ownerKey.value = 'file:two'
      f.ownerKey.value = 'file:one'
    }
    else if (change === 'hidden') {
      f.visible.value = false
      f.visible.value = true
    }
    else {
      f.source.value = { ...f.source.value, identity: 'file:two' }
    }
    execute()
    expect(f.content.value.resourceQuotes).toBeUndefined()
    expect(f.selection.pending.value).toBeNull()
    expect(feedback.warning).toHaveBeenCalledTimes(1)
  })

  it('rejects foreign pre-captured requests and ignores actions after disposal', async () => {
    const f = await mount('menu')
    f.selection.openRequest(f.host.capture('different-view', quote)!, 10, 20)
    expect(f.selection.pending.value).toBeNull()
    const execute = f.selection.prepare(quote, 10, 20, 'quote')!
    f.unmount()
    execute()
    expect(f.content.value.resourceQuotes).toBeUndefined()
    expect(feedback.warning).toHaveBeenCalledTimes(1)
  })

  it('shows a disabled empty state and reports invalid quote limits without writing', async () => {
    const f = await mount('menu')
    f.targets.value = []
    f.selection.prepare(quote, 10, 20, 'quote')!()
    await nextTick()
    expect(f.root.querySelector('button')!.disabled).toBe(true)
    f.selection.prepare({ ...quote, text: 'x'.repeat(100_000) }, 10, 20, 'quote')!()
    expect(f.content.value.resourceQuotes).toBeUndefined()
    expect(feedback.warning).toHaveBeenCalledTimes(1)
  })

  it('keeps a safe frozen preview in sent history when locating fails', async () => {
    const f = await mount('strip')
    expect(f.root.textContent).toContain('auth.ts · L24–38')
    expect(f.root.querySelector('pre')!.textContent).toBe(quote.text)
    expect(f.root.querySelector('script')).toBeNull()
    expect(f.root.querySelector('[aria-label="移除引用"]')).toBeNull()
    Array.from(f.root.querySelectorAll('button')).find(button => button.textContent === '定位来源')!.click()
    await nextTick()
    expect(f.locate).toHaveBeenCalledWith(quote)
    expect(f.root.textContent).toContain('来源')
    expect(f.root.querySelector('pre')!.textContent).toBe(quote.text)
  })
})
